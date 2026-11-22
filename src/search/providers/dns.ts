import type { SearchResult } from "../types";
export function dnsSearchResult(domainId: number, fullDomain: string, provider: string | undefined, record: Record<string, unknown>, index = 0, accountId?: number): SearchResult {
  return { type: "dns", id: `${domainId}:${index}:${record.id ?? ""}`, title: String(record.name || fullDomain),
    subtitle: `${String(record.type || "")} ${String(record.content || "")}`.trim(), provider,
    route: !provider || provider === "dnshe" ? "domains" : provider,
    metadata: { domainId, fullDomain, accountId, recordId: record.id, recordIndex: index, cached: true } };
}
