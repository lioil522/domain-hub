import { AppError } from "../../errors";
import type { AccountProvider } from "../types";
import { getBeijingNow } from "../time-utils";

export type SyncPhase = "list" | "dns" | "quota" | "cleanup" | "done";
export type SyncTaskStatus = "queued" | "running" | "paused" | "blocked" | "completed" | "cancelled" | "invalidated";
export interface SyncTask {
  id: string; generation: string; account_id: number; provider: AccountProvider; scope_revision: number;
  mode: "full" | "list"; phase: SyncPhase; cursor: string; version: number; status: SyncTaskStatus;
  owner: string | null; lease_until: number; next_attempt_at: number; last_completed_at: number | null;
   error: string | null; created_at: number; updated_at: number; db_now?: number;
}
export interface SyncFence {
  id: string; generation: string; scope_revision: number; version: number; owner: string; phase: SyncPhase;
}
export interface SyncFragment { kind: "list" | "dns"; shard: string; page: number; payload: string }
export interface SyncItem { kind: "seen" | "candidate"; domain_id: string; baseline?: string | null }
const now = "CAST(strftime('%s','now') AS INTEGER)";
const providers = ["dnshe", "cloudflare", "digitalplat", "dnspod", "alidns", "huaweicloud", "vercel"];
const phases = ["list", "dns", "quota", "cleanup", "done"];
const statuses = ["queued", "running", "paused", "blocked", "completed", "cancelled", "invalidated"];
const integer = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const fail = () => new AppError("同步任务状态损坏，未推进断点或覆盖缓存", 503, "sync_state_invalid");
const lost = () => new AppError("同步任务租约或版本已失效，请重新读取状态", 409, "sync_fence_lost");
function json(value: string, max: number, object = false): void {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > max) throw fail();
  try {
    const parsed = JSON.parse(value);
    if (object && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) throw fail();
  } catch { throw fail(); }
}
export function parseSyncTask(row: SyncTask): SyncTask {
  if (!row || !text(row.id, 128) || !text(row.generation, 128) || !integer(row.account_id, 1) ||
    !providers.includes(row.provider) || !integer(row.scope_revision, 1) || !["full", "list"].includes(row.mode) ||
    !phases.includes(row.phase) || !statuses.includes(row.status) || !integer(row.version) ||
    !(row.owner === null || text(row.owner, 128)) || !integer(row.lease_until) || !integer(row.next_attempt_at) ||
    !(row.last_completed_at === null || integer(row.last_completed_at)) ||
    !(row.error === null || typeof row.error === "string" && row.error.length <= 2048) ||
    !integer(row.created_at) || !integer(row.updated_at) ||
    (row.status === "running" && (!row.owner || row.lease_until === 0)) ||
    (row.status !== "running" && (row.owner !== null || row.lease_until !== 0)) ||
    (row.status === "completed" && (row.phase !== "done" || row.last_completed_at === null))) throw fail();
  json(row.cursor, 4096, true);
  return row;
}
function validateFence(fence: SyncFence): void {
  if (!text(fence.id, 128) || !text(fence.generation, 128) || !text(fence.owner, 128) ||
    !integer(fence.scope_revision, 1) || !integer(fence.version) || !phases.includes(fence.phase)) throw fail();
}
// Every data write and the final cursor transition use the SAME fence. Expired
// owners, credential changes and replays become no-ops inside one atomic batch.
export const syncGuard = `EXISTS (SELECT 1 FROM sync_tasks t JOIN accounts a ON a.id=t.account_id
  LEFT JOIN account_sync_versions v ON v.account_id=a.id
  WHERE t.id=? AND t.generation=? AND t.scope_revision=? AND t.version=? AND t.owner=? AND t.phase=?
    AND t.status='running' AND t.lease_until>${now} AND t.provider=a.provider
    AND CASE WHEN json_valid(t.cursor) AND length(t.cursor)<=4096 THEN json_type(t.cursor)='object' ELSE 0 END
    AND t.scope_revision=COALESCE(v.revision,1))`;
export const syncBindings = (f: SyncFence) => [f.id, f.generation, f.scope_revision, f.version, f.owner, f.phase];
const guard = syncGuard;
const bindings = syncBindings;

export async function readSyncScope(db: D1Database, accountId: number): Promise<{ provider: AccountProvider; revision: number } | null> {
  if (!integer(accountId, 1)) throw fail();
  const row = await db.prepare(`SELECT a.provider,COALESCE(v.revision,1) AS revision FROM accounts a
    LEFT JOIN account_sync_versions v ON v.account_id=a.id WHERE a.id=?`).bind(accountId)
    .first<{ provider: AccountProvider; revision: number }>();
  if (row && (!providers.includes(row.provider) || !integer(row.revision, 1))) throw fail();
  return row;
}

export async function createSyncTask(db: D1Database, input: {
  id: string; generation: string; accountId: number; provider: AccountProvider; revision: number; mode: "full" | "list";
}): Promise<boolean> {
  if (!text(input.id, 128) || !text(input.generation, 128) || !integer(input.accountId, 1) ||
    !providers.includes(input.provider) || !integer(input.revision, 1) || !["full", "list"].includes(input.mode)) throw fail();
  const result = await db.batch([
    db.prepare(`INSERT INTO account_sync_versions(account_id,revision) SELECT id,1 FROM accounts WHERE id=?
      ON CONFLICT(account_id) DO NOTHING`).bind(input.accountId),
    db.prepare(`INSERT INTO sync_tasks(id,generation,account_id,provider,scope_revision,mode,last_completed_at)
      SELECT ?,?,a.id,a.provider,v.revision,?,(SELECT MAX(last_completed_at) FROM sync_tasks old WHERE old.account_id=a.id AND old.mode=?) FROM accounts a JOIN account_sync_versions v ON v.account_id=a.id
      WHERE a.id=? AND a.provider=? AND v.revision=? ON CONFLICT DO NOTHING`)
      .bind(input.id, input.generation, input.mode, input.mode, input.accountId, input.provider, input.revision),
  ]);
  if (result.length !== 2 || result.some(r => !r.success)) throw fail();
  return result[1].meta.changes === 1;
}

export async function getSyncTask(db: D1Database, id: string): Promise<SyncTask | null> {
  if (!text(id, 128)) throw fail();
   const row = await db.prepare(`SELECT *,${now} AS db_now FROM sync_tasks WHERE id=?`).bind(id).first<SyncTask>();
  return row ? parseSyncTask(row) : null;
}

export async function claimSyncTask(db: D1Database, task: SyncTask, owner: string, leaseSeconds = 120): Promise<SyncTask | null> {
  parseSyncTask(task);
  if (!text(owner, 128) || !integer(leaseSeconds, 1) || leaseSeconds > 300) throw fail();
  const row = await db.prepare(`UPDATE sync_tasks SET owner=?,lease_until=${now}+?,status='running',
    version=version+1,updated_at=${now} WHERE id=? AND generation=? AND version=?
    AND status IN ('queued','running','paused') AND lease_until<=${now} AND next_attempt_at<=${now}
    AND EXISTS (SELECT 1 FROM accounts a LEFT JOIN account_sync_versions v ON v.account_id=a.id
      WHERE a.id=sync_tasks.account_id AND a.provider=sync_tasks.provider AND COALESCE(v.revision,1)=sync_tasks.scope_revision)
    RETURNING *`).bind(owner, leaseSeconds, task.id, task.generation, task.version).first<SyncTask>();
  return row ? parseSyncTask(row) : null;
}

export function syncFence(task: SyncTask): SyncFence {
  parseSyncTask(task);
  if (task.status !== "running" || !task.owner) throw lost();
  return { id: task.id, generation: task.generation, version: task.version, scope_revision: task.scope_revision, owner: task.owner, phase: task.phase };
}

/** Bounded atomic slice; the service supplies fenced business publish/delete SQL.
 * No retry on a rejected/unknown batch. Read authoritative task state next time.
 */
export async function commitSyncSlice(db: D1Database, fence: SyncFence, next: {
  phase: SyncPhase; cursor: string; status?: "queued" | "paused" | "blocked" | "completed";
  retryAfterSeconds?: number; error?: string | null;
 }, fragments: SyncFragment[] = [], items: SyncItem[] = [], business: D1PreparedStatement[] = []): Promise<void> {
  validateFence(fence);
  json(next.cursor, 4096, true);
  const status = next.status ?? "queued";
  const delay = next.retryAfterSeconds ?? 0;
  const transitions: Record<SyncPhase, SyncPhase[]> = {
    list: ["list", "dns", "quota", "cleanup"], dns: ["dns", "quota", "cleanup"],
    quota: ["quota", "cleanup"], cleanup: ["cleanup", "done"], done: [],
  };
  if (!phases.includes(next.phase) || !["queued", "paused", "blocked", "completed"].includes(status) ||
    !transitions[fence.phase].includes(next.phase) ||
    !integer(delay) || delay > 7 * 86400 || (status === "completed") !== (next.phase === "done") ||
    next.error != null && (typeof next.error !== "string" || next.error.length > 2048) || fragments.length + items.length > 100) throw fail();
  let bytes = 0;
  for (const fragment of fragments) {
    if (!["list", "dns"].includes(fragment.kind) || !text(fragment.shard, 256) || !integer(fragment.page)) throw fail();
    json(fragment.payload, 32768);
    bytes += new TextEncoder().encode(fragment.payload).byteLength;
  }
  for (const item of items) {
    if (!["seen", "candidate"].includes(item.kind) || !text(item.domain_id, 256)) throw fail();
    if (item.baseline != null) { json(item.baseline, 32768); bytes += new TextEncoder().encode(item.baseline).byteLength; }
  }
  if (bytes > 128 * 1024) throw fail();
  if (business.length > 100) throw fail();
  const statements = [
    ...business,
    ...fragments.map(f => db.prepare(`INSERT INTO sync_fragments(task_id,generation,kind,shard,page,payload)
      SELECT ?,?,?,?,?,? WHERE ${guard}
      ON CONFLICT(task_id,generation,kind,shard,page) DO UPDATE SET payload=excluded.payload`)
      .bind(fence.id, fence.generation, f.kind, f.shard, f.page, f.payload, ...bindings(fence))),
    ...items.map(item => db.prepare(`INSERT INTO sync_items(task_id,generation,kind,domain_id,baseline)
      SELECT ?,?,?,?,? WHERE ${guard} ON CONFLICT(task_id,generation,kind,domain_id) DO NOTHING`)
      .bind(fence.id, fence.generation, item.kind, item.domain_id, item.baseline ?? null, ...bindings(fence))),
    db.prepare(`UPDATE sync_tasks SET phase=?,cursor=?,status=?,owner=NULL,lease_until=0,version=version+1,
      next_attempt_at=${now}+?,error=?,last_completed_at=CASE WHEN ?='completed' THEN ${now} ELSE last_completed_at END,
      updated_at=${now} WHERE id=? AND ${guard}`)
      .bind(next.phase, next.cursor, status, delay, next.error ?? null, status, fence.id, ...bindings(fence)),
  ];
  const results = await db.batch(statements);
  if (results.length !== statements.length || results.some(result => !result.success)) throw fail();
  if (results[results.length - 1].meta.changes !== 1) throw lost();
}

export async function cancelSyncTask(db: D1Database, task: SyncTask): Promise<boolean> {
  parseSyncTask(task);
  const result = await db.prepare(`UPDATE sync_tasks SET status='cancelled',owner=NULL,lease_until=0,
    version=version+1,updated_at=${now} WHERE id=? AND generation=? AND version=?
    AND status IN ('queued','running','paused','blocked')`).bind(task.id, task.generation, task.version).run();
  if (!result.success) throw fail();
  return result.meta.changes === 1;
}

// Use the same latest-task order as syncPlan/syncStep, not import/insertion order.
// Preserve the actual latest completion AND the greatest inherited freshness
// anchor (createSyncTask uses MAX(last_completed_at), even on cancelled tasks).
// All predicates are evaluated again INSIDE each transaction, never from a
// preview's IDs. A damaged cursor or a retained owner/lease is not expendable.
const historyCandidates = `SELECT old.id FROM sync_tasks old WHERE old.status IN ('completed','cancelled','invalidated')
  AND old.owner IS NULL AND old.lease_until=0
  AND CASE WHEN json_valid(old.cursor) AND length(CAST(old.cursor AS BLOB))<=4096 THEN json_type(old.cursor)='object' ELSE 0 END
  AND (old.status<>'completed' OR old.phase='done' AND old.last_completed_at IS NOT NULL)
  AND old.rowid<>(SELECT newest.rowid FROM sync_tasks newest WHERE newest.account_id=old.account_id AND newest.mode=old.mode ORDER BY newest.created_at DESC,newest.rowid DESC LIMIT 1)
  AND old.rowid<>COALESCE((SELECT anchor.rowid FROM sync_tasks anchor WHERE anchor.account_id=old.account_id AND anchor.mode=old.mode AND anchor.last_completed_at IS NOT NULL ORDER BY anchor.last_completed_at DESC,anchor.created_at DESC,anchor.rowid DESC LIMIT 1),0)
  AND (old.status<>'completed' OR old.rowid<>(SELECT success.rowid FROM sync_tasks success WHERE success.account_id=old.account_id AND success.mode=old.mode AND success.status='completed' ORDER BY success.last_completed_at DESC,success.created_at DESC,success.rowid DESC LIMIT 1))
  AND old.updated_at<${now}-? ORDER BY old.updated_at,old.created_at,old.rowid LIMIT ?`;

function validateHistoryBounds(olderThanSeconds: number, limit: number) {
  if (!integer(olderThanSeconds, 1) || !integer(limit, 1) || limit > 100) throw fail();
}
export async function previewSyncHistory(db: D1Database, olderThanSeconds: number, limit = 100) {
  validateHistoryBounds(olderThanSeconds, limit);
  // Bounded samples, NOT full-table totals or a guarantee about a future write.
  const results = await db.batch<{ count: number }>([
    db.prepare(`SELECT COUNT(*) AS count FROM (${historyCandidates})`).bind(olderThanSeconds, limit),
    ...["sync_fragments", "sync_items"].map(table => db.prepare(`SELECT COUNT(*) AS count FROM (SELECT rowid FROM ${table} WHERE task_id IN (${historyCandidates}) LIMIT ?)`)
      .bind(olderThanSeconds, limit, limit)),
  ]);
  if (results.length !== 3 || results.some(r => !r.success || !integer(r.results[0]?.count) || r.results[0].count > limit)) throw fail();
  return { candidateTasks: results[0].results[0].count, fragments: results[1].results[0].count, items: results[2].results[0].count };
}

/** One atomic, bounded maintenance slice. Children are removed first; an empty
 * task deletion cannot initiate a large cascade. No application retry on an
 * unknown response. All legacy cache/scanner/action data stay outside the scope.
 */
export async function purgeSyncHistorySlice(db: D1Database, olderThanSeconds: number, limit = 100, audit = false) {
  validateHistoryBounds(olderThanSeconds, limit);
  const results = await db.batch([
    db.prepare(`DELETE FROM sync_fragments WHERE rowid IN (SELECT rowid FROM sync_fragments WHERE task_id IN (${historyCandidates}) LIMIT ?)`)
      .bind(olderThanSeconds, limit, limit),
    db.prepare(`DELETE FROM sync_items WHERE rowid IN (SELECT rowid FROM sync_items WHERE task_id IN (${historyCandidates}) LIMIT ?)`)
      .bind(olderThanSeconds, limit, limit),
    db.prepare(`DELETE FROM sync_tasks WHERE id IN (SELECT t.id FROM sync_tasks t
      WHERE t.id IN (${historyCandidates})
      AND NOT EXISTS(SELECT 1 FROM sync_fragments f WHERE f.task_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM sync_items i WHERE i.task_id=t.id) LIMIT ?)`)
      .bind(olderThanSeconds, limit, limit),
    ...(audit ? [db.prepare("INSERT INTO logs(type,category,message,details,created_at) VALUES('info','operation',?,?,?)")
      .bind("管理员执行了一片有界同步历史维护", JSON.stringify({ olderThanSeconds, limit, scope: "terminal-sync-history" }), getBeijingNow())] : []),
  ]);
  if (results.length !== (audit ? 4 : 3) || results.some(result => !result.success) || results.slice(0, 3).some(r => !integer(r.meta.changes) || r.meta.changes > limit)) throw fail();
  return { fragments: results[0].meta.changes, items: results[1].meta.changes, tasks: results[2].meta.changes };
}

/** Compatibility helper for callers needing only the sum of deleted rows. */
export async function purgeSyncHistory(db: D1Database, olderThanSeconds: number, limit = 100): Promise<number> {
  const counts = await purgeSyncHistorySlice(db, olderThanSeconds, limit);
  return counts.fragments + counts.items + counts.tasks;
}
