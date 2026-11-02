import { buildDomainUpsert } from "./domain-dao";
import type { UpstreamSubdomain } from "../types";

export interface SyncCandidate { id: number; updated_at: string | null }
export const SYNC_LEASE_SECONDS = 120;

/** Strict coordination storage: errors must propagate, unlike best-effort data cache. */
export async function acquireSyncLease(db: D1Database, key: string, token: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.prepare(`INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
    WHERE cache.expires_at <= ?`).bind(key, token, now + SYNC_LEASE_SECONDS, now).run();
  return result.meta.changes === 1;
}

export async function commitSyncPage(
  db: D1Database, accountId: number, domains: UpstreamSubdomain[],
  leaseKey: string, token: string, cursorKey: string, cursorValue: string,
  ttl: number, deletions: SyncCandidate[] = []
): Promise<void> {
  const guard = { key: leaseKey, token };
  const now = Math.floor(Date.now() / 1000);
  const statements = [
    db.prepare("UPDATE cache SET expires_at = ? WHERE key = ? AND value = ? AND expires_at > ?")
      .bind(now + SYNC_LEASE_SECONDS, leaseKey, token, now),
    ...domains.map(sub => buildDomainUpsert(db, accountId, sub, guard)),
    ...deletions.map(candidate => db.prepare(`DELETE FROM domains_cache
      WHERE account_id = ? AND id = ? AND updated_at IS ?
      AND EXISTS (SELECT 1 FROM cache WHERE key = ? AND value = ? AND expires_at > CAST(strftime('%s', 'now') AS INTEGER))`)
      .bind(accountId, candidate.id, candidate.updated_at, leaseKey, token)),
    db.prepare(`INSERT INTO cache (key, value, expires_at)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM cache WHERE key = ? AND value = ? AND expires_at > CAST(strftime('%s', 'now') AS INTEGER))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`)
      .bind(cursorKey, cursorValue, Math.floor(Date.now() / 1000) + ttl, leaseKey, token),
  ];
  // D1 batch is atomic. If another runner took an expired lease, every guarded write is a no-op.
  const results = await db.batch(statements);
  if (results[0].meta.changes !== 1) throw new Error("同步锁已失效，请重新同步");
}
