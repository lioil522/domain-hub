import { AppError } from "../errors";

export type BudgetResource = "d1" | "external";
export type BudgetAmounts = Record<BudgetResource, number>;
export interface InvocationCounter {
  readonly strict: boolean;
  consume(resource: BudgetResource, count?: number): void;
}

export interface BudgetFailureAccounting {
  used: number; reserved: number; limit: number; remaining: number; requested: number;
  reservation_remaining?: number;
}

export class InvocationBudgetError extends AppError {
  constructor(readonly resource: BudgetResource, readonly reason: "exhausted" | "closed" = "exhausted",
    readonly requestSent?: false | "unknown", readonly accounting?: Readonly<BudgetFailureAccounting>) {
    super("本次执行预算不足或已结束，请在下一次执行继续", 503, "invocation_budget_exhausted",
      { resource, reason, ...accounting, ...(requestSent === undefined ? {} : { request_sent: requestSent }) });
  }
  withRequestOutcome(requestSent: false | "unknown") { return new InvocationBudgetError(this.resource, this.reason, requestSent, this.accounting); }
}

const amount = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid invocation budget amount");
  return value;
};

/** Invocation-local accounting. Dispatches, failures and late SQL are never refunded.
 * Reservations protect tail/coordination calls from concurrent work. Releasing a
 * reservation releases ONLY unused capacity; it never subtracts consumed calls.
 * Observation is temporary compatibility for legacy unbounded entry points.
 */
export class InvocationBudget implements InvocationCounter {
  private readonly used: BudgetAmounts = { d1: 0, external: 0 };
  private readonly reserved: BudgetAmounts = { d1: 0, external: 0 };
  private closed = false;
  private opaqueRedirects = false;
  readonly limits: Readonly<BudgetAmounts>;
  constructor(limits: Partial<BudgetAmounts> = {}, readonly strict = true) {
    this.limits = Object.freeze({ d1: amount(limits.d1 ?? 40), external: amount(limits.external ?? 40) });
  }
  consume(resource: BudgetResource, count = 1): void {
    amount(count);
    this.assertOpen(resource, count);
    if (this.strict && count > this.remaining(resource)) throw this.failure(resource, "exhausted", count);
    this.used[resource] += count;
  }
  remaining(resource: BudgetResource): number {
    return Math.max(0, this.limits[resource] - this.used[resource] - this.reserved[resource]);
  }
  reserve(amounts: Partial<BudgetAmounts>): BudgetReservation {
    const capacity = { d1: amount(amounts.d1 ?? 0), external: amount(amounts.external ?? 0) };
    for (const resource of ["d1", "external"] as const) {
      this.assertOpen(resource, capacity[resource]);
      if (this.strict && capacity[resource] > this.remaining(resource)) throw this.failure(resource, "exhausted", capacity[resource]);
    }
    this.reserved.d1 += capacity.d1;
    this.reserved.external += capacity.external;
    return new BudgetReservation(this, capacity);
  }
  /** Used by BudgetReservation only: a dispatch moves reserved capacity to used. */
  consumeReserved(resource: BudgetResource, count: number): void {
    this.assertOpen(resource, count);
    this.reserved[resource] -= count;
    this.used[resource] += count;
  }
  releaseReserved(capacity: BudgetAmounts): void {
    this.reserved.d1 -= capacity.d1;
    this.reserved.external -= capacity.external;
  }
  markOpaqueRedirects(): void { this.opaqueRedirects = true; }
  close(): void { this.closed = true; }
  /** Capture at the rejection, BEFORE release/cleanup spends reserved capacity. */
  failure(resource: BudgetResource, reason: "exhausted" | "closed", requested = 1, reservationRemaining?: number) {
    return new InvocationBudgetError(resource, reason, undefined, Object.freeze({
      used: this.used[resource], reserved: this.reserved[resource], limit: this.limits[resource],
      remaining: this.remaining(resource), requested,
      ...(reservationRemaining === undefined ? {} : { reservation_remaining: reservationRemaining }),
    }));
  }
  private assertOpen(resource: BudgetResource, requested: number): void {
    if (this.closed) throw this.failure(resource, "closed", requested);
  }
  snapshot() {
    return { used: { ...this.used }, reserved: { ...this.reserved }, limits: { ...this.limits },
      strict: this.strict, closed: this.closed, externalExact: !this.opaqueRedirects };
  }
}

export class BudgetReservation implements InvocationCounter {
  private closed = false;
  readonly strict: boolean;
  constructor(private readonly parent: InvocationBudget, private readonly capacity: BudgetAmounts) {
    this.strict = parent.strict;
  }
  consume(resource: BudgetResource, count = 1): void {
    amount(count);
    if (this.closed) throw this.parent.failure(resource, "closed", count, this.capacity[resource]);
    // A prepaid operation cannot borrow from the tail or another reservation.
    if (count > this.capacity[resource]) throw this.parent.failure(resource, "exhausted", count, this.capacity[resource]);
    this.parent.consumeReserved(resource, count);
    this.capacity[resource] -= count;
  }
  release(): void {
    if (this.closed) return;
    this.closed = true;
    this.parent.releaseReserved(this.capacity);
    this.capacity.d1 = this.capacity.external = 0;
  }
}
