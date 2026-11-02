export const COORDINATION_TIMEOUT_MS = 2000;

export function validateCoordinationTimeout(milliseconds: number): void {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 2_147_483_647) {
    throw new Error("Invalid database coordination timeout");
  }
}

/** Bounds caller waiting, NOT SQL execution. In-flight writes cannot be cancelled.
 * Each phase shares one monotonic deadline across its sequential database calls.
 * Synchronous SQLite/event-loop stalls cannot be preempted by a JavaScript timer.
 */
export class CoordinationDeadline {
  private readonly expiresAt: number;
  private expired = false;
  constructor(milliseconds: number, private readonly timeout: () => Error) {
    validateCoordinationTimeout(milliseconds);
    this.expiresAt = performance.now() + milliseconds;
  }

  async run<T>(operation: () => Promise<T>, onLate?: (value: T) => Promise<void>): Promise<T> {
    const remaining = this.expiresAt - performance.now();
    if (this.expired || remaining <= 0) throw this.timeout();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      // Timers may round fractional milliseconds down. Once a phase has timed
      // out, never admit another operation in that last fractional interval.
      timer = setTimeout(() => { this.expired = true; reject(this.timeout()); }, remaining);
    });
    const pending = Promise.resolve().then(() => {
      if (this.expired || performance.now() >= this.expiresAt) throw this.timeout();
      return operation();
    }).then(value => {
      if (this.expired || performance.now() >= this.expiresAt) {
        // Best effort only: Workers may terminate after returning the timeout.
        // The callback must itself be bounded; persistent expiry is the fallback.
        if (onLate) void Promise.resolve().then(() => onLate(value)).catch(() => {});
        throw this.timeout();
      }
      return value;
    });
    try { return await Promise.race([pending, deadline]); }
    finally { clearTimeout(timer!); }
  }
}
