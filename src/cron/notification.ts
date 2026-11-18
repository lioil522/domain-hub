/**
 * Webhook / Telegram 通知模块
 *
 * NOTE: 支持按 WEBHOOK_TYPE 构造对应平台的规范 payload，
 * 刻意不抛异常 —— 作为定时任务收尾步骤，推送失败不应中断主流程。
 */

export type WebhookType = "dingtalk" | "feishu" | "wecom" | "serverchan" | "custom";
import { providerFetch } from "../providers/provider-fetch";

export interface WebhookSendResult {
  ok: boolean;
  status?: number;
  detail?: string;
  code?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  uncertain?: boolean;
}
const RESPONSE_LIMIT = 64 * 1024;
const safeDetail = (text: string, secrets: string[]) => {
  let value = text.replace(/https?:\/\/[^\s"<>]+/gi, "[redacted URL]");
  for (const secret of secrets.filter(Boolean)) value = value.split(secret).join("[redacted]");
  return value.slice(0, 300);
};
async function readBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > RESPONSE_LIMIT) throw new Error("notification_response_too_large");
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
const retryAfter = (response: Response, parsed?: Record<string, unknown>) => {
  const header = response.headers.get("Retry-After") || "";
  const seconds = /^\d+(\.\d+)?$/.test(header) ? Number(header) : Math.max(0, (Date.parse(header) - Date.now()) / 1000);
  const parameters = parsed?.parameters;
  const platform = parameters && typeof parameters === "object" && "retry_after" in parameters ? Number(parameters.retry_after) : 0;
  return Math.min(86400000, Math.max(Number.isFinite(seconds) ? seconds * 1000 : 0, Number.isFinite(platform) ? platform * 1000 : 0));
};
function objectJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function httpFailure(response: Response, parsed: Record<string, unknown> | null): WebhookSendResult {
  return { ok: false, status: response.status, code: `http_${response.status}`, detail: `通知服务返回 HTTP ${response.status}`,
    retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    retryAfterMs: retryAfter(response, parsed || undefined), uncertain: response.status === 408 || response.status >= 500 };
}

/**
 * 把 Server酱 的 SendKey 补全成推送端点
 */
export function normalizeServerChanEndpoint(input: string): string {
  const v = input.trim();
  if (!v) return v;
  if (/^https?:\/\//i.test(v)) return v;
  const sc3 = v.match(/^sctp(\d+)t/i);
  if (sc3) return `https://${sc3[1]}.push.ft07.com/send/${v}.send`;
  return `https://sctapi.ftqq.com/${v}.send`;
}

/**
 * 推送 Webhook 通知
 */
export async function sendWebhookNotification(
  webhookUrl: string,
  message: string,
  webhookType: WebhookType = "custom",
  signal?: AbortSignal,
  idempotencyKey?: string
): Promise<WebhookSendResult> {
  if (!webhookUrl) return { ok: false, detail: "未配置 Webhook 地址", retryable: false, code: "missing_webhook" };
  if (!["custom", "dingtalk", "feishu", "wecom", "serverchan"].includes(webhookType)) {
    return { ok: false, detail: "不支持的 Webhook 类型", retryable: false, code: "invalid_webhook_type" };
  }
  const endpoint = webhookType === "serverchan" ? normalizeServerChanEndpoint(webhookUrl) : webhookUrl;
  try {
    let payload: Record<string, unknown>;

    switch (webhookType) {
      case "dingtalk":
        payload = { msgtype: "text", text: { content: message } };
        break;
      case "feishu":
        payload = { msg_type: "text", content: { text: message } };
        break;
      case "wecom":
        payload = { msgtype: "text", text: { content: message } };
        break;
      case "serverchan":
        payload = {
          title: (message.split("\n")[0] || "DNSHE 通知").slice(0, 32),
          desp: message,
        };
        break;
      case "custom":
      default:
        payload = { text: message, content: message };
        break;
    }

    const res = await providerFetch(endpoint, {
      method: "POST",
      // Workers supports manual/follow; do not follow redirects with a secret URL/body.
      redirect: "manual",
      headers: { "Content-Type": "application/json",
        ...(webhookType === "custom" && idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
      body: JSON.stringify(payload),
    }, signal, 10000);
    const parsed = objectJson(await readBody(res));
    if (!res.ok) return httpFailure(res, parsed);
    // Only custom endpoints explicitly use the HTTP-2xx acceptance contract.
    if (webhookType === "custom") return { ok: true, status: res.status, detail: "Webhook 已返回 HTTP 2xx" };
    const codes = webhookType === "dingtalk" || webhookType === "wecom" ? [parsed?.errcode]
      : webhookType === "feishu" ? [parsed?.code ?? parsed?.StatusCode, ...(parsed?.code !== undefined && parsed?.StatusCode !== undefined ? [parsed.StatusCode] : [])]
      : [parsed?.code ?? parsed?.errno, ...(parsed?.data && typeof parsed.data === "object" && "errno" in parsed.data ? [parsed.data.errno] : [])];
    if (!parsed || codes.some(code => typeof code !== "number")) {
      return { ok: false, status: res.status, code: "invalid_platform_ack", detail: "通知平台未返回可验证的成功 JSON",
        retryable: true, uncertain: true };
    }
    if (codes.some(code => code !== 0)) {
      return { ok: false, status: res.status, code: "platform_rejected", detail: "通知平台明确返回失败",
        retryable: true, retryAfterMs: retryAfter(res, parsed) };
    }
    return { ok: true, status: res.status, detail: "通知平台已确认接收" };
  } catch (e) {
    return { ok: false, code: "transport_or_body_failed", retryable: true, uncertain: true,
      detail: `无法连接 Webhook：${safeDetail(e instanceof Error ? e.message : "请求异常", [webhookUrl, endpoint])}` };
  }
}

/**
 * 推送 Telegram 通知
 */
export async function sendTelegramNotification(
  botToken: string,
  chatId: string,
  message: string,
  signal?: AbortSignal
): Promise<WebhookSendResult> {
  if (!botToken || !chatId) return { ok: false, detail: "未配置 Telegram Bot Token 或 Chat ID", retryable: false, code: "missing_telegram" };

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await providerFetch(url, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
    }, signal, 10000);
    const parsed = objectJson(await readBody(res));
    if (!res.ok) return httpFailure(res, parsed);
    if (parsed?.ok === false) {
      const errorCode = Number(parsed.error_code);
      return { ok: false, status: res.status, code: Number.isSafeInteger(errorCode) ? `telegram_${errorCode}` : "telegram_rejected",
        detail: `Telegram API ${Number.isSafeInteger(errorCode) ? errorCode : "拒绝"}：${safeDetail(String(parsed.description || "返回失败"), [botToken, chatId])}`,
        retryable: ![400, 401, 403, 404].includes(errorCode), retryAfterMs: retryAfter(res, parsed) };
    }
    const result = parsed?.result;
    if (parsed?.ok !== true || !result || typeof result !== "object" || !("message_id" in result) ||
      typeof result.message_id !== "number" || !Number.isSafeInteger(result.message_id) || result.message_id <= 0) {
      return { ok: false, status: res.status, code: "invalid_telegram_ack", detail: "Telegram 未返回有效成功确认",
        retryable: true, uncertain: true };
    }
    return { ok: true, status: res.status, detail: "Telegram 已确认接收" };
  } catch (e) {
    return { ok: false, code: "transport_or_body_failed", retryable: true, uncertain: true,
      detail: `无法连接 Telegram API：${safeDetail(e instanceof Error ? e.message : "请求异常", [botToken, chatId])}` };
  }
}
