import type { SearchResult } from "../types";
export function dnsSearchResult(domainId: number, fullDomain: string, provider: string | undefined, record: Record<string, unknown>): SearchResult {
  return { type: "dns", id: String(record.id || `${domainId}:${record.name || ""}`), title: String(record.name || fullDomain), subtitle: `${String(record.type || "")} ${String(record.content || "")}`.trim(), provider, route: "domains", metadata: { domainId, fullDomain } };
}
