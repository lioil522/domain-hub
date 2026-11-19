import { normalizeDomainKey, domainKeyCandidates } from "../../shared/domain-keys";
import { toASCII, toUnicode } from "../../shared/punycode";
import { computeDashboardStats, type SummaryExpiry } from "../../shared/dashboard-stats";
import { CATALOG_PROVIDERS, type CatalogProvider, type CatalogSummary, type CatalogSearch, type CatalogHint } from "../../shared/domain-catalog";
import { DomainCatalogRepository } from "../repositories/domain-catalog-repository";

export function catalogMatches(name: string, query: string) {
  const q = query.trim().toLowerCase();
  const ascii = name.toLowerCase(), unicode = toUnicode(name).toLowerCase(), qa = toASCII(q).toLowerCase();
  return ascii.includes(q) || unicode.includes(q) || ascii.includes(qa);
}
interface Cursor { version: 1; scope: string; after: number; ceiling: number; }
export interface PageQuery {
  provider: CatalogProvider; filter?: number; search?: string; status?: string; limit: number; cursor?: string; focus?: string;
}
export class CatalogQueryError extends Error {}

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
  constructor(private readonly repository: DomainCatalogRepository) {}

  async summary(now = Date.now(), timezoneOffset = 0): Promise<CatalogSummary> {
    const [rows, custom, accounts, dates] = await Promise.all([
      this.repository.projection(), this.repository.custom(), this.repository.accounts(),
      this.repository.expiryMetadata(),
    ]);
    const expiry: Record<string, SummaryExpiry> = {};
    for (const row of dates) {
      const key = normalizeDomainKey(row.full_domain);
      if (row.kind === "manual") expiry[key] = { found: false, manual: true, expires_at: row.expires_at || undefined };
      else {
        try { expiry[key] = JSON.parse(row.value || "") as SummaryExpiry; } catch { /* malformed cache is unknown */ }
      }
    }
    const byProvider = (provider: CatalogProvider) => rows.filter(row => row.provider === provider);
    const accountList = (provider: CatalogProvider) => accounts.filter(row => row.provider === provider);
    const stats = computeDashboardStats({
      domains: byProvider("dnshe"), cfZones: byProvider("cloudflare"), dpDomains: byProvider("digitalplat"), customDomains: custom,
      multiProviderDomains: { dnspod: byProvider("dnspod"), alidns: byProvider("alidns"), huaweicloud: byProvider("huaweicloud"), vercel: byProvider("vercel") },
      dnsheAccounts: accountList("dnshe"), cfAccountList: accountList("cloudflare"), dpAccountList: accountList("digitalplat"),
      customGroupList: accountList("custom"),
      multiProviderAccounts: { dnspod: accountList("dnspod"), alidns: accountList("alidns"), huaweicloud: accountList("huaweicloud"), vercel: accountList("vercel") },
      cfExpiryMap: expiry,
    }, now, 20, timezoneOffset);
    const provider_counts = Object.fromEntries(CATALOG_PROVIDERS.map(provider => [provider, provider === "custom" ? custom.length : byProvider(provider).length])) as CatalogSummary["provider_counts"];
    const account_counts: CatalogSummary["account_counts"] = {};
    for (const row of rows) {
      const count = account_counts[row.account_id] ||= { total: 0, has_dns: 0 };
      count.total++; if (row.has_dns) count.has_dns++;
    }
    for (const row of custom) {
      const count = account_counts[row.group_id] ||= { total: 0, has_dns: 0 }; count.total++;
    }
    return { stats, provider_counts, account_counts, root_domains: [...new Set(byProvider("dnshe").map(row => row.rootdomain).filter(Boolean))] };
  }

  async search(query: string): Promise<CatalogSearch> {
    if (query.length > 253) throw new CatalogQueryError("搜索词过长");
    const rows = await this.repository.searchProjection();
    const group = (): CatalogSearch["groups"]["dnshe"] => ({ total: 0, items: [] });
    const groups: CatalogSearch["groups"] = {
      dnshe: group(), cloudflare: group(), digitalplat: group(), dnspod: group(),
      alidns: group(), huaweicloud: group(), vercel: group(), custom: group(),
    };
    for (const row of rows) {
      if (!catalogMatches(row.full_domain, query)) continue;
      const group = groups[row.provider];
      if (!group) continue;
      group.total++;
      if (group.items.length < 8) group.items.push({ id: row.id, full_domain: row.full_domain, account_id: row.account_id, provider: row.provider });
    }
    return { query, groups };
  }

  async page(query: PageQuery) {
    const search = (query.search || "").trim().toLowerCase();
    if (search.length > 253 || (query.focus?.length || 0) > 253 || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new CatalogQueryError("分页参数无效");
    const scope = JSON.stringify([query.provider, query.filter ?? null, search, query.status || ""]);
    if (query.provider === "custom" && query.status) throw new CatalogQueryError("自定义域名不支持 status 筛选");
    // Unicode partial search needs decoding, unavailable as a D1 SQL function.
    // Only compact names/IDs are scanned; normal paging uses SQL keyset + LIMIT.
    const names = search || query.focus ? (await this.repository.searchProjection())
      .filter(row => row.provider === query.provider && (!query.filter || row.account_id === query.filter) &&
        (!search || catalogMatches(row.full_domain, search))) : [];
    const input = { provider: query.provider, filter: query.filter, status: query.status,
      ...(search ? { ids: names.map(row => row.id) } : {}) };
    let ceiling: number, after = -1;
    if (query.cursor) ({ after, ceiling } = decodeCursor(query.cursor, scope));
    else {
      ceiling = await this.repository.ceiling(input);
      if (query.focus) {
        const keys = domainKeyCandidates(query.focus);
        const target = names.find(row => domainKeyCandidates(row.full_domain).some(key => keys.includes(key)));
        if (target) after = target.id - 1;
        else throw new CatalogQueryError("目标域名已删除或不在当前来源");
      }
    }
    const account_counts: CatalogSummary["account_counts"] = {};
    const [counts, candidates] = await Promise.all([
      this.repository.counts(input, ceiling), this.repository.page(input, after, ceiling, query.limit),
    ]);
    for (const row of counts) account_counts[row.account_id] = { total: row.total, has_dns: row.has_dns };
    const selected = candidates.slice(0, query.limit);
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
