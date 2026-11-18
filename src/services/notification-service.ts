import type { DatabaseManager } from "../db";
import { NotificationOutbox, validateNotificationTarget, type NotificationTarget } from "../db/dao/notification-dao";
import { sendTelegramNotification, sendWebhookNotification, type WebhookType, type WebhookSendResult } from "../cron/notification";

export interface NotificationOptions { webhookUrl?: string; webhookType?: WebhookType; signal?: AbortSignal }
export function notificationTargets(config: Record<string, string>, options: NotificationOptions = {}): NotificationTarget[] {
  const targets: NotificationTarget[] = [];
  const url = config.webhook_url || options.webhookUrl;
  if (url) targets.push({ channel: "webhook", url, type: (config.webhook_type as WebhookType) || options.webhookType || "custom" });
  if (config.tg_token && config.tg_chat_id) targets.push({ channel: "telegram", token: config.tg_token, chatId: config.tg_chat_id });
  targets.forEach(validateNotificationTarget);
  return targets;
}
/** One network delivery per invocation. Empty/failed outboxes never block sync progress. */
export async function runOneNotificationDelivery(db: DatabaseManager, options: { outbox?: NotificationOutbox; signal?: AbortSignal } = {}) {
  if (options.signal?.aborted) return null;
  const outbox = options.outbox || db.notificationOutbox();
  await outbox.recover();
  if (options.signal?.aborted) return null;
  const work = await outbox.claim();
  if (!work) return null;
  let result: WebhookSendResult = { ok: false, code: "encrypted_snapshot_unavailable", retryable: false };
  let snapshot: { target: NotificationTarget; message: string } | undefined;
  try {
    snapshot = await outbox.decode(work);
  } catch {
    // Never expose decrypted destinations, tokens, or platform-echoed payloads.
    result = { ok: false, code: "encrypted_snapshot_unavailable", detail: "通知快照无法解密或验证，请恢复原 AES_KEY 后显式重试", retryable: false };
  }
  if (snapshot) {
    const { target, message } = snapshot;
    if (!await outbox.isActive(work)) return work.id;
    if (options.signal?.aborted) result = { ok: false, code: "executor_cancelled", retryable: true };
    else result = target.channel === "webhook"
      ? await sendWebhookNotification(target.url, message, target.type, options.signal, work.id)
      : await sendTelegramNotification(target.token, target.chatId, message, options.signal);
  }
  if (await outbox.finish(work, result)) {
    await db.writeLog(result.ok ? "success" : "warning", "system",
      `通知 ${work.id.slice(0, 12)}（${work.channel}）${result.ok ? "投递成功" : "投递失败，已记录重试/死信状态"}`,
      { code: result.code || null, attempt: work.attempts, uncertain: result.uncertain === true });
  }
  return work.id;
}
