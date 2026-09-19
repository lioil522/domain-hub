import type { SearchResult } from "../types";
export function domainSearchResult(domain: { id: number; full_domain: string; status?: string; account_provider?: string }): SearchResult {
  return { type: "domain", id: String(domain.id), title: domain.full_domain, subtitle: domain.status, provider: domain.account_provider, route: "domains" };
}
