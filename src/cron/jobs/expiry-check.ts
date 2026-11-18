import type { DatabaseManager } from "../../db";
import { isRegistrableDomain } from "../../punycode";
import { sha256Hex } from "../../db/crypto";
import { ConflictError } from "../../errors";
import { NotificationOutbox, NOTIFICATION_LEASE_MS, notificationTargetId, type NotificationEvent } from "../../db/dao/notification-dao";
import { notificationTargets, type NotificationOptions } from "../../services/notification-service";

// Leave room for the sync slice + one delivery in the shared Worker invocation.
export const EXPIRY_SCAN_BATCH = 25;
interface ScanState { scan_day: string; target_set: string; last_kind: string; last_id: number; lease_token: string }
interface Candidate {
  kind: string; id: number; account_id: number; full_domain: string; expires_at: string | null;
  alias: string; account_name: string | null;
}
/**
 * Durable, bounded daily scan. Enqueue and cursor advancement share one atomic
 * transaction. "completed" means scan complete, NEVER notification delivered.
 */
export async function runExpiryReminderSlice(db: DatabaseManager, options: NotificationOptions & {
  outbox?: NotificationOutbox; now?: () => number; config?: Record<string, string>;
} = {}): Promise<number> {
  if (options.signal?.aborted) return 0;
  const config = options.config || await db.getAllAppSettings();
  const targets = notificationTargets(config, options);
  if (!targets.length) return 0; // Enabling notifications later today must still scan.
  const clock = options.now || Date.now, now = clock(), day = new Date(now).toISOString().slice(0, 10);
  const targetSet = await sha256Hex(JSON.stringify((await Promise.all(targets.map(notificationTargetId))).sort()));
  const outbox = options.outbox || db.notificationOutbox();
  const token = crypto.randomUUID();
  const state = await outbox.statement(`INSERT INTO notification_scans(id,scan_day,target_set,lease_token,lease_until,updated_at)
    VALUES('expiry',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      last_kind=CASE WHEN notification_scans.scan_day<>excluded.scan_day OR notification_scans.target_set<>excluded.target_set THEN '' ELSE notification_scans.last_kind END,
      last_id=CASE WHEN notification_scans.scan_day<>excluded.scan_day OR notification_scans.target_set<>excluded.target_set THEN 0 ELSE notification_scans.last_id END,
      scan_day=excluded.scan_day,target_set=excluded.target_set,completed=0,lease_token=excluded.lease_token,
      lease_until=excluded.lease_until,updated_at=excluded.updated_at
    WHERE notification_scans.lease_until<=? AND
      (notification_scans.scan_day<>excluded.scan_day OR notification_scans.target_set<>excluded.target_set OR notification_scans.completed=0)
    RETURNING *`, [day, targetSet, token, now + NOTIFICATION_LEASE_MS, now, now]).first<ScanState>();
  if (!state) return 0;
  try {
    const candidates = await db.allRaw<Candidate>(`WITH candidates AS (
      SELECT a.provider kind,d.id,d.account_id,d.full_domain,a.alias,NULL account_name,
        CASE WHEN a.provider='cloudflare' THEN (SELECT o.expires_at FROM domain_date_overrides o
          WHERE o.account_id=d.account_id AND lower(o.full_domain)=lower(d.full_domain)
          ORDER BY o.updated_at DESC,o.id DESC LIMIT 1) ELSE d.expires_at END expires_at
        FROM domains_cache d JOIN accounts a ON a.id=d.account_id WHERE a.provider IN ('cloudflare','digitalplat')
      UNION ALL
      SELECT 'custom',d.id,d.group_id,d.full_domain,g.alias,a.name,d.expires_at
        FROM custom_domains d JOIN accounts g ON g.id=d.group_id LEFT JOIN custom_accounts a ON a.id=d.account_id)
      SELECT * FROM candidates WHERE kind>? OR (kind=? AND id>?) ORDER BY kind,id LIMIT ?`,
      [state.last_kind, state.last_kind, state.last_id, EXPIRY_SCAN_BATCH + 1]);
    const batch = candidates.slice(0, EXPIRY_SCAN_BATCH);
    const rdap = await db.getRdapExpiryCacheBatch([...new Set(batch.filter(row => row.kind === "cloudflare" &&
      isRegistrableDomain(row.full_domain.toLowerCase())).map(row => row.full_domain.toLowerCase()))]);
    const threshold = Math.max(1, Number(config.renew_threshold_days) || 90);
    const events: NotificationEvent[] = [];
    for (const row of batch) {
      const manual = row.expires_at && !row.expires_at.startsWith("0000") ? row.expires_at : "";
      const expiry = manual || (row.kind === "cloudflare" ? rdap.get(row.full_domain.toLowerCase()) : "");
      const time = Date.parse(expiry || "");
      if (!Number.isFinite(time) || expiry?.startsWith("0000")) continue;
      const days = (time - now) / 86400000;
      if (days > threshold) continue;
      const provider = row.kind === "cloudflare" ? "Cloudflare" : row.kind === "digitalplat" ? "DigitalPlat" : "自定义分组";
      const suffix = days < 0 ? `已过期 ${Math.ceil(-days)} 天` : `将于 ${Math.ceil(days)} 天后到期`;
      const source = row.kind === "cloudflare" ? `（到期来源：${manual ? "手动录入" : "RDAP"}）` : "";
      events.push({
        key: `expiry:${day}:${await sha256Hex(JSON.stringify([row.kind, row.account_id, row.full_domain.toLowerCase()]))}`,
        message: `【域名到期提醒】\n⚠️ 域名 [${row.full_domain}]（${provider} / ${row.alias}${row.account_name ? ` / ${row.account_name}` : ""}）${suffix}，请前往对应服务商处理。${source}`,
        deadlineAt: now + 2 * 86400000,
      });
    }
    if (options.signal?.aborted) throw new Error("到期检查已中断");
    const fence = () => ({ sql: "EXISTS(SELECT 1 FROM notification_scans WHERE id='expiry' AND lease_token=? AND lease_until>?)",
      bindings: [token, clock()] });
    const last = batch.at(-1), complete = candidates.length <= EXPIRY_SCAN_BATCH;
    const results = await outbox.commit([
      ...await outbox.prepare(events, targets, fence),
      outbox.statement(`UPDATE notification_scans SET last_kind=?,last_id=?,completed=?,lease_until=0,updated_at=?
        WHERE id='expiry' AND lease_token=? AND lease_until>?`,
        [last?.kind || state.last_kind, last?.id || state.last_id, complete ? 1 : 0, clock(), token, clock()]),
    ]);
    if (results.at(-1)?.meta.changes !== 1) throw new ConflictError("到期扫描租约失效，未推进检查点");
    if (events.length) await db.writeLog("info", "renew", `到期检查已持久化 ${events.length} 条提醒事件（通道独立去重与投递），本轮检查 ${batch.length} 条`);
    return batch.length;
  } catch (error) {
    await outbox.statement("UPDATE notification_scans SET lease_until=0 WHERE id='expiry' AND lease_token=?", [token]).run();
    throw error;
  }
}
