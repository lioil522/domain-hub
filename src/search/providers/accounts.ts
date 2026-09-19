import type { SearchResult } from "../types";
export function accountSearchResult(account: { id: number; alias: string; provider: string }): SearchResult {
  return { type: "account", id: String(account.id), title: account.alias, subtitle: account.provider, provider: account.provider, route: "accounts" };
}
