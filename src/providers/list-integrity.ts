import { incompleteResponse } from "../errors/provider-api-error";

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isId(value: unknown): boolean {
  return hasText(value) || (isCount(value) && value > 0);
}

export function domainKey(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, "");
}

/** A list is publishable only after its provider's explicit end condition. */
export class CompleteList<T> {
  readonly items: T[] = [];
  private readonly seen = new Set<string>();
  private total?: number;
  private pageLength = 0;

  constructor(readonly provider: string) {}

  add(value: unknown, keys: (item: T) => string[] | null, maxLength = Infinity): void {
    if (!Array.isArray(value) || value.length > maxLength) throw incompleteResponse(this.provider);
    this.pageLength = value.length;
    for (const item of value) {
      const identities = isObject(item) ? keys(item as T) : null;
      if (!identities?.length || identities.some(key => !key || this.seen.has(key))) {
        throw incompleteResponse(this.provider);
      }
      for (const key of identities) this.seen.add(key);
      this.items.push(item as T);
    }
  }

  /** Stable totals and unique rows prevent repeated/empty pages becoming snapshots. */
  ended(total: unknown): boolean {
    if (!isCount(total) || (this.total !== undefined && total !== this.total) || this.items.length > total) {
      throw incompleteResponse(this.provider);
    }
    this.total = total;
    if (this.items.length === total) return true;
    if (this.pageLength === 0) throw incompleteResponse(this.provider);
    return false;
  }
}
