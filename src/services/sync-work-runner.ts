import type { DatabaseManager, UpstreamSubdomain } from "../db";
import { DNSHEClient } from "../dnshe";
import { CloudflareClient } from "../cloudflare";
import { DigitalPlatClient, mapDomainToUpstream } from "../digitalplat";
import { listUpstreamDomains } from "../cron/jobs/upstream-sync";
import { computeDnsState } from "../dns-provider";
import { syncCloudflareSlice } from "./cloudflare-sync-service";
import { SyncWorkQueue, credentialFingerprint, type SyncWork, type SyncCursor } from "../db/dao/sync-work-dao";
import { ConflictError, NotFoundError, UpstreamRateLimitError, ValidationError } from "../errors";
import type { WebhookType } from "../cron/notification";
import { notificationTargets } from "./notification-service";

function normalizeDomains(rows: UpstreamSubdomain[]): UpstreamSubdomain[] {
  return rows.map(row => {
    if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || !row.full_domain) throw new ValidationError("上游域名列表包含无效身份，未执行清理");
    const result: UpstreamSubdomain = { id: row.id, subdomain: row.subdomain || "", rootdomain: row.rootdomain || row.full_domain,
      full_domain: row.full_domain, status: row.status || "未解析", expires_at: row.expires_at || "", created_at: row.created_at || "",
      has_dns: row.has_dns, dns_provider: row.dns_provider, provider_account_id: row.provider_account_id,
      remote_id: row.remote_id, dns_state_known: row.dns_state_known };
    return result;
  });
}
export interface SyncRunOptions {
  queue?: SyncWorkQueue;
  signal?: AbortSignal;
  timeoutMs?: number;
  schedule?: (delaySeconds: number) => Promise<void>;
  webhookUrl?: string;
  webhookType?: WebhookType;
}

async function executeSlice(db: DatabaseManager, queue: SyncWorkQueue, work: SyncWork, signal: AbortSignal, options: SyncRunOptions) {
  const auth = await db.firstRaw<{ provider: string; api_key: string; api_secret: string }>("SELECT provider,api_key,api_secret FROM accounts WHERE id=?", [work.account_id]);
  if (!auth) throw new NotFoundError("同步账号已删除");
  if (await credentialFingerprint(auth) !== work.fingerprint) throw new ValidationError("账号凭据已改变，请重试以重新建立同步快照");
  const { client, provider } = await db.getClientForAccount(work.account_id);
  client.requestSignal = signal;
  const cursor = JSON.parse(work.cursor) as SyncCursor;
  const guard = () => queue.guard(work);
  const active = () => { if (signal.aborted) throw signal.reason; };
  if (provider === "custom") { await queue.checkpoint(work, { phase: "skipped", total: 0 }); return "completed" as const; }
  if (cursor.phase === "start") {
    await queue.begin(work, client instanceof CloudflareClient ? "cf" : client instanceof DNSHEClient ? "list" : "collect");
    // Quota is auxiliary. Commit the domain checkpoint first so a quota timeout
    // cannot keep an otherwise healthy account permanently at the first step.
    if (client instanceof DNSHEClient) {
      const cached = await db.getCache("api_cache:quota");
      if (cached) {
        let value: unknown;
        try { value = JSON.parse(cached); } catch { value = null; }
        if (Array.isArray(value)) {
          let entry: Record<string, unknown>;
          try {
            const quota = await client.getQuota();
            entry = quota.success ? { account_id: work.account_id, alias: work.alias, ...quota.quota }
              : { account_id: work.account_id, alias: work.alias, error: quota.message || "配额读取失败" };
          } catch { entry = { account_id: work.account_id, alias: work.alias, error: "配额请求失败，请手动刷新" }; }
          active();
          const fence = guard();
          await queue.checkpoint(work, JSON.parse(work.cursor) as SyncCursor, [
            queue.statement(`UPDATE cache SET value=(SELECT json_group_array(json(value)) FROM
              (SELECT value FROM json_each(cache.value) WHERE json_extract(value,'$.account_id')<>? UNION ALL SELECT ?))
              WHERE key='api_cache:quota' AND ${fence.sql}`, [work.account_id, JSON.stringify(entry), ...fence.bindings]),
          ]);
        }
      }
    }
    return "queued" as const;
  }
  if (cursor.phase === "cf" && client instanceof CloudflareClient) {
    const page = await syncCloudflareSlice(db, work.account_id, client, 1, guard());
    active();
    await queue.checkpoint(work, { phase: page.completed ? "done" : "cf", page: page.nextPage, total: page.totalSynced });
    return page.completed ? "completed" as const : "queued" as const;
  }
  if (cursor.phase === "collect") {
    const rows = client instanceof DigitalPlatClient ? (await client.listDomains()).map(mapDomainToUpstream) : await listUpstreamDomains(client);
    active();
    if (rows.length > 10000) throw new ValidationError("上游列表超过单账号 10,000 行预算");
    const normalized = normalizeDomains(rows);
    if (JSON.stringify(normalized).length > 1024 * 1024) throw new ValidationError("该服务商全量列表超过 1MB 检查点预算，请缩小 Token 范围");
    await queue.checkpoint(work, { phase: "stage", rows: normalized, offset: 0, total: rows.length });
    return "queued" as const;
  }
  if (cursor.phase === "stage") {
    const rows = cursor.rows || [], offset = cursor.offset || 0, chunk = rows.slice(offset, offset + 25);
    const done = offset + chunk.length >= rows.length;
    await queue.stage(work, chunk, done ? { phase: "write", total: rows.length } : { ...cursor, offset: offset + chunk.length }, true);
    return "queued" as const;
  }
  if (cursor.phase === "list" && client instanceof DNSHEClient) {
    const page = cursor.page || 1;
    const response = await client.listSubdomains(page, 25);
    active();
    if (response.success !== true || !Array.isArray(response.subdomains) || response.subdomains.length > 25) throw new ValidationError("DNSHE 分页响应不完整或不支持请求的分页大小");
    const rows = normalizeDomains(response.subdomains);
    const total = (cursor.total || 0) + rows.length;
    if (response.total !== undefined && (!Number.isSafeInteger(response.total) || response.total < total)) throw new ValidationError("上游分页总数不一致");
    const expected = response.total ?? cursor.expectedTotal;
    if (cursor.expectedTotal !== undefined && expected !== cursor.expectedTotal) throw new ValidationError("上游列表在分页期间变化，请重新建立同步快照");
    const done = rows.length < 25 || (expected !== undefined && total === expected);
    if (done && expected !== undefined && total !== expected) throw new ValidationError("上游列表尚未完整，不允许执行差集清理");
    await queue.stage(work, rows, { phase: done ? "dns" : "list", page: page + 1, total, expectedTotal: expected }, false);
    return "queued" as const;
  }
  if (cursor.phase === "dns" && client instanceof DNSHEClient) {
    const rows = await queue.pendingRecords(work);
    if (!rows.length) { await queue.checkpoint(work, { phase: "write", total: cursor.total }); return "queued" as const; }
    const cached = work.scheduled && await db.getSetting("cfg_dns_records_cache_mode") !== "always"
      ? await db.getDnsRecordsCacheBatch(rows.map(row => row.domain_id)) : new Map<number, unknown[]>();
    const results = await Promise.all(rows.map(async row => {
      try {
        const response = cached.has(row.domain_id) ? { success: true, records: cached.get(row.domain_id)! } : await client.listDnsRecords(row.domain_id);
        if (response.success !== true || !Array.isArray(response.records)) throw new Error("解析记录结果未知");
        if (response.records.some(record => !record || typeof record !== "object" || !("type" in record) || typeof record.type !== "string")) throw new Error("解析记录格式未知");
        return { row, records: response.records as Array<{ type?: string; content?: unknown }>, error: null };
      } catch (error) {
        if (error instanceof UpstreamRateLimitError) throw error;
        return { row, records: null, error: error instanceof Error ? error.message : "解析查询失败" };
      }
    }));
    active();
    const statements: D1PreparedStatement[] = [];
    for (const result of results) {
      const row = JSON.parse(result.row.payload) as UpstreamSubdomain, fence = guard();
      const attempts = result.row.dns_attempts + 1;
      if (result.records) {
        const payload = { ...row, ...computeDnsState(result.records) };
        statements.push(queue.statement(`INSERT INTO cache(key,value,expires_at) SELECT ?,?,? WHERE ${fence.sql}
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at`,
          [`api_cache:dns:${row.id}`, JSON.stringify(result.records), Math.floor(Date.now() / 1000) + 366 * 86400, ...fence.bindings]));
        statements.push(queue.statement(`UPDATE sync_rows SET payload=?,enriched=1,error=NULL,dns_attempts=? WHERE job_id=? AND domain_id=? AND ${fence.sql}`,
          [JSON.stringify(payload), attempts, work.id, row.id, ...fence.bindings]));
      } else statements.push(queue.statement(`UPDATE sync_rows SET enriched=?,error=?,dns_attempts=? WHERE job_id=? AND domain_id=? AND ${fence.sql}`,
        [attempts >= 3 ? 1 : 0, result.error, attempts, work.id, row.id, ...fence.bindings]));
    }
    await queue.checkpoint(work, { ...cursor, checked: (cursor.checked || 0) +
      results.filter(result => result.records || result.row.dns_attempts + 1 >= 3).length }, statements);
    return "queued" as const;
  }
  if (cursor.phase === "write") {
    await queue.writeDomains(work, { phase: "renew", total: cursor.total });
    return "queued" as const;
  }
  if (cursor.phase === "renew" && client instanceof DNSHEClient && work.renew) {
    const enabled = await db.getSetting("cfg_auto_renew") !== "0";
    const threshold = Math.max(1, Number(await db.getSetting("cfg_renew_threshold_days")) || 90);
    const pending = await db.firstRaw<{ domain_id: number; payload: string; renew_state: string }>(
      `SELECT domain_id,payload,renew_state FROM sync_rows WHERE job_id=? AND renew_state IN ('none','attempting')
      AND (renew_state='attempting' OR (?=1 AND julianday(json_extract(payload,'$.expires_at'))-julianday('now') BETWEEN 0 AND ?))
      ORDER BY domain_id LIMIT 1`, [work.id, enabled ? 1 : 0, threshold]);
    if (pending) {
      const sub = JSON.parse(pending.payload) as UpstreamSubdomain;
      const remaining = (Date.parse(sub.expires_at || "") - Date.now()) / 86400000;
      let state = "skipped", nextExpiry = "";
      const journal = await db.firstRaw<{ original_expiry: string; status: string; new_expiry: string | null }>(`SELECT original_expiry,status,new_expiry FROM sync_renew_journal
        WHERE account_id=? AND domain_id=? AND full_domain=? AND
          (status='attempting' OR (status='confirmed' AND julianday(original_expiry)=julianday(?))) LIMIT 1`,
        [work.account_id, sub.id, sub.full_domain, sub.expires_at || ""]);
      if (pending.renew_state === "attempting" || journal || (enabled && remaining >= 0 && remaining <= threshold)) {
        state = "done";
        if (journal?.status === "confirmed" && Date.parse(journal.new_expiry || "") > Date.parse(journal.original_expiry)) {
          nextExpiry = journal.new_expiry!;
        } else if (pending.renew_state === "none" && !journal) {
          const fence = guard();
          await queue.checkpoint(work, cursor, [
            queue.statement(`INSERT INTO sync_renew_journal(account_id,domain_id,full_domain,original_expiry,status,updated_at,request_token)
              SELECT ?,?,?,?,'attempting',?,? WHERE ${fence.sql} ON CONFLICT DO UPDATE SET
                status='attempting',updated_at=excluded.updated_at,request_token=excluded.request_token
                WHERE sync_renew_journal.status='failed'`,
              [work.account_id, sub.id, sub.full_domain, sub.expires_at || "", Date.now(), work.lease_token, ...fence.bindings]),
            queue.statement(`UPDATE sync_rows SET renew_state='attempting' WHERE job_id=? AND domain_id=? AND ${fence.sql}`,
              [work.id, sub.id, ...fence.bindings]),
          ]);
          active();
          const claimed = await db.firstRaw<{ request_token: string }>(`SELECT request_token FROM sync_renew_journal
            WHERE account_id=? AND domain_id=? AND full_domain=? AND original_expiry=? AND status='attempting'`,
            [work.account_id, sub.id, sub.full_domain, sub.expires_at || ""]);
          if (claimed?.request_token !== work.lease_token) return "queued" as const;
          const response = await client.renewSubdomain(sub.id);
          active();
          if (response.success && Date.parse(response.new_expires_at || "") > Date.parse(sub.expires_at || "")) nextExpiry = response.new_expires_at!;
          else if (response.success) return "queued" as const; // retain the ambiguous write marker for read-only reconciliation
          else if (/not.yet.available|renewal_not_yet_available/i.test(response.message || "")) state = "deferred";
          else state = "failed";
        } else {
          // Never blindly repeat a possibly successful renewal POST after a crash.
          const response = await client.getSubdomain(sub.id);
          active();
          if (response.success && Date.parse(response.subdomain?.expires_at || "") > Date.parse(journal?.original_expiry || sub.expires_at || "")) nextExpiry = response.subdomain!.expires_at!;
          else throw new Error("续期结果尚未确认，只读核对中；不会重复发送续期请求");
        }
      }
      const fence = guard();
      const statements = [queue.statement(`UPDATE sync_rows SET renew_state=? WHERE job_id=? AND domain_id=? AND ${fence.sql}`,
        [state, work.id, sub.id, ...fence.bindings])];
      statements.push(queue.statement(`UPDATE sync_renew_journal SET status=?,updated_at=?,new_expiry=COALESCE(?,new_expiry)
        WHERE account_id=? AND domain_id=? AND full_domain=? AND status='attempting' AND ${fence.sql}`,
        [nextExpiry ? "confirmed" : state === "failed" || state === "deferred" ? "failed" : "attempting",
          Date.now(), nextExpiry || null, work.account_id, sub.id, sub.full_domain, ...fence.bindings]));
      if (nextExpiry) statements.push(queue.statement(`UPDATE domains_cache SET expires_at=?,last_renewed_at=CURRENT_TIMESTAMP
        WHERE id=? AND account_id=? AND ${fence.sql}`, [nextExpiry, sub.id, work.account_id, ...fence.bindings]));
      await queue.checkpoint(work, cursor, statements);
      return "queued" as const;
    }
  }
  if (cursor.phase === "renew") {
    await queue.checkpoint(work, { phase: work.renew ? "notify" : "done", total: cursor.total });
    return "queued" as const;
  }
  if (cursor.phase === "notify") {
    const renewals = await db.firstRaw<{ failed: number; count: number }>(
      "SELECT SUM(renew_state='failed') failed,COUNT(*) count FROM sync_rows WHERE job_id=? AND renew_state IN ('done','failed','deferred')", [work.id]);
    const statements: D1PreparedStatement[] = [];
    if (renewals?.count) {
      const cfg = await db.getAllAppSettings();
      const text = `【域名同步与续期报告】账号 [${work.alias}]：同步 ${cursor.total || 0} 个域名；续期失败 ${renewals.failed || 0} 个。`;
      statements.push(...await db.notificationOutbox().prepare([{ key: `sync-renew:${work.id}`, message: text }],
        notificationTargets(cfg, options), guard));
    }
    active();
    // A cancelled/expired sync executor cannot enqueue or advance the checkpoint.
    await queue.checkpoint(work, { phase: "done", total: cursor.total }, statements);
    return "queued" as const;
  }
  if (cursor.phase === "done") {
    const failed = await db.firstRaw<{ n: number }>("SELECT COUNT(*) n FROM sync_rows WHERE job_id=? AND (error IS NOT NULL OR renew_state IN ('failed','attempting'))", [work.id]);
    return failed?.n ? "failed" as const : "completed" as const;
  }
  throw new ValidationError("同步检查点状态不支持，请重新同步");
}

/** Exactly one bounded slice. Progress does not depend on a live HTTP caller. */
export async function runOneSyncSlice(db: DatabaseManager, options: SyncRunOptions = {}) {
  const queue = options.queue || db.syncQueue();
  await queue.recover();
  if (options.signal?.aborted) return null;
  const work = await queue.claim();
  if (!work) {
    if (options.schedule) {
      const pending = await queue.nextWake();
      if (pending?.due != null) await options.schedule(Math.min(86400, Math.max(1, Math.ceil((pending.due - Date.now()) / 1000))));
    }
    return null;
  }
  await queue.refreshActions();
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("同步执行已中断或超时", "AbortError"));
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs ?? 12000);
  let rejectAbort!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const status = await Promise.race([executeSlice(db, queue, work, controller.signal, options), interrupted]);
    await queue.finish(work, status, status === "failed" ? "部分解析状态或续期结果未确认，请查看日志并重试" : null);
  } catch (error) {
    const terminal = error instanceof ValidationError || error instanceof NotFoundError;
    const delay = error instanceof UpstreamRateLimitError ? Math.min(86400000, Math.max(1200, Number(error.retryAfter || 60) * 1000))
      : error instanceof ConflictError ? 60000 : Math.min(300000, 5000 * 2 ** work.failures);
    await queue.finish(work, terminal ? "failed" : "queued", error instanceof Error ? error.message.slice(0, 500) : "同步失败",
      delay, !terminal && !options.signal?.aborted);
  } finally {
    clearTimeout(timer); controller.signal.removeEventListener("abort", onAbort);
    options.signal?.removeEventListener("abort", abort);
  }
  if (options.schedule) {
    const pending = await queue.nextWake();
    if (pending?.due !== null && pending?.due !== undefined) {
      try { await options.schedule(Math.min(86400, Math.max(1, Math.ceil((pending.due - Date.now()) / 1000)))); }
      catch (error) { console.error("同步消息唤醒失败；持久任务将由周期执行器接管", error); }
    }
  }
  return work.id;
}
