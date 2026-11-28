import { decryptText, encryptText, sha256Hex } from "../crypto";
import { ConflictError, ValidationError, NotFoundError } from "../../errors";
import { normalizeServerChanEndpoint, type WebhookType, type WebhookSendResult } from "../../cron/notification";

export const NOTIFICATION_LEASE_MS = 90000;
export const NOTIFICATION_MAX_ATTEMPTS = 6;
export const NOTIFICATION_TTL_MS = 3 * 86400000;
export const NOTIFICATION_RETENTION_MS = 30 * 86400000;
export type NotificationTarget =
  | { channel: "webhook"; url: string; type: WebhookType }
  | { channel: "telegram"; token: string; chatId: string };
export interface NotificationEvent { key: string; message: string; deadlineAt?: number }
export interface NotificationWork {
  id: string; event_key: string; channel: string; target_id: string; payload_cipher: string;
  status: string; attempts: number; uncertain: number; lease_token: string | null; lease_until: number;
  not_before: number; deadline_at: number; last_error: string | null; created_at: number; updated_at: number; sent_at: number | null;
}
export interface NotificationFence { sql: string; bindings: unknown[] }
function isNotificationTarget(value: unknown): value is NotificationTarget {
  if (!value || typeof value !== "object" || !("channel" in value)) return false;
  if (value.channel === "webhook") return "url" in value && typeof value.url === "string" &&
    "type" in value && typeof value.type === "string";
  return value.channel === "telegram" && "token" in value && typeof value.token === "string" &&
    "chatId" in value && typeof value.chatId === "string";
}
export function validateNotificationTarget(target: NotificationTarget): void {
  if (target.channel === "webhook") {
    if (!["custom", "dingtalk", "feishu", "wecom", "serverchan"].includes(target.type)) throw new ValidationError("不支持的 Webhook 类型");
    let url: URL;
    try { url = new URL(target.type === "serverchan" ? normalizeServerChanEndpoint(target.url) : target.url); }
    catch { throw new ValidationError("通知 Webhook 地址无效"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || target.url.length > 4096) {
      throw new ValidationError("通知 Webhook 地址无效");
    }
  } else if (target.channel !== "telegram" || !target.token || !target.chatId || target.token.length > 512 ||
      target.chatId.length > 256 || /[\r\n]/.test(target.token + target.chatId)) throw new ValidationError("Telegram 通知目标无效");
}
export const notificationTargetId = (target: NotificationTarget) => sha256Hex(JSON.stringify(target));

/** Per-channel encrypted delivery snapshots; all state changes are SQL CAS/fenced. */
export class NotificationOutbox {
  constructor(private readonly db: D1Database, private readonly aesKey?: string, private readonly now = Date.now) {}
  statement(sql: string, bindings: unknown[] = []) { return this.db.prepare(sql).bind(...bindings); }

  async prepare(events: NotificationEvent[], targets: NotificationTarget[], fence?: NotificationFence | (() => NotificationFence)): Promise<D1PreparedStatement[]> {
    const writes = await this.prepareWrites(events, targets);
    return writes(typeof fence === "function" ? fence() : fence);
  }
  /** Encrypt first; bind a producer's lease only when assembling its checkpoint. */
  async prepareWrites(events: NotificationEvent[], targets: NotificationTarget[]): Promise<(fence?: NotificationFence) => D1PreparedStatement[]> {
    if (!events.length || !targets.length) return () => [];
    if (events.length > 100 || targets.length > 2) throw new ValidationError("通知入队超出切片预算");
    targets.forEach(validateNotificationTarget);
    const ids = await Promise.all(targets.map(notificationTargetId));
    const rows: { id: string; event: string; channel: string; target: string; cipher: string; deadline: number }[] = [];
    const now = this.now();
    for (const event of events) {
      if (!event.key || event.key.length > 256 || !event.message || new TextEncoder().encode(event.message).byteLength > 16384) {
        throw new ValidationError("通知事件身份或正文超出预算");
      }
      const deadline = Math.min(event.deadlineAt ?? now + NOTIFICATION_TTL_MS, now + NOTIFICATION_TTL_MS);
      if (!Number.isSafeInteger(deadline) || deadline <= now) throw new ValidationError("通知事件已经过期");
      for (let index = 0; index < targets.length; index++) {
        const target = targets[index], targetId = ids[index];
        // Byte-bounded chunks support Telegram/WeCom limits, including CJK/emoji.
        const chunks: string[] = [];
        let chunk = "", size = 0;
        for (const character of event.message) {
          const bytes = new TextEncoder().encode(character).byteLength;
          if (size + bytes > 1500) { chunks.push(chunk); chunk = ""; size = 0; }
          chunk += character; size += bytes;
        }
        if (chunk) chunks.push(chunk);
        for (let part = 0; part < chunks.length; part++) {
          const id = await sha256Hex(JSON.stringify([event.key, targetId, part]));
          rows.push({ id, event: event.key, channel: target.channel, target: targetId, deadline,
            cipher: await encryptText(JSON.stringify({ id, target, message: chunks.length > 1 ? `(${part + 1}/${chunks.length})\n${chunks[part]}` : chunks[part] }), this.aesKey) });
        }
      }
    }
    // Limit JSON parameters and statement count, even for multi-part events.
    const chunks: string[] = [];
    for (let offset = 0; offset < rows.length; offset += 10) {
      chunks.push(JSON.stringify(rows.slice(offset, offset + 10)));
    }
    if (chunks.length > 30) throw new ValidationError("通知分片过多，请缩小生产批次");
    return fence => chunks.map(chunk => this.statement(`INSERT INTO notification_outbox
        (id,event_key,channel,target_id,payload_cipher,status,not_before,deadline_at,created_at,updated_at)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.event'),json_extract(value,'$.channel'),
          json_extract(value,'$.target'),json_extract(value,'$.cipher'),'queued',?,json_extract(value,'$.deadline'),?,?
        FROM json_each(?) WHERE ${fence?.sql || "1=1"} ON CONFLICT(id) DO NOTHING`,
        [now, now, now, chunk, ...(fence?.bindings || [])]));
  }
  async enqueue(events: NotificationEvent[], targets: NotificationTarget[], additional: D1PreparedStatement[] = [], fence?: NotificationFence) {
    const statements = [...additional, ...await this.prepare(events, targets, fence)];
    await this.commit(statements);
  }
  async commit(statements: D1PreparedStatement[]) {
    if (!statements.length) return [];
    const results = await this.db.batch(statements);
    if (results.some(result => !result.success)) throw new Error("通知持久化失败");
    return results;
  }
  async decode(work: NotificationWork): Promise<{ target: NotificationTarget; message: string }> {
    if (work.payload_cipher.startsWith("plain:")) throw new Error("Outbox payload cannot be plain text");
    const payload: unknown = JSON.parse(await decryptText(work.payload_cipher, this.aesKey));
    if (!payload || typeof payload !== "object" || !("id" in payload) || payload.id !== work.id ||
      !("message" in payload) || typeof payload.message !== "string" || !payload.message ||
      new TextEncoder().encode(payload.message).byteLength > 1600 || !("target" in payload) ||
      !isNotificationTarget(payload.target)) throw new Error("Invalid notification snapshot");
    validateNotificationTarget(payload.target);
    if (payload.target.channel !== work.channel || await notificationTargetId(payload.target) !== work.target_id) throw new Error("Notification target identity mismatch");
    return { target: payload.target, message: payload.message };
  }
  async recover() {
    const now = this.now();
    await this.db.batch([
      this.statement(`UPDATE notification_outbox SET status=CASE WHEN attempts>=? OR deadline_at<=? THEN 'dead' ELSE 'queued' END,
        uncertain=1,lease_token=NULL,lease_until=0,not_before=?,updated_at=?,last_error='lease_expired_delivery_unknown'
        WHERE status='running' AND lease_until<=?`, [NOTIFICATION_MAX_ATTEMPTS, now, now + 60000, now, now]),
      this.statement(`UPDATE notification_outbox SET status='dead',updated_at=?,last_error='delivery_deadline_exceeded'
        WHERE status='queued' AND (deadline_at<=? OR attempts>=?)`, [now, now, NOTIFICATION_MAX_ATTEMPTS]),
    ]);
    const cleanup = await this.statement(`INSERT INTO cache(key,value,expires_at) VALUES('notification_cleanup','1',?)
      ON CONFLICT(key) DO UPDATE SET expires_at=excluded.expires_at WHERE cache.expires_at<=? RETURNING key`,
      [Math.floor(now / 1000) + 3600, Math.floor(now / 1000)]).first();
    if (cleanup) await this.statement(`DELETE FROM notification_outbox WHERE id IN
      (SELECT id FROM notification_outbox WHERE status IN ('sent','dead','cancelled') AND updated_at<? LIMIT 200)`,
      [now - NOTIFICATION_RETENTION_MS]).run();
  }
  async claim(): Promise<NotificationWork | null> {
    const now = this.now();
    return this.statement(`UPDATE notification_outbox SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=?
      WHERE id=(SELECT id FROM notification_outbox WHERE status='queued' AND not_before<=? AND deadline_at>?
        AND attempts<? ORDER BY created_at,id LIMIT 1) AND status='queued' RETURNING *`,
      [crypto.randomUUID(), now + NOTIFICATION_LEASE_MS, now, now, now, NOTIFICATION_MAX_ATTEMPTS]).first<NotificationWork>();
  }
  async isActive(work: NotificationWork): Promise<boolean> {
    return !!await this.statement(`SELECT id FROM notification_outbox
      WHERE id=? AND status='running' AND lease_token=? AND lease_until>?`,
      [work.id, work.lease_token, this.now()]).first();
  }
  async finish(work: NotificationWork, result: WebhookSendResult): Promise<boolean> {
    const now = this.now(), delay = Math.min(86400000, Math.max(60000 * 2 ** Math.max(0, work.attempts - 1), result.retryAfterMs || 0));
    const dead = result.retryable === false || work.attempts >= NOTIFICATION_MAX_ATTEMPTS || now + delay >= work.deadline_at;
    const updated = await this.statement(`UPDATE notification_outbox SET status=?,lease_token=NULL,lease_until=0,
      not_before=?,updated_at=?,sent_at=?,last_error=?,uncertain=MAX(uncertain,?)
      WHERE id=? AND status='running' AND lease_token=? AND lease_until>? RETURNING id`,
      [result.ok ? "sent" : dead ? "dead" : "queued", now + delay, now, result.ok ? now : null,
        result.ok ? null : (result.code || "delivery_failed").replace(/[^a-z0-9_]/gi, "").slice(0, 80),
        result.uncertain ? 1 : 0, work.id, work.lease_token, now]).first();
    return !!updated;
  }
  async list(status?: string, limit = 50) {
    return (await this.statement(`SELECT id,event_key,channel,target_id,status,attempts,uncertain,not_before,deadline_at,
      last_error,created_at,updated_at,sent_at FROM notification_outbox ${status ? "WHERE status=?" : ""}
      ORDER BY updated_at DESC,id LIMIT ?`, status ? [status, limit] : [limit]).all()).results;
  }
  async counts() {
    return (await this.statement("SELECT status,COUNT(*) count FROM notification_outbox GROUP BY status").all<{ status: string; count: number }>()).results;
  }
  async control(id: string, operation: "retry" | "cancel", acknowledgeDuplicateRisk = false) {
    const row = await this.statement("SELECT status,uncertain FROM notification_outbox WHERE id=?", [id]).first<{ status: string; uncertain: number }>();
    if (!row) throw new NotFoundError("通知不存在");
    if (operation === "retry" && (row.status !== "dead" || row.uncertain && !acknowledgeDuplicateRisk)) {
      throw new ConflictError(row.uncertain ? "投递结果不确定，重试可能重复，请显式确认重复风险" : "仅死信通知可重试");
    }
    if (operation === "cancel" && !["queued", "running", "dead"].includes(row.status)) throw new ConflictError("通知已结束，不能取消");
    const now = this.now();
    const updated = await this.statement(`UPDATE notification_outbox SET status=?,lease_token=NULL,lease_until=0,updated_at=?,
      attempts=CASE WHEN ?='queued' THEN 0 ELSE attempts END,not_before=?,
      deadline_at=CASE WHEN ?='queued' THEN ? ELSE deadline_at END,last_error=NULL,
      uncertain=CASE WHEN status='running' THEN 1 ELSE uncertain END WHERE id=? AND status=? RETURNING id`,
      [operation === "retry" ? "queued" : "cancelled", now, operation === "retry" ? "queued" : "cancelled",
        now, operation === "retry" ? "queued" : "cancelled", now + NOTIFICATION_TTL_MS, id, row.status]).first();
    if (!updated) throw new ConflictError("通知状态已改变，请刷新");
  }
}
