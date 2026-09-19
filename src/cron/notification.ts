/**
 * Webhook / Telegram 通知模块
 *
 * NOTE: 支持按 WEBHOOK_TYPE 构造对应平台的规范 payload，
 * 刻意不抛异常 —— 作为定时任务收尾步骤，推送失败不应中断主流程。
 */

export type WebhookType = "dingtalk" | "feishu" | "wecom" | "serverchan" | "custom";

export interface WebhookSendResult {
  ok: boolean;
  status?: number;
  detail?: string;
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
  webhookType: WebhookType = "custom"
): Promise<WebhookSendResult> {
  if (!webhookUrl) return { ok: false, detail: "未配置 Webhook 地址" };
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

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const bodyText = (await res.text().catch(() => "")).slice(0, 500);

    if (!res.ok) {
      console.error(`Webhook push failed with status: ${res.status}`);
      return { ok: false, status: res.status, detail: bodyText || `HTTP ${res.status}` };
    }

    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      const code = parsed.errcode ?? parsed.code;
      if (code !== undefined && Number(code) !== 0) {
        const reason = String(parsed.errmsg ?? parsed.msg ?? parsed.message ?? bodyText);
        console.error(`Webhook rejected by platform: ${code} ${reason}`);
        return { ok: false, status: res.status, detail: `平台返回错误 ${code}：${reason}` };
      }
    } catch {
      // 通用 Webhook 往往回非 JSON，HTTP 2xx 视为成功
    }

    return { ok: true, status: res.status, detail: bodyText };
  } catch (e) {
    console.error("Failed to send Webhook notification:", e);
    return { ok: false, detail: e instanceof Error ? e.message : "请求异常" };
  }
}

/**
 * 推送 Telegram 通知
 */
export async function sendTelegramNotification(botToken: string, chatId: string, message: string): Promise<void> {
  if (!botToken || !chatId) return;
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error(`Telegram push failed with status: ${res.status}`);
    }
  } catch (e) {
    console.error("Failed to send Telegram notification:", e);
  }
}
