import type { DatabaseManager } from "../db";
import type { SearchResult } from "../search/types";
import { scoreSearchResult } from "../search/ranking";
import { accountSearchResult } from "../search/providers/accounts";
import { domainSearchResult } from "../search/providers/domains";
import { dnsSearchResult } from "../search/providers/dns";
import { logSearchResult } from "../search/providers/logs";
import { DomainCatalogRepository } from "../repositories/domain-catalog-repository";
import { CachedDnsSearchRepository, dnsSearchNeedles } from "../repositories/cached-dns-search-repository";
import { SearchRepository } from "../repositories/search-repository";
import { createCatalogMatcher } from "../../shared/catalog-match";
import { ValidationError } from "../errors";

export class SearchService {
  constructor(private readonly db: DatabaseManager) {}

  async search(keyword: string, limit = 20): Promise<SearchResult[]> {
    const q = keyword.trim().toLowerCase();
    if (!q) return [];
    if (keyword.trim().length > 253 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError("搜索词或结果条数无效");
    const repository = new SearchRepository(this.db);
    const sqlQuery = dnsSearchNeedles(keyword)[0];
    const matcher = createCatalogMatcher(keyword);
    const [domains, metadata, accounts, dns, logs] = await Promise.all([
      new DomainCatalogRepository(this.db).searchProjection({ query: keyword }),
      repository.domainsByMetadata(sqlQuery, limit),
      repository.accounts(sqlQuery, limit),
      new CachedDnsSearchRepository(this.db).matches(keyword, { eachRecord: true, limit: 400 }),
      repository.logs(sqlQuery, limit),
    ]);
    // Keep at most limit per score tier rather than materializing/ranking the
    // entire matching inventory. Stable insertion order preserves equal-score ties.
    const buckets = new Map<number, SearchResult[]>(), kept = new Set<string>();
    const add = (result: SearchResult, cachedScore?: number) => {
      const score = cachedScore ?? scoreSearchResult(result, q), bucket = buckets.get(score) || [];
      const key = `${result.type}:${result.provider || ""}:${result.id}`;
      if (kept.has(key) || bucket.length >= limit) return;
      bucket.push(result); buckets.set(score, bucket); kept.add(key);
    };
    for (const item of domains) {
      if (matcher.matches(item.full_domain)) {
        add(domainSearchResult({ ...item, account_provider: item.provider }));
      }
    }
    for (const item of metadata) add(domainSearchResult(item));
    for (const item of accounts) add(accountSearchResult(item));
    for (const item of dns) add(dnsSearchResult(item.id, item.full_domain, item.provider,
      { id: item.record_id, name: item.name, type: item.type, content: item.preview }, item.record_index, item.account_id), item.score);
    for (const item of logs) add(logSearchResult(item));
    return [...buckets.keys()].sort((a, b) => b - a).flatMap(score => buckets.get(score)!).slice(0, limit);
  }
}
