import { normalizeDomainKey, domainKeyCandidates } from "../../shared/domain-keys";
import { toUnicode } from "../../shared/punycode";
import { computeDashboardStats, createCatalogDateParser, type SummaryExpiry } from "../../shared/dashboard-stats";
import { CATALOG_PROVIDERS, type CatalogProvider, type CatalogSummary, type CatalogSearch, type CatalogHint, type CatalogSearchScope } from "../../shared/domain-catalog";
import { DomainCatalogRepository, type CatalogRow } from "../repositories/domain-catalog-repository";
import { cachedCatalogSummary, initialSummaryDeadline, capSummaryDeadline } from "./catalog-summary-cache";
import { CachedDnsSearchRepository, dnsSearchNeedles } from "../repositories/cached-dns-search-repository";
import { createCatalogMatcher } from "../../shared/catalog-match";

export function catalogMatches(name: string, query: string) {
  return createCatalogMatcher(query).matches(name);
}
interface Cursor { version: 1; scope: string; after: number; ceiling: number; }
export interface PageQuery {
  provider: CatalogProvider; filter?: number; search?: string; status?: string; limit: number; cursor?: string; focus?: string;
  searchIn?: string; focusId?: number;
}
export class CatalogQueryError extends Error {}
export function catalogSearchScope(value = "domain"): CatalogSearchScope {
  if (!["domain", "dns", "all"].includes(value)) throw new CatalogQueryError("无效的搜索范围");
  return value as CatalogSearchScope;
}

function decodeCursor(raw: string, scope: string): Cursor {
  try {
    if (raw.length > 4096) throw new Error();
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(atob(raw), character => character.charCodeAt(0)))) as Cursor;
    if (value.version !== 1 || value.scope !== scope || !Number.isSafeInteger(value.after) ||
      !Number.isSafeInteger(value.ceiling) || value.after < -1 || value.ceiling < value.after) throw new Error();
    return value;
  } catch { throw new CatalogQueryError("无效或与当前筛选不匹配的分页游标"); }
}
export class DomainCatalogService {
  constructor(private readonly repository: DomainCatalogRepository, private readonly dns?: CachedDnsSearchRepository) {}

  async summary(now = Date.now(), timezoneOffset = 0): Promise<CatalogSummary> {
    return (await this.summaryResult(now, timezoneOffset)).summary;
  }
  summaryResult(now = Date.now(), timezoneOffset = 0, force = false) {
    return cachedCatalogSummary(this.repository, now, timezoneOffset, force, () => this.buildSummary(now, timezoneOffset));
  }
  private async buildSummary(now: number, timezoneOffset: number) {
    const [rows, custom, accounts, dates] = await Promise.all([
      this.repository.projection(), this.repository.custom(), this.repository.accounts(),
      this.repository.expiryMetadata(now),
    ]);
    let validUntil = initialSummaryDeadline(now, timezoneOffset);
    const parseTime = createCatalogDateParser(timezoneOffset);
    const cap = (raw: unknown) => { validUntil = capSummaryDeadline(validUntil, raw, now, timezoneOffset, parseTime); };
    const expiry: Record<string, SummaryExpiry> = {};
    for (const row of dates) {
      const key = normalizeDomainKey(row.full_domain);
      if (row.cache_expires_at !== null) validUntil = Math.min(validUntil, row.cache_expires_at * 1000);
      if (row.kind === "manual") {
        expiry[key] = { found: false, manual: true, expires_at: row.expires_at || undefined };
        cap(row.expires_at);
      }
      else {
        try {
          expiry[key] = JSON.parse(row.value || "") as SummaryExpiry;
          cap(expiry[key]?.expires_at);
        } catch { /* malformed cache is unknown */ }
      }
    }
    const partition = (): Record<CatalogProvider, CatalogRow[]> => ({
      dnshe: [], cloudflare: [], digitalplat: [], dnspod: [], alidns: [], huaweicloud: [], vercel: [], custom: [],
    });
    const grouped = partition();
    const groupedAccounts: Record<CatalogProvider, typeof accounts> = {
      dnshe: [], cloudflare: [], digitalplat: [], dnspod: [], alidns: [], huaweicloud: [], vercel: [], custom: [],
    };
    const account_counts: CatalogSummary["account_counts"] = {};
    const roots = new Set<string>();
    for (const row of rows) {
      grouped[row.provider]?.push(row);
      const count = account_counts[row.account_id] ||= { total: 0, has_dns: 0 };
      count.total++; if (row.has_dns) count.has_dns++;
      if (row.provider === "dnshe" && row.rootdomain) roots.add(row.rootdomain);
      cap(row.expires_at);
    }
    for (const row of accounts) groupedAccounts[row.provider]?.push(row);
    for (const row of custom) {
      const count = account_counts[row.group_id] ||= { total: 0, has_dns: 0 }; count.total++;
      cap(row.expires_at);
    }
    const byProvider = (provider: CatalogProvider) => grouped[provider];
    const accountList = (provider: CatalogProvider) => groupedAccounts[provider];
    const stats = computeDashboardStats({
      domains: byProvider("dnshe"), cfZones: byProvider("cloudflare"), dpDomains: byProvider("digitalplat"), customDomains: custom,
      multiProviderDomains: { dnspod: byProvider("dnspod"), alidns: byProvider("alidns"), huaweicloud: byProvider("huaweicloud"), vercel: byProvider("vercel") },
      dnsheAccounts: accountList("dnshe"), cfAccountList: accountList("cloudflare"), dpAccountList: accountList("digitalplat"),
      customGroupList: accountList("custom"),
      multiProviderAccounts: { dnspod: accountList("dnspod"), alidns: accountList("alidns"), huaweicloud: accountList("huaweicloud"), vercel: accountList("vercel") },
      cfExpiryMap: expiry,
    }, now, 20, timezoneOffset, parseTime);
    const provider_counts = Object.fromEntries(CATALOG_PROVIDERS.map(provider => [provider, provider === "custom" ? custom.length : byProvider(provider).length])) as CatalogSummary["provider_counts"];
    return { summary: { stats, provider_counts, account_counts, root_domains: [...roots] }, validUntil };
  }

  async search(query: string, searchIn = "domain"): Promise<CatalogSearch> {
    query = query.trim();
    const scope = catalogSearchScope(searchIn);
    if (query.length > 253) throw new CatalogQueryError("搜索词过长");
    const matcher = createCatalogMatcher(query);
    const cached = query && scope !== "domain" ? await this.dnsMatches(query) : [];
    // Revalidate matched DNS IDs against current ownership/name; changes between
    // these reads must not turn a stale cache hit into a different domain.
    const rows = query ? await this.repository.searchProjection({
      ...(scope === "dns" ? {} : { query }),
      ...(scope === "domain" ? {} : { dnsIds: cached.map(row => row.id) }),
    }) : [];
    const byId = new Map(cached.map(row => [`${row.provider}:${row.id}:${row.account_id}:${row.full_domain}`, row]));
    const group = (): CatalogSearch["groups"]["dnshe"] => ({ total: 0, items: [] });
    const groups: CatalogSearch["groups"] = {
      dnshe: group(), cloudflare: group(), digitalplat: group(), dnspod: group(),
      alidns: group(), huaweicloud: group(), vercel: group(), custom: group(),
    };
    for (const row of rows) {
      const dns = byId.get(`${row.provider}:${row.id}:${row.account_id}:${row.full_domain}`);
      if (!(scope !== "dns" && matcher.matches(row.full_domain)) && !dns) continue;
      const group = groups[row.provider];
      if (!group) continue;
      group.total++;
      if (group.items.length < 8) group.items.push({ ...row,
        ...(dns ? { dns_match: { type: dns.type, name: dns.name, preview: dns.preview } } : {}) });
    }
    return { query, groups, scope, ...(scope === "domain" ? {} : { dns_scope: "valid_cached_records" as const }) };
  }
  private dnsMatches(query: string, provider?: CatalogProvider, accountId?: number) {
    if (!this.dns) throw new CatalogQueryError("当前搜索实例未启用 DNS 缓存检索");
    return this.dns.matches(query, { provider, accountId });
  }

  async page(query: PageQuery) {
    const rawSearch = (query.search || "").trim();
    const searchIn = catalogSearchScope(query.searchIn);
    const search = searchIn === "domain" ? rawSearch.toLowerCase() : dnsSearchNeedles(rawSearch)[0] || "";
    if (search.length > 253 || (query.focus?.length || 0) > 253 || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new CatalogQueryError("分页参数无效");
    if (query.focusId !== undefined && (!Number.isSafeInteger(query.focusId) || query.focusId < 0 || !query.focus)) throw new CatalogQueryError("定位 ID 无效或缺少对应域名");
    const scope = JSON.stringify([query.provider, query.filter ?? null, search, query.status || "", ...(searchIn === "domain" ? [] : [searchIn])]);
    if (query.provider === "custom" && query.status) throw new CatalogQueryError("自定义域名不支持 status 筛选");
    // Unicode partial search needs decoding, unavailable as a D1 SQL function.
    // Only compact names/IDs are scanned; normal paging uses SQL keyset + LIMIT.
    const matcher = createCatalogMatcher(rawSearch);
    const cached = search && searchIn !== "domain" ? await this.dnsMatches(rawSearch, query.provider, query.filter) : [];
    const projection = search || query.focus ? await this.repository.searchProjection({
      provider: query.provider, accountId: query.filter,
      ...(search && searchIn !== "dns" ? { query: rawSearch } : {}),
      ...(search && searchIn !== "domain" ? { dnsIds: cached.map(row => row.id) } : {}),
    }) : [];
    const dnsIds = new Set(cached.map(row => `${row.id}:${row.account_id}:${row.full_domain}`));
    const names = projection.filter(row => row.provider === query.provider && (!query.filter || row.account_id === query.filter) &&
      (!search || (searchIn !== "dns" && matcher.matches(row.full_domain)) || dnsIds.has(`${row.id}:${row.account_id}:${row.full_domain}`)));
    const input = { provider: query.provider, filter: query.filter, status: query.status,
      ...(search ? { ids: names.map(row => row.id) } : {}) };
    let ceiling: number, after = -1, focusTarget: number | undefined;
    if (query.cursor) ({ after, ceiling } = decodeCursor(query.cursor, scope));
    else {
      ceiling = await this.repository.ceiling(input);
      if (query.focus) {
        const keys = domainKeyCandidates(query.focus);
        const target = names.find(row => (query.focusId === undefined || row.id === query.focusId) &&
          domainKeyCandidates(row.full_domain).some(key => keys.includes(key)));
        if (target && await this.repository.focus(input, target.id)) { after = target.id - 1; focusTarget = target.id; }
        else throw new CatalogQueryError("目标域名已删除或不在当前来源");
      }
    }
    const account_counts: CatalogSummary["account_counts"] = {};
    const [counts, candidates] = await Promise.all([
      this.repository.counts(input, ceiling), this.repository.page(input, after, ceiling, query.limit),
    ]);
    for (const row of counts) account_counts[row.account_id] = { total: row.total, has_dns: row.has_dns };
    const selected = candidates.slice(0, query.limit);
    if (focusTarget !== undefined && selected[0]?.id !== focusTarget) throw new CatalogQueryError("目标域名已发生变化，请重新搜索");
    const next_cursor = candidates.length > query.limit
      ? btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(
        { version: 1, scope, after: selected[selected.length - 1].id, ceiling } satisfies Cursor)))) : null;
    const keys = new Set(selected.flatMap(row => domainKeyCandidates(row.full_domain)));
    const variants = [...new Set([...keys].flatMap(key => [key, toUnicode(key).toLowerCase()]))];
    const managed = variants.length ? await this.repository.hintRows(variants) : [];
    const hints: Record<string, CatalogHint> = {};
    for (const row of managed) {
      if (!domainKeyCandidates(row.full_domain).some(key => keys.has(key))) continue;
      const hint = hints[normalizeDomainKey(row.full_domain)] ||= { providers: [] };
      if (!hint.providers.includes(row.provider)) hint.providers.push(row.provider);
      if (row.provider === "dnshe" || row.provider === "digitalplat") {
        hint[row.provider] ||= { id: row.id, expires_at: row.expires_at, created_at: row.created_at };
      }
    }
    return { domains: query.provider === "custom" ? [] : selected, custom_domains: query.provider === "custom" ? selected : [],
      total: counts.reduce((sum, row) => sum + row.total, 0), next_cursor, account_counts, hints };
  }
}
