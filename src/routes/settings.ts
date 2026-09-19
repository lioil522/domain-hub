import type { Hono } from "hono";
import type { AppEnv } from "./types";
import { successRes, errorRes } from "./response";
import type { WebhookType } from "../cron";

interface SettingsDeps {
  sendTelegramNotification: (botToken: string, chatId: string, message: string) => Promise<void>;
  sendWebhookNotification: (url: string, message: string, type: WebhookType) => Promise<{ ok: boolean; status?: number; detail?: string }>;
}

function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

export function registerSettingsRoutes(app: Hono<AppEnv>, deps: SettingsDeps) {
  app.get("/api/settings", async (c) => {
    const db = c.get("db");
    try {
      const cfg = await db.getAllAppSettings();
      const masked = { ...cfg };
      if (masked.tg_token) masked.tg_token = maskSecret(cfg.tg_token);
      if (masked.webhook_url) masked.webhook_url = maskSecret(cfg.webhook_url);
      return c.json(successRes({
        settings: masked,
        configured: { tg_token: !!cfg.tg_token, webhook_url: !!cfg.webhook_url },
      }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 500);
    }
  });

  app.post("/api/settings", async (c) => {
    const db = c.get("db");
    try {
      const body = await c.req.json().catch(() => ({}));
      const allowedKeys = [
        "webhook_url", "webhook_type", "tg_token", "tg_chat_id",
        "renew_threshold_days", "auto_renew", "dns_records_cache_mode",
      ];
      const sensitiveKeys = ["tg_token", "webhook_url"];
      for (const key of allowedKeys) {
        if (!(key in body)) continue;
        let value = String(body[key] ?? "");
        if (key === "dns_records_cache_mode") value = value === "always" ? "always" : "scheduled";
        if (sensitiveKeys.includes(key) && (value === "" || value.startsWith("****"))) continue;
        await db.setAppSetting(key, value);
      }
      await db.writeLog("success", "operation", "管理员更新了系统设置配置");
      return c.json(successRes({ message: "设置已保存" }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 400);
    }
  });

  app.post("/api/settings/test-telegram", async (c) => {
    const db = c.get("db");
    try {
      const body = await c.req.json().catch(() => ({}));
      const cfg = await db.getAllAppSettings();
      const token = body.tg_token && !String(body.tg_token).startsWith("****") ? String(body.tg_token) : cfg.tg_token;
      const chatId = String(body.tg_chat_id || cfg.tg_chat_id || "");
      if (!token || !chatId) return c.json(errorRes("请先填写 Telegram Bot Token 与 Chat ID", "bad_request"), 400);
      await deps.sendTelegramNotification(token, chatId, "🎉 Domain Hub 测试推送：Telegram 通知配置成功！");
      return c.json(successRes({ message: "测试消息已发送，请检查 Telegram" }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 400);
    }
  });

  app.post("/api/settings/test-webhook", async (c) => {
    const db = c.get("db");
    try {
      const body = await c.req.json().catch(() => ({}));
      const cfg = await db.getAllAppSettings();
      const url = body.webhook_url && !String(body.webhook_url).startsWith("****") ? String(body.webhook_url).trim() : String(cfg.webhook_url || "");
      const type = String(body.webhook_type || cfg.webhook_type || "custom") as WebhookType;
      if (!url) return c.json(errorRes(type === "serverchan" ? "请先填写 SendKey" : "请先填写 Webhook 地址", "bad_request"), 400);
      if (type !== "serverchan" && !/^https?:\/\//i.test(url)) return c.json(errorRes("Webhook 地址必须以 http:// 或 https:// 开头", "bad_request"), 400);
      const result = await deps.sendWebhookNotification(url, "🎉 Domain Hub 测试推送：Webhook 通知配置成功！", type);
      if (!result.ok) {
        let detail = result.detail || `推送失败（HTTP ${result.status ?? "?"}）`;
        if (type === "serverchan" && /^https?:\/\//i.test(url) && !/\.send(\?|$)/i.test(url)) {
          detail = `这个地址不像 Server酱 的推送端点（应以 .send 结尾）。直接把 SendKey 填进来即可，不要填控制台的「快速创建入口链接」。原始返回：${detail}`;
        }
        return c.json(errorRes(detail), 400);
      }
      return c.json(successRes({ message: "测试消息已发送，请检查对应的群/服务" }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 400);
    }
  });
}
