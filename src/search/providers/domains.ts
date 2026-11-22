import type { SearchResult } from "../types";
export function domainSearchResult(domain: { id: number; full_domain: string; status?: string; account_provider?: string; account_id?: number }): SearchResult {
  const provider = domain.account_provider;
  return { type: "domain", id: String(domain.id), title: domain.full_domain, subtitle: domain.status, provider,
    route: !provider || provider === "dnshe" ? "domains" : provider,
    metadata: { domainId: domain.id, fullDomain: domain.full_domain, accountId: domain.account_id } };
}
