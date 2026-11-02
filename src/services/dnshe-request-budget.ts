import { sha256Hex } from "../db/crypto";
import { ProviderApiError } from "../errors/provider-api-error";
import { CoordinationDeadline, COORDINATION_TIMEOUT_MS, validateCoordinationTimeout } from "./coordination-deadline";

export interface RequestBudget {
  reserve(): Promise<void>;
  block(milliseconds: number): Promise<void>;
}

// Previous SQLite reservations cast REAL arithmetic to TEXT (e.g. "5200.0").
// Accept only that exact integer suffix for upgrades, never arbitrary fractions.
const validStoredBudget = `cache.value <> '' AND (cache.value NOT GLOB '*[^0-9]*' OR
  (length(cache.value) > 2 AND substr(cache.value, -2) = '.0'
    AND substr(cache.value, 1, length(cache.value) - 2) NOT GLOB '*[^0-9]*'))
  AND CAST(cache.value AS INTEGER) <= 9007199254740991`;

/** D1-backed per-key budget, shared by requests, cron and all client instances. */
export class DnsheRequestBudget implements RequestBudget {
  private readonly key: Promise<string>;
  constructor(private readonly db: D1Database, apiKey: string,
    private readonly intervalMs = 2100,
    private readonly now = () => Date.now(),
    private readonly sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    private readonly coordinationTimeoutMs = COORDINATION_TIMEOUT_MS) {
    validateCoordinationTimeout(coordinationTimeoutMs);
    this.key = sha256Hex(apiKey).then(hash => `dnshe_budget:${hash}`);
  }

  async reserve(): Promise<void> {
    try {
      const deadline = this.deadline("reserve", false);
      const key = await deadline.run(() => this.key);
      const now = this.now();
      const maxWait = 4000;
      // The WHERE cap avoids an unbounded reservation queue when many requests arrive together.
      const row = await deadline.run(() => this.db.prepare(`INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(cache.value AS INTEGER), CAST(? AS INTEGER)) + CAST(? AS INTEGER) AS TEXT),
          expires_at = excluded.expires_at
        WHERE ${validStoredBudget} AND CAST(cache.value AS INTEGER) <= ?
        RETURNING value`).bind(key, String(now + this.intervalMs), Math.floor(now / 1000) + 3600,
        now, this.intervalMs, now + maxWait).first<{ value: string }>());
      if (!row) {
        const pending = await deadline.run(() => this.db.prepare("SELECT value FROM cache WHERE key = ?").bind(key).first<{ value: string }>());
        if (!pending || !this.validValue(pending.value)) throw this.unavailable(false);
        throw this.rateLimited(Math.max(this.intervalMs, Number(pending.value) - now));
      }
      if (!this.validValue(row.value)) throw this.unavailable(false);
      const wait = Math.max(0, Number(row.value) - this.intervalMs - this.now());
      if (wait > maxWait) throw this.rateLimited(wait);
      if (wait > 0) await this.sleep(wait);
      // A concurrent request may have received 429 while this reservation was waiting.
      // Planned reservation waiting is separate from DB coordination. Do not give
      // each SQL a fresh budget; only the post-wait phase gets a new deadline.
      const check = wait > 0 ? this.deadline("check", false) : deadline;
      const blocked = await check.run(() => this.db.prepare("SELECT value FROM cache WHERE key = ? AND expires_at > ?")
        .bind(`${key}:blocked`, Math.floor(this.now() / 1000)).first<{ value: string }>());
      if (blocked && !this.validValue(blocked.value)) throw this.unavailable(false);
      if (blocked && Number(blocked.value) > this.now()) throw this.rateLimited(Number(blocked.value) - this.now());
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw this.unavailable(false);
    }
  }

  async block(milliseconds: number): Promise<void> {
    try {
      const deadline = this.deadline("block", true);
      const key = await deadline.run(() => this.key);
      const until = this.now() + Math.max(0, milliseconds);
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || !Number.isSafeInteger(until)) throw this.unavailable(true);
      const statement = (cacheKey: string) => this.db.prepare(`INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(cache.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT),
        expires_at = MAX(cache.expires_at, excluded.expires_at)
        WHERE ${validStoredBudget}`)
        .bind(cacheKey, String(until), Math.ceil(until / 1000) + 3600);
      const results = await deadline.run(() => this.db.batch([statement(key), statement(`${key}:blocked`)]));
      if (results.length !== 2 || results.some(result => !result.success)) throw this.unavailable(true);
      // Verify within the SAME phase: both runtimes support batch writes, but
      // the SQLite adapter does not expose INSERT RETURNING rows from batch().
      for (const cacheKey of [key, `${key}:blocked`]) {
        const row = await deadline.run(() => this.db.prepare("SELECT value FROM cache WHERE key = ?").bind(cacheKey).first<{ value: string }>());
        if (!row || !this.validValue(row.value) || Number(row.value) < until) throw this.unavailable(true);
      }
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw this.unavailable(true);
    }
  }

  private validValue(value: string): boolean {
    return /^\d+(?:\.0)?$/.test(value) && Number.isSafeInteger(Number(value));
  }

  private unavailable(sent: boolean) {
    return new ProviderApiError("dnshe", 502, "budget_unavailable", `DNSHE 共享账号预算状态不可用；${sent
      ? "请求可能已发送，写入结果请先刷新核对，不会自动重试" : "本次请求未发送"}`, { scope: "dnshe_key", request_sent: sent ? "unknown" : false });
  }

  private deadline(operation: "reserve" | "check" | "block", sent: boolean) {
    return new CoordinationDeadline(this.coordinationTimeoutMs, () => new ProviderApiError("dnshe", 502, "budget_timeout",
      `DNSHE 共享账号预算协调超时；${sent ? "请求可能已发送，写入结果请先刷新核对，不会自动重试" : "本次请求未发送"}；在途数据库操作未撤销`,
      { scope: "dnshe_key", request_sent: sent ? "unknown" : false, coordination_operation: operation,
        coordination_timeout_ms: this.coordinationTimeoutMs, ...(operation === "block" ? { cooldown_persisted: "unknown" } : {}) }));
  }

  private rateLimited(wait: number) {
    return new ProviderApiError("dnshe", 429, "rate_limited", "DNSHE 账号请求预算已用尽，请稍后继续；写请求未发送", undefined, wait);
  }
}
