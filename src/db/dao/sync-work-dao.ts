import { ConflictError, ValidationError, NotFoundError } from "../../errors";
import { canonicalJson } from "../../../shared/restore-wire";
import { sha256Hex } from "../crypto";
import type { UpstreamSubdomain } from "../types";
import { buildDomainJsonUpsert } from "./domain-dao";

export const SYNC_LEASE_MS = 90000;
export const SYNC_MAX_FAILURES = 5;
export interface SyncCursor {
  phase: string; page?: number; total?: number; expectedTotal?: number;
  rows?: UpstreamSubdomain[]; offset?: number; checked?: number;
}
export interface SyncWork {
  id: string; action_id: string; account_id: number; alias: string; fingerprint: string;
  renew: number; scheduled: number; status: string; cursor: string; failures: number;
  lease_token: string | null; lease_until: number; not_before: number; deadline_at: number; error: string | null;
}
export type SyncWorkOptions = { label: string; accountIds: number[]; renew?: boolean; scheduled?: boolean };
export const credentialFingerprint = (account: { provider: string; api_key: string; api_secret: string }) =>
  sha256Hex(canonicalJson([account.provider || "dnshe", account.api_key, account.api_secret]));

/** SQL-only work queue: no serialized callback, credential or session token. */
export class SyncWorkQueue {
  constructor(private readonly db: D1Database, private readonly now = Date.now) {}
  statement(sql: string, bindings: unknown[] = []) { return this.db.prepare(sql).bind(...bindings); }
  async nextWake() {
    return this.db.prepare("SELECT MIN(not_before) AS due FROM sync_work WHERE status='queued'").first<{ due: number | null }>();
  }

  async enqueue(options: SyncWorkOptions): Promise<string> {
    const ids = [...new Set(options.accountIds)].sort((a, b) => a - b);
    if (!ids.length || ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new ValidationError("同步任务需要 1–500 个有效账号 ID");
    const accounts = await this.db.prepare("SELECT id,alias,provider,api_key,api_secret FROM accounts WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(ids)).all<{ id: number; alias: string; provider: string; api_key: string; api_secret: string }>();
    if (accounts.results.length !== ids.length) throw new NotFoundError("部分账号已删除，未创建同步任务");
    const fingerprints = await Promise.all(accounts.results.map(async account => ({ id: account.id, fingerprint: await credentialFingerprint(account) })));
    await this.db.prepare(`UPDATE sync_work SET status='cancelled',lease_token=NULL,lease_until=0,error='账号凭据改变，旧同步已取消',updated_at=?
      WHERE status IN ('queued','running','paused') AND account_id IN(SELECT json_extract(value,'$.id') FROM json_each(?))
      AND fingerprint<>(SELECT json_extract(value,'$.fingerprint') FROM json_each(?) WHERE json_extract(value,'$.id')=sync_work.account_id)`)
      .bind(this.now(), JSON.stringify(fingerprints), JSON.stringify(fingerprints)).run();
    await this.refreshActions();
    const active = await this.db.prepare(`SELECT action_id,renew,scheduled FROM sync_work WHERE account_id IN (SELECT value FROM json_each(?))
      AND status IN ('queued','running','paused')`).bind(JSON.stringify(ids)).all<{ action_id: string; renew: number; scheduled: number }>();
    if (active.results.length) {
      const actions = [...new Set(active.results.map(row => row.action_id))];
      if (actions.length === 1) {
        const existing = await this.db.prepare("SELECT account_id FROM sync_work WHERE action_id=? ORDER BY account_id")
          .bind(actions[0]).all<{ account_id: number }>();
        if (canonicalJson(existing.results.map(row => row.account_id)) === canonicalJson(ids) &&
            active.results.every(row => row.renew === (options.renew ? 1 : 0) && row.scheduled === (options.scheduled ? 1 : 0))) return actions[0];
      }
      throw new ConflictError("部分账号已有排队、运行或暂停任务，请在操作中心继续或取消原任务", "sync_in_progress");
    }
    const actionId = crypto.randomUUID(), now = this.now();
    const jobs = await Promise.all(accounts.results.map(async account => ({
      id: crypto.randomUUID(), account_id: account.id, alias: account.alias, fingerprint: await credentialFingerprint(account),
    })));
    try {
      await this.db.batch([
        this.db.prepare(`INSERT INTO actions(id,type,status,progress,started_at,metadata) VALUES(?,'sync','queued',0,?,?)`)
          .bind(actionId, new Date(now).toISOString(), JSON.stringify({ label: options.label, accountIds: ids,
            renew: options.renew === true, scheduled: options.scheduled === true, durable: true })),
        this.db.prepare(`INSERT INTO sync_work(id,action_id,account_id,alias,fingerprint,renew,scheduled,status,cursor,deadline_at,created_at,updated_at)
          SELECT json_extract(value,'$.id'),?,json_extract(value,'$.account_id'),json_extract(value,'$.alias'),
            json_extract(value,'$.fingerprint'),?,?,'queued','{"phase":"start"}',?,?,? FROM json_each(?)`)
          .bind(actionId, options.renew ? 1 : 0, options.scheduled ? 1 : 0, now + 86400000, now, now, JSON.stringify(jobs)),
      ]);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint/i.test(error.message)) throw new ConflictError("账号同步创建竞争，请查看已有任务", "sync_in_progress");
      throw error;
    }
    return actionId;
  }

  async recover(): Promise<void> {
    const now = this.now();
    await this.db.batch([
      this.db.prepare(`UPDATE sync_work SET status=CASE WHEN failures+1>=? THEN 'failed' ELSE 'queued' END,
        failures=failures+1,lease_token=NULL,lease_until=0,not_before=?,updated_at=?,error='执行租约过期，已从最后提交检查点回收'
        WHERE status='running' AND lease_until<=?`).bind(SYNC_MAX_FAILURES, now, now, now),
      this.db.prepare(`UPDATE sync_work SET status='failed',lease_token=NULL,lease_until=0,updated_at=?,error='任务超过 24 小时执行期限，请检查上游并重试'
        WHERE status IN ('queued','running','paused') AND deadline_at<=?`).bind(now, now),
      this.db.prepare(`UPDATE actions SET status='failed',finished_at=?,error='旧同步任务没有持久执行器且已失联；请重试或在对应页面重新同步'
        WHERE type='sync' AND status IN ('queued','running')
        AND NOT EXISTS(SELECT 1 FROM sync_work WHERE action_id=actions.id)
        AND COALESCE(julianday(updated_at),julianday(started_at),0)<julianday(?)-15.0/1440`)
        .bind(new Date(now).toISOString(), new Date(now).toISOString()),
    ]);
    const cleanup = await this.db.prepare(`INSERT INTO cache(key,value,expires_at) VALUES('sync_queue_cleanup','1',?)
      ON CONFLICT(key) DO UPDATE SET expires_at=excluded.expires_at WHERE cache.expires_at<=? RETURNING key`)
      .bind(Math.floor(now / 1000) + 3600, Math.floor(now / 1000)).first();
    if (cleanup && await this.db.prepare("SELECT id FROM sync_work WHERE status IN ('completed','failed','cancelled') LIMIT 1").first()) {
      await this.db.batch([
        this.db.prepare(`DELETE FROM sync_rows WHERE job_id IN(SELECT id FROM sync_work WHERE status IN ('completed','failed','cancelled') AND updated_at<?)`).bind(now - 86400000),
        this.db.prepare(`DELETE FROM sync_candidates WHERE job_id IN(SELECT id FROM sync_work WHERE status IN ('completed','failed','cancelled') AND updated_at<?)`).bind(now - 86400000),
        this.db.prepare(`UPDATE sync_work SET cursor=json_remove(cursor,'$.rows')
          WHERE status IN ('completed','failed','cancelled') AND updated_at<? AND json_valid(cursor)`).bind(now - 86400000),
      ]);
    }
    await this.refreshActions();
  }

  async claim(): Promise<SyncWork | null> {
    const now = this.now(), token = crypto.randomUUID();
    return this.db.prepare(`UPDATE sync_work SET status='running',lease_token=?,lease_until=?,updated_at=?
      WHERE id=(SELECT w.id FROM sync_work w JOIN actions a ON a.id=w.action_id
        WHERE w.status='queued' AND w.not_before<=? AND w.deadline_at>? AND a.status IN ('queued','running')
        ORDER BY w.updated_at,w.id LIMIT 1) AND status='queued' RETURNING *`)
      .bind(token, now + SYNC_LEASE_MS, now, now, now).first<SyncWork>();
  }
  guard(work: SyncWork) {
    return { sql: `EXISTS(SELECT 1 FROM sync_work WHERE id=? AND status='running' AND lease_token=? AND lease_until>?)`,
      bindings: [work.id, work.lease_token, this.now()] };
  }
  async checkpoint(work: SyncWork, cursor: SyncCursor, statements: D1PreparedStatement[] = []) {
    const guard = this.guard(work);
    const results = await this.db.batch([...statements, this.db.prepare(`UPDATE sync_work SET cursor=?,updated_at=?,failures=0 WHERE id=? AND ${guard.sql}`)
      .bind(JSON.stringify(cursor), this.now(), work.id, ...guard.bindings)]);
    if (results[results.length - 1].meta.changes !== 1) throw new ConflictError("同步租约已失效，未推进检查点", "sync_lease_expired");
    work.cursor = JSON.stringify(cursor);
    work.failures = 0;
  }
  async begin(work: SyncWork, phase: string) {
    const guard = this.guard(work);
    await this.checkpoint(work, { phase, page: 1, total: 0 }, [
      this.db.prepare(`DELETE FROM sync_rows WHERE job_id=? AND ${guard.sql}`).bind(work.id, ...guard.bindings),
      this.db.prepare(`DELETE FROM sync_candidates WHERE job_id=? AND ${guard.sql}`).bind(work.id, ...guard.bindings),
      this.db.prepare(`INSERT INTO sync_candidates(job_id,domain_id) SELECT ?,id FROM domains_cache WHERE account_id=? AND ${guard.sql}`)
        .bind(work.id, work.account_id, ...guard.bindings),
    ]);
  }
  async stage(work: SyncWork, rows: UpstreamSubdomain[], cursor: SyncCursor, enriched: boolean) {
    const guard = this.guard(work);
    if ((cursor.total || 0) > 10000) throw new ValidationError("单账号同步超过 10,000 行预算，未执行差集删除");
    await this.checkpoint(work, cursor, [
      this.db.prepare(`INSERT INTO sync_rows(job_id,domain_id,payload,enriched)
        SELECT ?,json_extract(value,'$.id'),value,? FROM json_each(?) WHERE ${guard.sql}`)
        .bind(work.id, enriched ? 1 : 0, JSON.stringify(rows), ...guard.bindings),
    ]);
  }
  async pendingRecords(work: SyncWork) {
    return (await this.db.prepare("SELECT domain_id,payload,dns_attempts FROM sync_rows WHERE job_id=? AND enriched=0 ORDER BY domain_id LIMIT 4")
      .bind(work.id).all<{ domain_id: number; payload: string; dns_attempts: number }>()).results;
  }
  async writeDomains(work: SyncWork, next: SyncCursor) {
    const guard = this.guard(work);
    await this.checkpoint(work, next, [
      buildDomainJsonUpsert(this.db, work.account_id, { from: "sync_rows r", json: "r.payload", where: "r.job_id=?",
        bindings: [work.id], known: { sql: "EXISTS(SELECT 1 FROM sync_rows WHERE job_id=? AND domain_id=excluded.id AND json_extract(payload,'$.dns_state_known')=1)",
          bindings: [work.id] } }, guard),
      this.db.prepare(`DELETE FROM domains_cache WHERE account_id=? AND id IN (SELECT domain_id FROM sync_candidates WHERE job_id=?)
        AND id NOT IN(SELECT domain_id FROM sync_rows WHERE job_id=?) AND ${guard.sql}`)
        .bind(work.account_id, work.id, work.id, ...guard.bindings),
    ]);
  }
  async finish(work: SyncWork, status: "queued" | "completed" | "failed", error: string | null = null, delayMs = 1200, failure = false) {
    const guard = this.guard(work), now = this.now();
    const failures = work.failures + (failure ? 1 : 0);
    if (failure && failures >= SYNC_MAX_FAILURES) status = "failed";
    await this.db.prepare(`UPDATE sync_work SET status=?,failures=?,error=?,lease_token=NULL,lease_until=0,not_before=?,updated_at=?
      WHERE id=? AND ${guard.sql}`).bind(status, failures, error, now + delayMs, now, work.id, ...guard.bindings).run();
    await this.refreshActions();
  }
  async refreshActions() {
    await this.db.prepare(`UPDATE actions SET
      status=CASE
        WHEN EXISTS(SELECT 1 FROM sync_work WHERE action_id=actions.id AND status='running') THEN 'running'
        WHEN EXISTS(SELECT 1 FROM sync_work WHERE action_id=actions.id AND status='queued') THEN 'queued'
        WHEN EXISTS(SELECT 1 FROM sync_work WHERE action_id=actions.id AND status='paused') THEN 'paused'
        WHEN EXISTS(SELECT 1 FROM sync_work WHERE action_id=actions.id AND status='failed') THEN 'failed'
        WHEN EXISTS(SELECT 1 FROM sync_work WHERE action_id=actions.id AND status='cancelled') THEN 'cancelled'
        ELSE 'completed' END,
      progress=COALESCE((SELECT 100*SUM(status='completed')/COUNT(*) FROM sync_work WHERE action_id=actions.id),0),
      error=CASE WHEN EXISTS(SELECT 1 FROM sync_work WHERE action_id=actions.id AND status='failed')
        THEN '部分账号同步失败，请查看逐账号结果并重试' ELSE NULL END,
      finished_at=CASE WHEN EXISTS(SELECT 1 FROM sync_work WHERE action_id=actions.id AND status IN ('queued','running','paused'))
        THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END,
      metadata=json_set(COALESCE(metadata,'{}'),'$.results',json(COALESCE((SELECT json_group_array(json_object(
        'accountId',account_id,'alias',alias,'status',status,'error',error,'phase',json_extract(cursor,'$.phase'),
        'nextPage',json_extract(cursor,'$.page'),'domainCount',json_extract(cursor,'$.total'),'retryAt',not_before
        ,'checked',json_extract(cursor,'$.checked')
        )) FROM sync_work WHERE action_id=actions.id),'[]'))),
      updated_at=CURRENT_TIMESTAMP
      WHERE type='sync' AND status IN ('queued','running','paused') AND EXISTS(SELECT 1 FROM sync_work WHERE action_id=actions.id)`).run();
  }
  async hasAction(id: string) {
    return !!await this.db.prepare("SELECT id FROM sync_work WHERE action_id=? LIMIT 1").bind(id).first();
  }
  async control(id: string, operation: "cancel" | "pause" | "retry") {
    if (!await this.hasAction(id)) throw new NotFoundError("任务没有持久同步工作项");
    const now = this.now();
    if (operation === "retry") {
      const rows = await this.db.prepare("SELECT id,account_id,status,fingerprint FROM sync_work WHERE action_id=?").bind(id)
        .all<{ id: string; account_id: number; status: string; fingerprint: string }>();
      if (rows.results.every(row => row.status === "completed")) throw new ConflictError("任务已经完成，请发起新同步");
      const accounts = await this.db.prepare("SELECT id,provider,api_key,api_secret FROM accounts WHERE id IN (SELECT account_id FROM sync_work WHERE action_id=?)")
        .bind(id).all<{ id: number; provider: string; api_key: string; api_secret: string }>();
      const fingerprints = await Promise.all(accounts.results.map(async account => ({ id: account.id, fingerprint: await credentialFingerprint(account) })));
      if (accounts.results.length !== rows.results.length) throw new NotFoundError("重试账号已删除");
      const resetIds = JSON.stringify(rows.results.filter(row => ["failed", "cancelled"].includes(row.status) ||
        row.fingerprint !== fingerprints.find(account => account.id === row.account_id)?.fingerprint).map(row => row.id));
      try {
        await this.db.batch([
          this.db.prepare("DELETE FROM sync_rows WHERE job_id IN(SELECT value FROM json_each(?))").bind(resetIds),
          this.db.prepare("DELETE FROM sync_candidates WHERE job_id IN(SELECT value FROM json_each(?))").bind(resetIds),
          this.db.prepare(`UPDATE sync_work SET cursor=CASE WHEN id IN(SELECT value FROM json_each(?)) THEN '{"phase":"start"}' ELSE cursor END,
            fingerprint=(SELECT json_extract(value,'$.fingerprint') FROM json_each(?) WHERE json_extract(value,'$.id')=sync_work.account_id),
            status='queued',failures=0,lease_token=NULL,lease_until=0,not_before=0,deadline_at=?,error=NULL,updated_at=?
            WHERE action_id=? AND status IN ('failed','cancelled','paused')`)
            .bind(resetIds, JSON.stringify(fingerprints), now + 86400000, now, id),
          this.db.prepare("UPDATE actions SET status='queued',error=NULL,finished_at=NULL WHERE id=? AND status IN ('failed','cancelled','paused')").bind(id),
        ]);
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint/i.test(error.message)) throw new ConflictError("该账号已有另一同步任务，请先取消或完成它", "sync_in_progress");
        throw error;
      }
    } else {
      await this.db.batch([
        this.db.prepare(`UPDATE sync_work SET status=?,lease_token=NULL,lease_until=0,updated_at=?
          WHERE action_id=? AND status IN ('queued','running','paused')`).bind(operation === "cancel" ? "cancelled" : "paused", now, id),
        this.db.prepare("UPDATE actions SET status=?,finished_at=? WHERE id=? AND status IN ('queued','running','paused')")
          .bind(operation === "cancel" ? "cancelled" : "paused", operation === "cancel" ? new Date(now).toISOString() : null, id),
      ]);
    }
    await this.refreshActions();
  }
  async jobs(id: string) { return (await this.db.prepare("SELECT * FROM sync_work WHERE action_id=?").bind(id).all<SyncWork>()).results; }
}
