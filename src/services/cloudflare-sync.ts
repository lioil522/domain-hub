import type { DatabaseManager } from "../db";
import type { SyncCandidate } from "../db/dao/sync-dao";
import { CloudflareClient, mapZoneToUpstream } from "../cloudflare";
import { cfZoneCursorKey, CF_ZONE_CURSOR_TTL, CF_ZONE_ROUNDS_PER_RUN } from "../cron/cf-helpers";
import { IncompleteSyncError, summarizeSync, syncIssue } from "./sync-result";

interface ZoneSnapshot {
  version: 2;
  scope: string;
  startPage: number;
  syncedBefore: number;
  seenIds: number[];
  candidates: SyncCandidate[];
}

function decode(raw: string | undefined, scope: string): ZoneSnapshot | null {
  try {
    const value = JSON.parse(raw || "null") as ZoneSnapshot | null;
    if (!value || value.version !== 2 || value.scope !== scope || !Number.isSafeInteger(value.startPage) || value.startPage < 1 ||
      !Array.isArray(value.seenIds) || !value.seenIds.every(Number.isSafeInteger) ||
      new Set(value.seenIds).size !== value.seenIds.length || value.syncedBefore !== value.seenIds.length ||
      (value.startPage === 1 && value.seenIds.length !== 0) ||
      !Array.isArray(value.candidates) || !value.candidates.every(c => Number.isSafeInteger(c.id) && (c.updated_at === null || typeof c.updated_at === "string"))) return null;
    return value;
  } catch { return null; }
}

/** Shared by manual and cron paths. Each page and its next cursor commit together. */
export async function syncCloudflareZoneBatch(db: DatabaseManager, accountId: number, client: CloudflareClient) {
  const cursorKey = cfZoneCursorKey(accountId);
  const leaseKey = `sync_lock:cloudflare:${accountId}`;
  const token = crypto.randomUUID();
  if (!(await db.acquireSyncLease(leaseKey, token))) throw new Error("该账号正在同步，请稍后重试");
  let committedTotal = 0;
  let committedNextPage: number | undefined;
  try {
    const scope = await client.syncScope();
    const row = await db.firstRaw<{ value: string }>("SELECT value FROM cache WHERE key = ? AND expires_at > ?", [cursorKey, Math.floor(Date.now() / 1000)]);
    // Old cursors lack a full snapshot. Restart from page 1, never prune their last fragment.
    const cursor: ZoneSnapshot = decode(row?.value, scope) || {
      version: 2, scope, startPage: 1, syncedBefore: 0, seenIds: [],
      candidates: await db.allRaw<SyncCandidate>("SELECT id, updated_at FROM domains_cache WHERE account_id = ?", [accountId]),
    };
    const seen = new Set(cursor.seenIds);
    committedTotal = cursor.syncedBefore;
    committedNextPage = cursor.startPage;
    let fetched = 0;
    for (let round = 0; round < CF_ZONE_ROUNDS_PER_RUN; round++) {
      const page = await client.listZones({ startPage: cursor.startPage, maxPages: 1 });
      if (!Array.isArray(page.zones) || typeof page.hasMore !== "boolean" ||
        page.zones.some(z => !z.id || !z.name) ||
        (page.hasMore && (!Number.isSafeInteger(page.nextPage) || page.nextPage !== cursor.startPage + 1 || page.zones.length === 0))) {
        throw new Error("Cloudflare 分页响应不完整，旧缓存保持不变");
      }
      const domains = page.zones.map(mapZoneToUpstream);
      const pageIds = new Set<number>();
      for (const domain of domains) {
        if (seen.has(domain.id) || pageIds.has(domain.id)) throw new Error("Cloudflare 分页重复，已停止同步并保留旧缓存");
        pageIds.add(domain.id);
      }
      domains.forEach(d => seen.add(d.id));
      fetched += domains.length;
      cursor.startPage = page.nextPage;
      cursor.seenIds = [...seen];
      cursor.syncedBefore = seen.size;
      const completed = !page.hasMore;
      const deletions = completed ? cursor.candidates.filter(c => !seen.has(c.id)) : [];
      await db.commitSyncPage(accountId, domains, leaseKey, token, cursorKey,
        completed ? "" : JSON.stringify(cursor), completed ? 1 : CF_ZONE_CURSOR_TTL, deletions);
      committedTotal = seen.size;
      committedNextPage = completed ? undefined : cursor.startPage;
      if (completed) return { completed: true, fetched, total: seen.size, nextPage: 1 };
    }
    return { completed: false, fetched, total: seen.size, nextPage: cursor.startPage };
  } catch (error) {
    if (committedTotal > 0) throw new IncompleteSyncError(summarizeSync([{
      accountId, status: "partial", total: committedTotal, nextPage: committedNextPage,
      issues: [syncIssue(error, "account"), { phase: "continuation", message: `已保留 ${committedTotal} 个 zone 的同步进度，请排查错误后再次同步续拉` }],
    }]));
    throw error;
  } finally {
    // An old runner must never release a newer runner's lease.
    await db.executeRaw("DELETE FROM cache WHERE key = ? AND value = ?", [leaseKey, token]);
  }
}
