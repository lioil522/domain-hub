import type { DatabaseManager } from "../db";
import type { SearchResult } from "../search/types";
import { rankSearchResults } from "../search/ranking";
import { accountSearchResult } from "../search/providers/accounts";
import { domainSearchResult } from "../search/providers/domains";
import { dnsSearchResult } from "../search/providers/dns";
import { logSearchResult } from "../search/providers/logs";

function textMatch(value: unknown, q: string) {
  return String(value ?? "").toLowerCase().includes(q);
}

export class SearchService {
  constructor(private readonly db: DatabaseManager) {}

  async search(keyword: string, limit = 20): Promise<SearchResult[]> {
    const q = keyword.trim().toLowerCase();
    if (!q) return [];
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
    const [domains, accounts, logs] = await Promise.all([
      this.db.getDomains(q),
      this.db.getAccounts(),
      this.db.getLogs(200),
    ]);

    const out: SearchResult[] = [];
    for (const item of domains) {
      if (textMatch(item.full_domain, q) || textMatch(item.status, q) || textMatch(item.account_alias, q)) {
        out.push(domainSearchResult(item));
      }
    }

    for (const item of accounts) {
      if (textMatch(item.alias, q) || textMatch(item.provider, q)) {
        out.push(accountSearchResult(item));
      }
    }

    // DNS search stays bounded to cached records; search never triggers upstream provider requests.
    if (domains.length > 0) {
      const candidates = domains.slice(0, 50);
      const cacheMap = await this.db.getDnsRecordsCacheBatch(candidates.map((domain) => domain.id));
      for (const domain of candidates) {
        const records = cacheMap.get(domain.id) || [];
        for (const raw of records) {
          if (out.length >= safeLimit * 4) break;
          const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
          const haystack = `${record.type || ""} ${record.name || ""} ${record.content || ""}`.toLowerCase();
          if (!haystack.includes(q)) continue;
          out.push(dnsSearchResult(domain.id, domain.full_domain, domain.dns_provider || undefined, record));
        }
      }
    }

    for (const item of logs) {
      if (textMatch(item.message, q) || textMatch(item.category, q)) {
        out.push(logSearchResult(item));
      }
    }

    return rankSearchResults(out, q).slice(0, safeLimit);
  }
}
