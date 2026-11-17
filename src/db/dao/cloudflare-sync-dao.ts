import type { UpstreamSubdomain } from "../types";
import { buildDomainJsonUpsert } from "./domain-dao";
import { ConflictError } from "../../errors";

const LEASE_SECONDS = 60;
const CYCLE_TTL_SECONDS = 3 * 24 * 3600;

export interface CloudflareSyncLease {
  generation: string;
  token: string;
  nextPage: number;
  totalSynced: number;
  fingerprint?: string;
}

/** Claim one account, retaining its durable checkpoint unless the cycle expired. */
export async function claimCloudflareSync(db: D1Database, accountId: number, fingerprint?: string): Promise<CloudflareSyncLease> {
  const now = Math.floor(Date.now() / 1000);
  const token = crypto.randomUUID();
  const row = await db.prepare(`
    INSERT INTO cf_sync_state (account_id, generation, next_page, total_synced, lease_token, lease_until, updated_at,credential_fingerprint)
    VALUES (?, ?, 1, 0, ?, ?, ?,?)
    ON CONFLICT(account_id) DO UPDATE SET
      generation=CASE WHEN cf_sync_state.updated_at <= ? OR credential_fingerprint IS NOT excluded.credential_fingerprint THEN excluded.generation ELSE cf_sync_state.generation END,
      next_page=CASE WHEN cf_sync_state.updated_at <= ? OR credential_fingerprint IS NOT excluded.credential_fingerprint THEN 1 ELSE cf_sync_state.next_page END,
      total_synced=CASE WHEN cf_sync_state.updated_at <= ? OR credential_fingerprint IS NOT excluded.credential_fingerprint THEN 0 ELSE cf_sync_state.total_synced END,
      lease_token=excluded.lease_token, lease_until=excluded.lease_until, updated_at=excluded.updated_at,credential_fingerprint=excluded.credential_fingerprint
    WHERE cf_sync_state.lease_until <= ? OR credential_fingerprint IS NOT excluded.credential_fingerprint
    RETURNING generation, next_page, total_synced
   `).bind(accountId, crypto.randomUUID(), token, now + LEASE_SECONDS, now, fingerprint || null,
    now - CYCLE_TTL_SECONDS, now - CYCLE_TTL_SECONDS, now - CYCLE_TTL_SECONDS, now)
    .first<{ generation: string; next_page: number; total_synced: number }>();
  if (!row) throw new ConflictError("该 Cloudflare 账号正在同步，请稍后重试", "sync_in_progress");
  const lease: CloudflareSyncLease = { generation: row.generation, token, nextPage: row.next_page, totalSynced: row.total_synced, fingerprint };
  try {
    // Snapshot deletion candidates only at the start. Concurrently created rows are not candidates.
    await db.batch([
      db.prepare(`DELETE FROM cf_sync_seen WHERE account_id=? AND generation<>? AND
        EXISTS (SELECT 1 FROM cf_sync_state WHERE account_id=? AND lease_token=?)`)
        .bind(accountId, lease.generation, accountId, token),
      db.prepare(`INSERT INTO cf_sync_seen (account_id, generation, domain_id, seen)
        SELECT ?, ?, id, 0 FROM domains_cache WHERE account_id=? AND
          EXISTS (SELECT 1 FROM cf_sync_state WHERE account_id=? AND lease_token=? AND next_page=1)
        ON CONFLICT(account_id, generation, domain_id) DO NOTHING`)
        .bind(accountId, lease.generation, accountId, accountId, token),
    ]);
    return lease;
  } catch (error) {
    await releaseCloudflareSync(db, accountId, lease);
    throw error;
  }
}

/** Fence every statement, and commit the page, seen IDs and checkpoint in one transaction. */
export async function commitCloudflareSyncPage(
  db: D1Database,
  accountId: number,
  lease: CloudflareSyncLease,
  domains: UpstreamSubdomain[],
  page: { hasMore: boolean; nextPage: number },
  extraGuard?: { sql: string; bindings: unknown[] },
): Promise<void> {
  if (page.hasMore && (!Number.isSafeInteger(page.nextPage) || page.nextPage <= lease.nextPage)) {
    throw new Error("Cloudflare 分页游标未前进，已停止同步");
  }
  const now = Math.floor(Date.now() / 1000);
  const guard = {
    sql: `EXISTS (SELECT 1 FROM cf_sync_state WHERE account_id=? AND generation=? AND lease_token=? AND next_page=? AND lease_until>?)${extraGuard ? ` AND (${extraGuard.sql})` : ""}`,
    bindings: [accountId, lease.generation, lease.token, lease.nextPage, now, ...(extraGuard?.bindings || [])],
  };
  const payload = JSON.stringify(domains);
  const statements = [
    buildDomainJsonUpsert(db, accountId, { from: "json_each(?) j", json: "j.value", where: "1", bindings: [payload] }, guard),
    db.prepare(`INSERT INTO cf_sync_seen (account_id, generation, domain_id, seen)
      SELECT ?, ?, json_extract(value,'$.id'), 1 FROM json_each(?) WHERE ${guard.sql}
      ON CONFLICT(account_id, generation, domain_id) DO UPDATE SET seen=1`)
      .bind(accountId, lease.generation, payload, ...guard.bindings),
  ];
  if (page.hasMore) {
    statements.push(db.prepare(`UPDATE cf_sync_state
      SET next_page=?, total_synced=total_synced+?, lease_until=?, updated_at=?
      WHERE account_id=? AND ${guard.sql}`)
      .bind(page.nextPage, domains.length, now + LEASE_SECONDS, now, accountId, ...guard.bindings));
  } else {
    statements.push(
      db.prepare(`DELETE FROM domains_cache WHERE account_id=? AND id IN
        (SELECT domain_id FROM cf_sync_seen WHERE account_id=? AND generation=? AND seen=0) AND ${guard.sql}`)
        .bind(accountId, accountId, lease.generation, ...guard.bindings),
      db.prepare(`DELETE FROM cf_sync_seen WHERE account_id=? AND ${guard.sql}`).bind(accountId, ...guard.bindings),
      db.prepare(`DELETE FROM cf_sync_state WHERE account_id=? AND ${guard.sql}`).bind(accountId, ...guard.bindings),
    );
  }
  const results = await db.batch(statements);
  if (results[results.length - 1].meta.changes !== 1) {
    throw new ConflictError("同步租约已失效，本页未提交，请重新同步", "sync_lease_expired");
  }
  lease.totalSynced += domains.length;
  lease.nextPage = page.nextPage;
}

export async function releaseCloudflareSync(db: D1Database, accountId: number, lease: CloudflareSyncLease): Promise<void> {
  await db.prepare("UPDATE cf_sync_state SET lease_until=0 WHERE account_id=? AND generation=? AND lease_token=?")
    .bind(accountId, lease.generation, lease.token).run();
}
