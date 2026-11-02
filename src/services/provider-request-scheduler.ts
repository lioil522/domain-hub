import { ProviderApiError } from "../errors/provider-api-error";
import { InvocationBudgetError } from "./invocation-budget";
import type { AccountProvider } from "../db/types";
import { CoordinationDeadline, COORDINATION_TIMEOUT_MS, validateCoordinationTimeout } from "./coordination-deadline";

export interface ProviderRequestLease {
  release(): Promise<void>;
  /** Synchronous final dispatch check: no await between this check and fetch. */
  assertReady?(): void;
}

export interface ProviderRequestScheduler {
  readonly scope?: "dnshe_key" | "deployment_provider";
  acquire(timeoutMs: number, signal?: AbortSignal | null): Promise<ProviderRequestLease>;
  block(milliseconds: number): Promise<void>;
}

/** Deployment/provider admission policy, NOT an upstream per-credential quota model.
 * Two tracked attempts, no waiting queue. All coordination lives in the shared DB.
 * Expiry recovers abandoned permits; it cannot prove an upstream write has stopped.
 */
export class SharedProviderRequestScheduler implements ProviderRequestScheduler {
  readonly scope = "deployment_provider" as const;
  private readonly key: string;
  constructor(private readonly db: D1Database, private readonly provider: Exclude<AccountProvider, "custom">,
    private readonly now = () => Date.now(), private readonly coordinationTimeoutMs = COORDINATION_TIMEOUT_MS) {
    validateCoordinationTimeout(coordinationTimeoutMs);
    this.key = `provider_scheduler:v1:${provider}`;
  }

  async acquire(timeoutMs: number): Promise<ProviderRequestLease> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new Error("Invalid provider scheduler timeout");
    }
    const now = this.now();
    const expires = Math.ceil((now + timeoutMs + 5000) / 1000);
    const owner = crypto.randomUUID();
    const deadline = this.deadline("acquire", false);
    try {
      for (let slot = 0; slot < 2; slot++) {
        const key = `${this.key}:slot:${slot}`;
        // Check cooldown inside the same write as the permit claim, not via a racy read.
        // Invalid coordination values deny admission rather than casting them to zero.
        const blocked = `SELECT 1 FROM cache WHERE key = ? AND
          (value = '' OR value GLOB '*[^0-9]*' OR CAST(value AS INTEGER) > ?)`;
        const row = await deadline.run(() => this.db.prepare(`INSERT INTO cache (key, value, expires_at)
          SELECT ?, ?, ? WHERE NOT EXISTS (${blocked})
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
          WHERE cache.expires_at <= ? AND NOT EXISTS (${blocked}) RETURNING value`)
          .bind(key, owner, expires, `${this.key}:blocked`, now, Math.floor(now / 1000), `${this.key}:blocked`, now)
          .first<{ value: string }>(), async late => {
            if (late?.value === owner) await this.release(key, owner, false);
          });
        if (!row) continue;
        if (row.value !== owner) throw this.unavailable(false);
        const lease = { release: () => this.release(key, owner, true) };
        // A slow DB claim must not let the transport outlive its permit.
        if (this.now() + timeoutMs >= expires * 1000) {
          await this.release(key, owner, false);
          throw this.unavailable(false);
        }
        return lease;
      }
      const blocked = await deadline.run(() => this.db.prepare("SELECT value FROM cache WHERE key = ?")
        .bind(`${this.key}:blocked`).first<{ value: string }>());
      if (blocked && (!/^\d+$/.test(blocked.value) || !Number.isSafeInteger(Number(blocked.value)))) {
        throw this.unavailable(false);
      }
      const wait = Number(blocked?.value ?? 0) - this.now();
      throw new ProviderApiError(this.provider, 429, wait > 0 ? "scheduler_cooldown" : "scheduler_busy",
        `${this.provider} ${wait > 0 ? "共享冷却尚未结束" : "共享请求并发已满"}；本次请求未发送，请稍后继续`,
        { scope: "deployment_provider", request_sent: false }, Math.max(1000, wait));
    } catch (error) {
      if (error instanceof InvocationBudgetError) throw error.withRequestOutcome(false);
      if (error instanceof ProviderApiError) throw error;
      throw this.unavailable(false);
    }
  }

  async block(milliseconds: number): Promise<void> {
    // Valid but unrepresentably large Retry-After fails closed; never shorten it silently.
    const until = this.now() + Math.max(1000, milliseconds);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || !Number.isSafeInteger(until)) {
      throw this.unavailable(true);
    }
    try {
      const row = await this.deadline("block", true).run(() => this.db.prepare(`INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(cache.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT),
        expires_at = MAX(cache.expires_at, excluded.expires_at)
        WHERE cache.value <> '' AND cache.value NOT GLOB '*[^0-9]*'
          AND CAST(cache.value AS INTEGER) <= 9007199254740991 RETURNING value`)
        .bind(`${this.key}:blocked`, String(until), Math.ceil(until / 1000) + 3600).first<{ value: string }>());
      // Do not silently repair corrupt coordination state and reopen admission.
      if (!row || !Number.isSafeInteger(Number(row.value)) || Number(row.value) < until) throw this.unavailable(true);
    } catch (error) {
      if (error instanceof InvocationBudgetError) throw error.withRequestOutcome("unknown");
      if (error instanceof ProviderApiError) throw error;
      throw this.unavailable(true);
    }
  }

  private async release(key: string, owner: string, sent: boolean): Promise<void> {
    try {
      // An expired owner's cleanup must never delete a new owner's permit.
      const result = await this.deadline("release", sent).run(() =>
        this.db.prepare("DELETE FROM cache WHERE key = ? AND value = ?").bind(key, owner).run());
      if (!result.success) throw this.unavailable(sent);
    } catch (error) {
      if (error instanceof InvocationBudgetError) throw error.withRequestOutcome(sent ? "unknown" : false);
      if (error instanceof ProviderApiError) throw error;
      throw this.unavailable(sent);
    }
  }

  private deadline(operation: "acquire" | "block" | "release", sent: boolean) {
    return new CoordinationDeadline(this.coordinationTimeoutMs, () => new ProviderApiError(this.provider, 502, "scheduler_timeout",
      `${this.provider} 共享请求调度协调超时；${sent ? "请求可能已发送，写入结果请先刷新核对，不会自动重试" : "本次请求未发送"}；在途数据库操作未撤销`,
      { scope: "deployment_provider", request_sent: sent ? "unknown" : false, coordination_operation: operation,
        coordination_timeout_ms: this.coordinationTimeoutMs, ...(operation === "block" ? { cooldown_persisted: "unknown" } : {}) }));
  }

  private unavailable(sent: boolean) {
    return new ProviderApiError(this.provider, 502, "scheduler_unavailable",
      `${this.provider} 共享请求调度状态不可用；${sent ? "请求可能已发送，写入结果请先刷新核对，不会自动重试" : "本次请求未发送"}`,
      { scope: "deployment_provider", request_sent: sent ? "unknown" : false });
  }
}
