import type { DatabaseManager, UpstreamSubdomain } from "../db";
import { AppError } from "../errors";
import { DNSHEClient, type DnsRecordInfo } from "../dnshe";
import { ProviderApiError, incompleteResponse } from "../errors/provider-api-error";
import { buildDomainUpsert } from "../db/dao/domain-dao";
import { claimSyncTask, commitSyncSlice, createSyncTask, getSyncTask, parseSyncTask, readSyncScope, syncBindings, syncFence, syncGuard, type SyncTask } from "../db/dao/sync-task-dao";
import { readDomainPage } from "./sync-page-service";
import { computeDnsState } from "../dns-provider";
import { automationSettings } from "./automation-settings";
import { InvocationBudget, InvocationBudgetError } from "./invocation-budget";
import { withBudgetD1 } from "../db/budget-d1";
import { getBeijingNow } from "../db/time-utils";

const now = "CAST(strftime('%s','now') AS INTEGER)";
// Seek the integer primary key before checking exact persisted text identity.
// CAST on d.id alone prevents a point lookup; casting only i.domain_id would
// incorrectly alias malformed values such as '01', '1.0' or '1junk'. Retain
// both predicates and all snapshot/fence checks, without a schema migration.
const domainItemMatch = "d.id=CAST(i.domain_id AS INTEGER) AND CAST(d.id AS TEXT)=i.domain_id";
interface Cursor {
  stage?: "candidates" | "fetch" | "publish"; start?: number; after?: string; page?: number | string;
  count?: number; total?: number; pages?: number; domain?: number; dnsCursor?: number | string;
   dnsPage?: number; dnsVersion?: number; dnsAfter?: string; dnsDone?: number;
}
function cursorOf(task: SyncTask): Cursor {
  const c = JSON.parse(task.cursor) as Cursor;
   for (const key of ["start", "count", "total", "pages", "domain", "dnsPage", "dnsVersion", "dnsDone"] as const) {
    if (c[key] !== undefined && (!Number.isSafeInteger(c[key]) || c[key]! < 0)) throw new AppError("同步游标损坏", 503, "sync_state_invalid");
  }
  if (c.stage !== undefined && !["candidates", "fetch", "publish"].includes(c.stage) ||
    [c.after, c.dnsAfter].some(v => v !== undefined && (typeof v !== "string" || v.length > 256)) ||
    [c.page, c.dnsCursor].some(v => v !== undefined && (typeof v !== "number" && typeof v !== "string" || String(v).length > 256))) throw new AppError("同步游标损坏", 503, "sync_state_invalid");
  return c;
}
export function syncView(task: SyncTask, dbNow = task.db_now ?? Math.floor(Date.now() / 1000)) {
  const c = cursorOf(task);
  let failure: { message?: string; error_code?: string; status?: number; panelStatus?: number; retryAfterMs?: number; rateLimited?: boolean; details?: unknown; budget_yield?: boolean } = {};
  if (task.error) { try { const parsed = JSON.parse(task.error); failure = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { message: task.error }; } catch { failure = { message: task.error }; } }
  return { taskId: task.id, actionId: task.id, accountId: task.account_id, version: task.version, phase: task.phase,
    status: task.status, executing: task.status === "running" && Boolean(task.owner) && task.lease_until > dbNow,
    progress: task.status === "completed" ? 100 : task.phase === "list" ? c.stage === "publish" ? 45 : 10 : task.phase === "dns" ? 60 + (c.count && c.dnsDone !== undefined ? Math.min(25, 25 * c.dnsDone / c.count) : 0) : 90,
     continuation: ["queued", "running", "paused"].includes(task.status), retry_after_ms: Math.max(0, (Math.max(task.next_attempt_at, task.lease_until) - dbNow) * 1000),
     updated_at: task.updated_at, list_stage: c.stage, domain_count: c.count, list_pages: c.pages, dns_completed: c.dnsDone,
      last_completed_at: task.last_completed_at, error: failure.message ?? task.error, failure: task.error ? failure : null,
      budget_yield: task.status === "paused" && failure.budget_yield === true };
}

/** Plan is local-only, keyset bounded, no decrypted credentials or upstream I/O. */
export async function syncPlan(db: DatabaseManager, options: { manual?: boolean; provider?: string; after?: number; accountIds?: number[] } = {}) {
  const cfg = await automationSettings(db);
  const accounts = await db.allRaw<{ id: number; alias: string; provider: string; now: number }>(`SELECT id,alias,provider,${now} AS now FROM accounts
    WHERE provider<>'custom' AND id>? AND (? IS NULL OR provider=?) ${options.accountIds ? `AND id IN (${options.accountIds.map(() => "?").join(",") || "NULL"})` : ""} ORDER BY id LIMIT 25`,
    [options.after ?? 0, options.provider ?? null, options.provider ?? null, ...options.accountIds ?? []]);
  // Resolve the latest row once per bounded account, rather than evaluating an
  // anti-join for every historical task. Keep the existing timestamp/rowid tie
  // break, including imported history whose insertion order differs from time.
  const tasks = accounts.length ? await db.allRaw<SyncTask>(`SELECT t.* FROM accounts a JOIN sync_tasks t
    ON t.rowid=(SELECT newer.rowid FROM sync_tasks newer WHERE newer.account_id=a.id AND newer.mode='full' ORDER BY newer.created_at DESC,newer.rowid DESC LIMIT 1)
    WHERE a.id IN (${accounts.map(() => "?").join(",")})`, accounts.map(a => a.id)) : [];
  const plans = accounts.map(a => {
    const t = tasks.find(t => t.account_id === a.id);
    if (t) parseSyncTask(t);
    const eligible = options.manual || cfg.login_sync_enabled === "true" && (!t ||
      ["queued", "running", "paused", "invalidated"].includes(t.status) || t.status === "completed" && a.now - t.last_completed_at! >= cfg.freshness);
     return { alias: a.alias, provider: a.provider, eligible: Boolean(eligible), ...(t ? syncView(t, a.now) : { accountId: a.id, last_completed_at: null, status: "stale" }) };
  });
  return { plans, nextAfter: accounts.length === 25 ? accounts[accounts.length - 1].id : null, enabled: cfg.login_sync_enabled === "true" };
}

export async function syncStep(db: DatabaseManager, accountId: number, options: { manual?: boolean; taskId?: string } = {}) {
  let task = options.taskId ? await getSyncTask(db.connection, options.taskId) : await db.firstRaw<SyncTask>(`SELECT * FROM sync_tasks WHERE account_id=? AND mode='full' ORDER BY created_at DESC,rowid DESC LIMIT 1`, [accountId]);
  if (task) { parseSyncTask(task); if (task.account_id !== accountId) throw new AppError("任务与账号不匹配", 400, "bad_request"); }
  const cfg = await automationSettings(db);
  const dbNow = (await db.firstRaw<{ now: number }>(`SELECT ${now} AS now`))!.now;
  if (!options.manual && cfg.login_sync_enabled !== "true") throw new AppError("登录后同步已关闭", 409, "sync_disabled");
   if (task && options.taskId && ["completed", "cancelled", "invalidated"].includes(task.status)) return syncView(task, dbNow);
   if (!options.manual && task && (task.status === "cancelled" || task.status === "blocked" || task.status === "completed" && dbNow - task.last_completed_at! < cfg.freshness)) return syncView(task, dbNow);
  if (task?.status === "blocked" && options.manual && !options.taskId) {
    await db.executeRaw(`UPDATE sync_tasks SET status='cancelled',version=version+1,updated_at=${now} WHERE id=? AND version=? AND status='blocked'`, [task.id, task.version]);
    task = (await getSyncTask(db.connection, task.id))!;
  }
  if (!task || ["completed", "cancelled", "invalidated"].includes(task.status)) {
    const scope = await readSyncScope(db.connection, accountId);
    if (!scope) throw new AppError("账号不存在", 404, "not_found");
    const id = crypto.randomUUID();
    await createSyncTask(db.connection, { id, generation: crypto.randomUUID(), accountId, provider: scope.provider, revision: scope.revision, mode: "full" });
    task = await db.firstRaw<SyncTask>(`SELECT * FROM sync_tasks WHERE account_id=? AND mode='full' AND status IN ('queued','running','paused','blocked') LIMIT 1`, [accountId]);
    if (!task) throw new AppError("无法创建同步任务", 503, "sync_state_invalid");
  }
  // Repair missing tracking after an unknown Action insertion; never restart the
  // task or upstream snapshot merely because its UI record could not be stored.
  await db.executeRaw(`INSERT OR IGNORE INTO actions(id,type,status,progress,started_at,metadata) VALUES(?,'sync','queued',0,datetime('now'),?)`, [task.id, JSON.stringify({ label: "分片完整同步", accountIds: [accountId], sliced: true })]);
  const owned = await claimSyncTask(db.connection, task, crypto.randomUUID());
  if (!owned) return syncView((await getSyncTask(db.connection, task.id))!);
  const fence = syncFence(owned);
  const c = cursorOf(owned);
  // Protect the final failure/commit capacity from admission polling and transport.
  const budget = db.invocationBudget;
  const tail = budget instanceof InvocationBudget ? budget.reserve({ d1: 3 }) : undefined;
  const tailDb = tail ? withBudgetD1(db.connection, tail) : db.connection;
   // Logs share the cursor fence and atomic batch: no extra dispatch, duplicate
   // success on an unknown response, or claim of success by an expired owner.
   const log = (type: string, message: string, details: object = {}) => tailDb.prepare(`INSERT INTO logs(type,category,message,details,created_at) SELECT ?,'sync',?,?,? WHERE ${syncGuard}`)
     .bind(type, `账号 ${accountId}：${message}`, JSON.stringify({ taskId: owned.id, provider: owned.provider, ...details }), getBeijingNow(), ...syncBindings(fence));
   const commit = (phase: SyncTask["phase"], cursor: Cursor, items: Parameters<typeof commitSyncSlice>[4] = [], fragments: Parameters<typeof commitSyncSlice>[3] = [], business: D1PreparedStatement[] = []) => {
     const logs: D1PreparedStatement[] = [];
     if (owned.phase === "list" && !c.stage) logs.push(log("info", "开始分片完整同步（不含续期）"));
     if (owned.error) logs.push(log("info", "从已保存断点继续同步"));
     if (phase !== owned.phase || c.stage !== cursor.stage) logs.push(log(phase === "done" ? "success" : "info",
       phase === "done" ? "完整同步完成" : phase === "dns" ? "域名列表已完整保存，开始同步 DNS" : phase === "cleanup" ? "开始有界核对旧域名" : phase === "quota" ? "DNS 同步完成" : cursor.stage === "fetch" ? "开始读取域名列表" : "域名列表读取完成，开始发布快照",
       { phase, domainCount: cursor.count, listPages: cursor.pages, dnsCompleted: cursor.dnsDone }));
     if (phase === "dns" && cursor.dnsDone !== c.dnsDone && cursor.dnsDone && (cursor.dnsDone === 1 || cursor.dnsDone % 10 === 0)) logs.push(log("info", `DNS 已同步 ${cursor.dnsDone}/${cursor.count ?? "未知"} 个域名`));
     return commitSyncSlice(tailDb, fence, { phase, cursor: JSON.stringify(cursor), status: phase === "done" ? "completed" : "queued" }, fragments, items, [...business, ...logs,
       tailDb.prepare(`UPDATE actions SET status=?,progress=?,error=NULL,finished_at=CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE id=? AND ${syncGuard}`).bind(phase === "done" ? "completed" : "queued", phase === "done" ? 100 : 50, phase === "done" ? 1 : 0, owned.id, ...syncBindings(fence))]);
   };
  const guarded = (sql: string, values: unknown[]) => tailDb.prepare(sql).bind(...values, ...syncBindings(fence));
  try {
    if (owned.phase === "list" && (!c.stage || c.stage === "candidates")) {
      const start = c.start ?? (await db.firstRaw<{ version: number }>("SELECT version FROM domain_mutation_clock WHERE id=1"))!.version;
      const rows = await db.allRaw<{ id: number; version: number }>(`SELECT d.id,COALESCE(m.version,0) AS version FROM domains_cache d LEFT JOIN domain_mutations m ON m.domain_id=d.id WHERE d.account_id=? AND CAST(d.id AS TEXT)>? AND COALESCE(m.version,0)<=? ORDER BY CAST(d.id AS TEXT) LIMIT 40`, [accountId, c.after ?? "", start]);
      await commit("list", { ...c, start, stage: rows.length === 40 ? "candidates" : "fetch", after: rows.at(-1) ? String(rows.at(-1)!.id) : c.after }, rows.map(r => ({ kind: "candidate", domain_id: String(r.id), baseline: JSON.stringify(r.version) })));
    } else if (owned.phase === "list" && c.stage === "fetch") {
      if ((c.pages ?? 0) >= 200 || c.start === undefined) throw incompleteResponse(owned.provider);
      const { client } = await db.getClientForAccount(accountId);
      const page = await readDomainPage(client, c.page, c.count ?? 0, c.total);
      const ids = new Set<string>(); const names = new Set<string>();
      if (page.items.length > 100) throw incompleteResponse(owned.provider, "单页超过 100 条安全上限；未发布或删除旧数据");
      for (const sub of page.items) {
        const name = sub.full_domain?.toLowerCase();
        if (!Number.isSafeInteger(sub.id) || !name || ids.has(String(sub.id)) || names.has(name)) throw incompleteResponse(owned.provider);
        ids.add(String(sub.id)); names.add(name);
      }
      if (ids.size) {
        const prior = await db.firstRaw<{ hit: number }>(`SELECT 1 AS hit FROM sync_items WHERE task_id=? AND generation=? AND kind='seen' AND (domain_id IN (SELECT value FROM json_each(?)) OR lower(json_extract(baseline,'$.full_domain')) IN (SELECT value FROM json_each(?))) LIMIT 1`, [owned.id, owned.generation, JSON.stringify([...ids]), JSON.stringify([...names])]);
        if (prior) throw incompleteResponse(owned.provider);
      }
      await commit("list", { ...c, count: (c.count ?? 0) + page.items.length, total: page.total, page: page.next ?? undefined, pages: (c.pages ?? 0) + 1, stage: page.next === null ? "publish" : "fetch", after: page.next === null ? "" : c.after }, page.items.map(sub => ({ kind: "seen", domain_id: String(sub.id), baseline: JSON.stringify(sub) })));
    } else if (owned.phase === "list" && c.stage === "publish") {
      if (c.start === undefined) throw new AppError("缺少快照版本", 503, "sync_state_invalid");
      const snapshot = await db.firstRaw<{ count: number; collision: number }>(`SELECT COUNT(*) AS count,COALESCE(MAX(EXISTS(SELECT 1 FROM domains_cache d WHERE ${domainItemMatch} AND d.account_id<>?)),0) AS collision FROM sync_items i WHERE task_id=? AND generation=? AND kind='seen'`, [accountId, owned.id, owned.generation]);
      if (!snapshot || snapshot.count !== c.count || snapshot.collision) throw new AppError("域名快照缺失或 ID 与其他账号冲突，未确认完整同步", 503, "sync_state_invalid");
      const rows = await db.allRaw<{ domain_id: string; baseline: string }>(`SELECT domain_id,baseline FROM sync_items WHERE task_id=? AND generation=? AND kind='seen' AND domain_id>? ORDER BY domain_id LIMIT 20`, [owned.id, owned.generation, c.after ?? ""]);
      const writes = rows.map(r => {
        const sub = JSON.parse(r.baseline) as UpstreamSubdomain;
        if (String(sub.id) !== r.domain_id || !sub.full_domain) throw new AppError("域名快照损坏", 503, "sync_state_invalid");
        return buildDomainUpsert(tailDb, accountId, sub, { sql: `${syncGuard} AND COALESCE((SELECT version FROM domain_mutations WHERE domain_id=?),0)<=? AND NOT EXISTS(SELECT 1 FROM domains_cache WHERE id=? AND account_id<>?)`, values: [...syncBindings(fence), Number(r.domain_id), c.start!, Number(r.domain_id), accountId] });
      });
      writes.unshift(tailDb.prepare(`INSERT INTO sync_commit_assertions(valid) SELECT 0 WHERE ${syncGuard} AND EXISTS(SELECT 1 FROM sync_items i JOIN domains_cache d ON ${domainItemMatch} WHERE i.task_id=? AND i.generation=? AND i.kind='seen' AND d.account_id<>?)`).bind(...syncBindings(fence), owned.id, owned.generation, accountId));
       await commit(rows.length === 20 ? "list" : owned.provider === "dnshe" ? "dns" : "cleanup", { ...c, after: rows.length === 20 ? rows.at(-1)?.domain_id : "", dnsAfter: "", dnsDone: 0 }, [], [], writes);
    } else if (owned.phase === "dns") {
      let domain = c.domain;
      let version = c.dnsVersion;
      if (domain === undefined) {
        const row = await db.firstRaw<{ id: number; version: number }>(`SELECT d.id,COALESCE(m.version,0) AS version FROM sync_items i JOIN domains_cache d ON ${domainItemMatch} LEFT JOIN domain_mutations m ON m.domain_id=d.id WHERE i.task_id=? AND i.generation=? AND i.kind='seen' AND i.domain_id>? AND d.account_id=? ORDER BY i.domain_id LIMIT 1`, [owned.id, owned.generation, c.dnsAfter ?? "", accountId]);
        if (!row) { await commit("quota", c); return syncView((await getSyncTask(db.connection, owned.id))!); }
        domain = row.id; version = row.version;
      }
      const { client } = await db.getClientForAccount(accountId);
      if (!(client instanceof DNSHEClient)) throw incompleteResponse("dnshe");
      if (await db.firstRaw("SELECT 1 FROM cache WHERE key=? AND expires_at>CAST(strftime('%s','now') AS INTEGER)", [`dns_dirty:${domain}`])) throw new AppError("DNS 写入尚未核验，请先手动刷新解析记录", 409, "sync_concurrent_mutation");
      const response = await client.listDnsRecordsPage(domain, c.dnsCursor ?? 0);
      if (!response.success || response.complete === false || !Array.isArray(response.records) || response.records.length > 100 || (c.dnsPage ?? 0) >= 50) throw incompleteResponse("dnshe");
      const payload = JSON.stringify({ cursor: c.dnsCursor ?? 0, records: response.records });
      if (new TextEncoder().encode(payload).length > 32768) throw incompleteResponse("dnshe", "DNS单页超过32KiB片段限制，保留原缓存；需要服务商支持更小页");
      const p = response.pagination;
      if (p && typeof p.has_more !== "boolean") throw incompleteResponse("dnshe");
      const ended = p ? !p.has_more : response.records.length < 100;
      const next = p?.next_cursor;
      if (!ended && (!response.records.length || next == null || !["string", "number"].includes(typeof next) || String(next) === String(c.dnsCursor ?? 0))) throw incompleteResponse("dnshe");
      const prior = await db.allRaw<{ page: number; payload: string }>(`SELECT page,payload FROM sync_fragments WHERE task_id=? AND generation=? AND kind='dns' AND shard=? ORDER BY page LIMIT 51`, [owned.id, owned.generation, String(domain)]);
      if (prior.length !== (c.dnsPage ?? 0) || prior.some((r, i) => r.page !== i)) throw new AppError("DNS 分页片段缺失，保留旧快照", 503, "sync_state_invalid");
      const fragments = prior.map(r => { let value; try { value = JSON.parse(r.payload); } catch { throw new AppError("DNS 片段损坏", 503, "sync_state_invalid"); }
        if (!value || !Array.isArray(value.records) || !["number", "string"].includes(typeof value.cursor)) throw new AppError("DNS 片段损坏", 503, "sync_state_invalid"); return value as { records: DnsRecordInfo[]; cursor: number | string }; });
      const records: DnsRecordInfo[] = [...fragments.flatMap(r => r.records), ...response.records];
      const seen = new Set<string>();
      for (const r of records) { if (!r || !(typeof r.id === "string" && r.id.length > 0 || typeof r.id === "number" && Number.isSafeInteger(r.id)) || seen.has(String(r.id))) throw incompleteResponse("dnshe"); seen.add(String(r.id)); }
      if (fragments.some(r => String(r.cursor) === String(next)) && !ended || new TextEncoder().encode(JSON.stringify(records)).length > 128 * 1024) throw incompleteResponse("dnshe", "DNS 快照超出有界发布限制，保留原缓存");
      const business: D1PreparedStatement[] = [];
      if (ended) {
        const condition = `COALESCE((SELECT version FROM domain_mutations WHERE domain_id=?),0)=? AND EXISTS(SELECT 1 FROM domains_cache WHERE id=? AND account_id=?) AND ${syncGuard}`;
        const values = [domain, version, domain, accountId];
        business.push(tailDb.prepare(`INSERT INTO sync_commit_assertions(valid) SELECT 0 WHERE ${syncGuard} AND NOT (COALESCE((SELECT version FROM domain_mutations WHERE domain_id=?),0)=? AND EXISTS(SELECT 1 FROM domains_cache WHERE id=? AND account_id=?) AND NOT EXISTS(SELECT 1 FROM cache WHERE key=? AND expires_at>${now}))`).bind(...syncBindings(fence), ...values, `dns_dirty:${domain}`));
        business.push(guarded(`INSERT INTO cache(key,value,expires_at) SELECT ?,?,${now}+31622400 WHERE ${condition} ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at`, [`api_cache:dns:${domain}`, JSON.stringify(records), ...values]));
        const state = computeDnsState(records);
        business.push(guarded(`UPDATE domains_cache SET status=?,has_dns=?,dns_provider=? WHERE id=? AND ${condition}`, [state.status, state.has_dns ? 1 : 0, state.dns_provider, domain, ...values]));
        // A concurrent write must not silently count as a full DNS success.
        const current = await db.firstRaw<{ version: number }>("SELECT version FROM domain_mutations WHERE domain_id=?", [domain]);
        if ((current?.version ?? 0) !== version) throw new AppError("DNS 同期发生修改，请手动重新同步", 409, "sync_concurrent_mutation");
      }
       await commit("dns", ended ? { ...c, domain: undefined, dnsCursor: undefined, dnsPage: undefined, dnsVersion: undefined, dnsAfter: String(domain), dnsDone: c.dnsDone === undefined ? undefined : c.dnsDone + 1 } : { ...c, domain, dnsVersion: version, dnsCursor: next!, dnsPage: (c.dnsPage ?? 0) + 1 }, [], [{ kind: "dns", shard: String(domain), page: c.dnsPage ?? 0, payload }], business);
    } else if (owned.phase === "quota") {
      // Optional quota is a separate bounded stage, never repeated on each page.
      // Quota refresh is optional, not part of the authoritative domain/DNS
      // snapshot. Existing quota endpoints remain separate from full sync.
      await commit("cleanup", { ...c, after: "" });
    } else if (owned.phase === "cleanup") {
      const rows = await db.allRaw<{ domain_id: string; baseline: string }>(`SELECT domain_id,baseline FROM sync_items WHERE task_id=? AND generation=? AND kind='candidate' AND domain_id>? ORDER BY domain_id LIMIT 40`, [owned.id, owned.generation, c.after ?? ""]);
      const writes = rows.map(r => guarded(`DELETE FROM domains_cache WHERE id=? AND account_id=? AND COALESCE((SELECT version FROM domain_mutations WHERE domain_id=?),0)=? AND NOT EXISTS(SELECT 1 FROM sync_items WHERE task_id=? AND generation=? AND kind='seen' AND domain_id=?) AND ${syncGuard}`, [Number(r.domain_id), accountId, Number(r.domain_id), JSON.parse(r.baseline), owned.id, owned.generation, r.domain_id]));
      await commit(rows.length === 40 ? "cleanup" : "done", { ...c, after: rows.at(-1)?.domain_id ?? c.after }, [], [], writes);
    } else throw new AppError("同步阶段不兼容", 503, "sync_state_invalid");
  } catch (error) {
    // Unknown batch outcome: never replay business writes in this invocation.
    const blocked = error instanceof ProviderApiError && ([401, 403].includes(error.status) || error.error_code === "incomplete_response") || error instanceof AppError && ["sync_state_invalid", "sync_concurrent_mutation"].includes(error.code) || error instanceof Error && error.message.includes("CHECK constraint failed");
    const budgetError = error instanceof InvocationBudgetError ? error : undefined;
    const yieldBudget = budgetError?.reason === "exhausted" && budgetError.requestSent !== "unknown";
    const snapshot = budget instanceof InvocationBudget ? budget.snapshot() : undefined;
    const budgetDetails = budgetError ? { resource: budgetError.resource, reason: budgetError.reason, phase: owned.phase,
      ...(budgetError.accounting ?? (snapshot ? { used: snapshot.used[budgetError.resource], reserved: snapshot.reserved[budgetError.resource], limit: snapshot.limits[budgetError.resource] } : {})),
      ...(budgetError.requestSent === undefined ? {} : { request_sent: budgetError.requestSent }) } : undefined;
    const failure = JSON.stringify({ message: (error instanceof Error ? error.message : "同步失败").slice(0, 800),
      ...(error instanceof ProviderApiError ? { error_code: error.error_code, status: error.status, panelStatus: error.statusCode, retryAfterMs: error.retryAfterMs, rateLimited: error.rateLimited, details: error.details } : error instanceof AppError ? { error_code: error.code, panelStatus: error.statusCode,
        ...(budgetDetails ? { details: budgetDetails, budget_yield: yieldBudget } : {}) } : {}) });
    try {
      await commitSyncSlice(tailDb, fence, { phase: owned.phase, cursor: owned.cursor, status: blocked ? "blocked" : "paused",
        retryAfterSeconds: yieldBudget ? 1 : error instanceof ProviderApiError ? Math.min(604800, Math.max(60, Math.ceil((error.retryAfterMs ?? 300000) / 1000))) : 300,
        error: failure.length <= 2048 ? failure : JSON.stringify({ message: "同步失败；上游错误详情过长", error_code: error instanceof AppError ? error.code : "sync_failed" }) }, [], [],
        [log(blocked ? "error" : "warning", blocked ? "完整同步受阻，保留旧缓存与断点；请查看错误后手动重试" : yieldBudget ? "本次预算用尽，断点已保存；下一分片继续" : "同步暂缓，断点已保存",
          { phase: owned.phase, error_code: error instanceof ProviderApiError ? error.error_code : error instanceof AppError ? error.code : "sync_failed", ...budgetDetails })]);
      if (yieldBudget) {
        // The exhausted main counter cannot read. Use the reserved tail and only
        // acknowledge the exact fenced pause after BOTH save and read succeed.
        const latest = await getSyncTask(tailDb, owned.id);
        if (latest && latest.generation === owned.generation && latest.scope_revision === owned.scope_revision &&
          latest.version === owned.version + 1 && latest.status === "paused" && latest.phase === owned.phase && latest.cursor === owned.cursor && latest.error === failure) return syncView(latest);
      }
    } catch { /* Read authoritative state on the next invocation; never replay this batch. */ }
    if (budgetError) throw budgetError;
  } finally { tail?.release(); }
  const latest = (await getSyncTask(db.connection, owned.id))!;
  return syncView(latest);
}
