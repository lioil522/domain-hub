import { sha256Hex } from "../db/crypto";
import { InvocationBudgetError } from "./invocation-budget";
import { ProviderApiError } from "../errors/provider-api-error";
import type { ProviderRequestLease, ProviderRequestScheduler } from "./provider-request-scheduler";
import { CoordinationDeadline, COORDINATION_TIMEOUT_MS, validateCoordinationTimeout } from "./coordination-deadline";

export const DNSHE_WINDOW_MS = 60_000;
export const DNSHE_WINDOW_CAP = 30;
export const DNSHE_QUEUE_WAIT_MS = 65_000;

type State = { owner: string; leaseUntil: number; events: number[] };
// Only bounded, well-typed state may be reused. Corruption is not an empty budget.
// Node SQLite binds Number as REAL: old json_set claims can contain integral
// REAL leases. Match Number.isSafeInteger, not the JSON spelling; never truncate
// fractional/unsafe stored state or replace its rolling history with an empty lane.
const validState = `CASE WHEN json_valid(cache.value) AND length(cache.value) <= 4096 THEN
  json_type(cache.value, '$.owner') = 'text' AND json_type(cache.value, '$.leaseUntil') IN ('integer', 'real')
  AND json_extract(cache.value, '$.leaseUntil') BETWEEN 0 AND 9007199254740991
  AND json_extract(cache.value, '$.leaseUntil') = CAST(json_extract(cache.value, '$.leaseUntil') AS INTEGER)
  AND json_type(cache.value, '$.events') = 'array' AND json_array_length(cache.value, '$.events') <= 30
  AND NOT EXISTS (SELECT 1 FROM json_each(cache.value, '$.events')
    WHERE type <> 'integer' OR value < 0 OR value > 9007199254740991) ELSE 0 END`;
const validTime = `value <> '' AND (value NOT GLOB '*[^0-9]*' OR
  (length(value) > 2 AND substr(value, -2) = '.0' AND substr(value, 1, length(value)-2) NOT GLOB '*[^0-9]*'))
  AND CAST(value AS INTEGER) <= 9007199254740991`;

/** Independent credential lanes, not a deployment-wide semaphore.
 * One active attempt/key; at most 30 dispatch authorizations in any rolling 60s.
 * The DB owns all state. Local callers only wait, never reserve a future send.
 * DNSHE login identity is unavailable: different keys are NOT automatically grouped.
 */
export class DnsheAccountRequestScheduler implements ProviderRequestScheduler {
  readonly scope = "dnshe_key" as const;
  private readonly keys: Promise<{ state: string; blocked: string[]; legacy: string }>;
  constructor(private readonly db: D1Database, apiKey: string,
    private readonly clock?: () => number,
    private readonly sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    private readonly coordinationTimeoutMs = COORDINATION_TIMEOUT_MS,
    private readonly queueWaitMs = DNSHE_QUEUE_WAIT_MS) {
    validateCoordinationTimeout(coordinationTimeoutMs);
    validateCoordinationTimeout(queueWaitMs);
    this.keys = sha256Hex(apiKey).then(hash => ({ state: `dnshe_queue:v1:${hash}`,
      blocked: [`dnshe_queue:v1:${hash}:blocked`, `dnshe_budget:${hash}:blocked`, "provider_scheduler:v1:dnshe:blocked"],
      legacy: `dnshe_budget:${hash}` }));
  }

  async acquire(timeoutMs: number, signal?: AbortSignal | null): Promise<ProviderRequestLease> {
    validateCoordinationTimeout(timeoutMs);
    const end = this.now() + this.queueWaitMs;
    const monotonicEnd = performance.now() + this.queueWaitMs;
    const owner = crypto.randomUUID();
    let held = false;
    let stateKey = "";
    try {
      const keys = await this.deadline("acquire", false).run(() => this.keys);
      stateKey = keys.state;
      const blockedSql = `SELECT 1 FROM cache WHERE key IN (?, ?, ?) AND
        (NOT (${validTime}) OR CAST(value AS INTEGER) > ?)`;
      while (true) {
        this.check(signal, end, monotonicEnd);
        const phase = this.deadline("acquire", false);
        const now = await this.dbNow(phase);
        const leaseUntil = now + this.queueWaitMs + timeoutMs + this.coordinationTimeoutMs + 5000;
        await this.checkCooldown(keys.blocked, phase, now);
        const row = await phase.run(() => this.db.prepare(`INSERT INTO cache(key,value,expires_at) VALUES(?,?,?)
          ON CONFLICT(key) DO UPDATE SET value = json_set(cache.value, '$.owner', ?, '$.leaseUntil', CAST(? AS INTEGER)), expires_at = excluded.expires_at
          WHERE (${validState}) AND json_extract(cache.value, '$.leaseUntil') <= ? RETURNING value`)
          .bind(keys.state, JSON.stringify({ owner, leaseUntil, events: [] }), Math.ceil(leaseUntil / 1000) + 3600,
            owner, leaseUntil, now).first<{ value: string }>(), async late => {
          if (late && this.parse(late.value).owner === owner) await this.release(keys.state, owner, false);
        });
        if (!row) {
          const current = await phase.run(() => this.db.prepare("SELECT value FROM cache WHERE key=?")
            .bind(keys.state).first<{ value: string }>());
          if (!current) throw this.unavailable(false);
          this.parse(current.value);
          await this.wait(10_000, signal, end, monotonicEnd);
          continue;
        }
        held = true;
        const state = this.parse(row.value);
        if (state.owner !== owner) throw this.unavailable(false);
        // An old deployment's last reservation does not contain rolling history.
        // Drain it for a full minute on first use; never clear its budget/cooldown.
        const legacy = await phase.run(() => this.db.prepare("SELECT value FROM cache WHERE key=?")
          .bind(keys.legacy).first<{ value: string }>());
        const drainUntil = state.events.length === 0 && legacy ? this.time(legacy.value) + DNSHE_WINDOW_MS + 1 : 0;
        while (true) {
          this.check(signal, end, monotonicEnd);
          const commit = this.deadline("dispatch", false);
          await this.checkCooldown(keys.blocked, commit);
          const dispatchStart = performance.now();
          const at = await this.dbNow(commit);
          const events = state.events.filter(expires => expires > at);
          const wait = Math.max(drainUntil - at, events.length >= DNSHE_WINDOW_CAP ? Math.min(...events) - at : 0);
          if (wait > 0) {
            // Production DB time advances in whole seconds. A +1ms expiry must
            // not trigger many 1ms sleeps and three new SQL calls each time.
            // Only round WAITING upward; never shorten the authoritative window.
            await this.wait(this.clock ? wait : Math.ceil(wait / 1000) * 1000, signal, end, monotonicEnd);
            continue;
          }
          // External fetch and SQL cannot be atomic. Count even cancelled/late
          // authorizations, retaining them until 60s AFTER the latest allowed send.
          // This conservatively bounds actual sends even when SQL resolves slowly.
          // Production timestamps come from the DB, not clocks on different
          // Node hosts. Add one second for SQLite's whole-second clock rounding.
          const dispatchBy = at + this.coordinationTimeoutMs + 1000;
          events.push(dispatchBy + DNSHE_WINDOW_MS + 1);
          const next = JSON.stringify({ owner, leaseUntil, events });
          const committed = await commit.run(() => this.db.prepare(`UPDATE cache SET value=?, expires_at=?
            WHERE key=? AND value=? AND json_extract(value, '$.leaseUntil') > ?
              AND NOT EXISTS (${blockedSql}) RETURNING value`)
            .bind(next, Math.ceil(Math.max(leaseUntil, ...events) / 1000) + 3600, keys.state, row.value, at,
              ...keys.blocked, at).first<{ value: string }>());
          if (!committed || committed.value !== next) {
            await this.checkCooldown(keys.blocked, commit);
            throw this.unavailable(false);
          }
          this.check(signal, end, monotonicEnd);
          let released = false;
          let sent = false;
          const lease: ProviderRequestLease = {
            assertReady: () => {
              this.check(signal, end, monotonicEnd);
              if (released || sent || performance.now() > dispatchStart + this.coordinationTimeoutMs ||
                (this.clock && this.now() > dispatchBy)) throw this.unavailable(false);
              sent = true;
            },
            release: async () => { await this.release(keys.state, owner, sent); released = true; },
          };
          // No asynchronous work follows this return before the transport check.
          held = false;
          return lease;
        }
      }
    } catch (error) {
      if (held) { try { await this.release(stateKey, owner, false); } catch { /* original failure wins; persistent lease expiry recovers */ } }
      if (error instanceof InvocationBudgetError) throw error.withRequestOutcome(false);
      if (error instanceof ProviderApiError) throw error;
      throw this.unavailable(false);
    }
  }

  async block(milliseconds: number): Promise<void> {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw this.unavailable(true);
    try {
      const phase = this.deadline("block", true);
      const keys = await phase.run(() => this.keys);
      const until = await this.dbNow(phase) + Math.max(1000, milliseconds) + 1000;
      if (!Number.isSafeInteger(until)) throw this.unavailable(true);
      const row = await phase.run(() => this.db.prepare(`INSERT INTO cache(key,value,expires_at) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(cache.value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT),
          expires_at=MAX(cache.expires_at,excluded.expires_at) WHERE ${validTime} RETURNING value`)
        .bind(keys.blocked[0], String(until), Math.ceil(until / 1000) + 3600).first<{ value: string }>());
      if (!row || this.time(row.value) < until) throw this.unavailable(true);
    } catch (error) {
      if (error instanceof InvocationBudgetError) throw error.withRequestOutcome("unknown");
      if (error instanceof ProviderApiError) throw error;
      throw this.unavailable(true);
    }
  }

  private async release(key: string, owner: string, sent: boolean): Promise<void> {
    try {
      const result = await this.deadline("release", sent).run(() => this.db.prepare(`UPDATE cache
        SET value=json_set(value, '$.owner', '', '$.leaseUntil', 0)
        WHERE key=? AND json_extract(value, '$.owner')=?`).bind(key, owner).run());
      if (!result.success) throw this.unavailable(sent);
    } catch (error) {
      if (error instanceof InvocationBudgetError) throw error.withRequestOutcome(sent ? "unknown" : false);
      if (error instanceof ProviderApiError) throw error;
      throw this.unavailable(sent);
    }
  }

  private async checkCooldown(keys: string[], phase: CoordinationDeadline, at?: number): Promise<void> {
    const now = at ?? await this.dbNow(phase);
    const rows = await phase.run(() => this.db.prepare("SELECT key,value FROM cache WHERE key IN (?, ?, ?)").bind(...keys).all<{ key: string; value: string }>());
    if (!rows.success) throw this.unavailable(false);
    const until = Math.max(0, ...rows.results.map(row => this.time(row.value)));
    if (until > now) {
      const shared = rows.results.some(row => row.key === keys[2] && this.time(row.value) > now);
      throw new ProviderApiError("dnshe", 429, "scheduler_cooldown", "DNSHE 冷却尚未结束；本次请求未发送",
        { scope: shared ? "deployment_provider" : "dnshe_key", request_sent: false }, until - now);
    }
  }

  private parse(value: string): State {
    const state = JSON.parse(value) as State;
    if (value.length > 4096 || typeof state.owner !== "string" || !Number.isSafeInteger(state.leaseUntil) || state.leaseUntil < 0 ||
      !Array.isArray(state.events) || state.events.length > DNSHE_WINDOW_CAP || state.events.some(n => !Number.isSafeInteger(n) || n < 0)) throw this.unavailable(false);
    return state;
  }
  private time(value: string): number {
    if (!/^\d+(?:\.0)?$/.test(value) || !Number.isSafeInteger(Number(value))) throw this.unavailable(false);
    return Number(value);
  }
  private now(): number { return this.clock?.() ?? Date.now(); }
  private async dbNow(phase: CoordinationDeadline): Promise<number> {
    if (this.clock) return this.clock(); // Deterministic offline simulation only.
    const row = await phase.run(() => this.db.prepare("SELECT CAST(strftime('%s','now') AS INTEGER)*1000 AS now").first<{ now: number }>());
    if (!row || !Number.isSafeInteger(row.now) || row.now < 0) throw this.unavailable(false);
    return row.now;
  }
  private check(signal: AbortSignal | null | undefined, end: number, monotonicEnd: number): void {
    if (signal?.aborted) throw new ProviderApiError("dnshe", 502, "request_cancelled", "DNSHE 排队已取消；本次请求未发送", { request_sent: false });
    if (this.now() >= end || performance.now() >= monotonicEnd) throw new ProviderApiError("dnshe", 429, "rate_limited", "DNSHE 当前凭据排队等待超时；本次请求未发送",
      { scope: "dnshe_key", request_sent: false }, 1000);
  }
  private async wait(ms: number, signal: AbortSignal | null | undefined, end: number, monotonicEnd: number): Promise<void> {
    // Bounded slices make cancellation observable; no unbounded fan-out in one invocation.
    let remaining = Math.min(ms, end - this.now());
    while (remaining > 0) {
      this.check(signal, end, monotonicEnd);
      const slice = Math.min(remaining, 1000);
      await this.sleep(slice);
      remaining -= slice;
    }
    this.check(signal, end, monotonicEnd);
  }
  private deadline(operation: string, sent: boolean): CoordinationDeadline {
    return new CoordinationDeadline(this.coordinationTimeoutMs, () => new ProviderApiError("dnshe", 502, "scheduler_timeout",
      "DNSHE 凭据调度协调超时；在途 SQL 未撤销，不会自动重试", { scope: "dnshe_key", request_sent: sent ? "unknown" : false,
        coordination_operation: operation, coordination_timeout_ms: this.coordinationTimeoutMs,
        ...(operation === "block" ? { cooldown_persisted: "unknown" } : {}) }));
  }
  private unavailable(sent: boolean): ProviderApiError {
    return new ProviderApiError("dnshe", 502, "scheduler_unavailable", "DNSHE 凭据调度状态不可用；不会自动重试",
      { scope: "dnshe_key", request_sent: sent ? "unknown" : false });
  }
}
