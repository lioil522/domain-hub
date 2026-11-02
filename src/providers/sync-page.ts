import { incompleteResponse } from "../errors/provider-api-error";

export interface ProviderPage<T> { items: T[]; next: number | string | null; total?: number }
/** Totals are authoritative, must stay stable across invocations, and may not
 * permit a short page to skip rows in page-number pagination. */
export function pageTotal(provider: string, total: unknown, offset: number, length: number, expected?: number): number {
  if (!Number.isSafeInteger(total) || (total as number) < offset + length ||
    expected !== undefined && expected !== total || length === 0 && offset < (total as number)) throw incompleteResponse(provider);
  return total as number;
}
