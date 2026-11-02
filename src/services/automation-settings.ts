import type { DatabaseManager } from "../db";
import { AppError } from "../errors";

export function configuredInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max) throw new AppError("自动任务设置无效，请检查整数范围", 400, "automation_settings_invalid");
  return n;
}
export async function automationSettings(db: DatabaseManager) {
  const cfg = await db.getAuthoritativeAppSettings();
  return { ...cfg, auto_renew: cfg.auto_renew, tg_token: cfg.tg_token, tg_chat_id: cfg.tg_chat_id, webhook_url: cfg.webhook_url, webhook_type: cfg.webhook_type,
    login_sync_enabled: cfg.login_sync_enabled === "true" ? "true" : "false",
    freshness: configuredInteger(cfg.sync_freshness_seconds, 3600, 60, 86400),
    reminderDays: configuredInteger(cfg.renew_threshold_days, 90, 1, 3650),
    renewalDays: configuredInteger(cfg.dnshe_renew_window_days, 0, 0, 365) };
}
