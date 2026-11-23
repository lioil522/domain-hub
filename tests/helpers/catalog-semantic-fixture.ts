import type { DashboardStatsOptions, SummaryDomain } from "../../shared/dashboard-stats";
import { MULTI_PROVIDER_ORDER } from "../../shared/dashboard-stats";
import { normalizeDomainKey } from "../../shared/domain-keys";

// Deterministic edge-case corpus for an output digest recorded on 4be5a85,
// before performance changes. Invalid dates intentionally exercise stable sort.
export function semanticFixture(seed: number): DashboardStatsOptions {
  let state = seed;
  const next = (length: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % length; };
  const names = ["same.example", "SAME.example.", ".same.example", "测试.example", "xn--0zwm56d.example",
    "\u200b.example", "example", "different.example", " space.example ", "", "x。。example", "xn--invalid-.example"];
  const dates = ["", "0000-00-00", "invalid", "2026-11-23T00:00:00Z", "2026-11-23T00:00:01Z",
    "2026-11-22", "2026-11-23 01:30:00", "2027-02-21", "2027-11-23", "2025-01-01", "2030-01-01"];
  const rows = (source: string): SummaryDomain[] => Array.from({ length: 35 }, () => ({
    full_domain: names[next(names.length)], expires_at: dates[next(dates.length)],
    created_at: dates[next(dates.length)], status: next(7) === 0 ? "已过期" : "active", account_alias: `${source}-${next(5)}`,
  }));
  const cfExpiryMap: DashboardStatsOptions["cfExpiryMap"] = {};
  for (const name of names) {
    if (next(3) === 0) continue;
    cfExpiryMap[normalizeDomainKey(name)] = { found: next(2) === 1, manual: next(4) === 0, expires_at: dates[next(dates.length)] };
  }
  return { domains: rows("dnshe"), cfZones: rows("cf"), dpDomains: rows("dp"),
    multiProviderDomains: Object.fromEntries(MULTI_PROVIDER_ORDER.map(source => [source, rows(source)])) as DashboardStatsOptions["multiProviderDomains"],
    customDomains: rows("custom").map(row => ({ full_domain: row.full_domain, expires_at: row.expires_at, group_id: next(3) })),
    dnsheAccounts: [1, 2], cfAccountList: [3], dpAccountList: [4],
    customGroupList: [{ id: 0, alias: "group-0" }, { id: 1, alias: "group-1" }],
    multiProviderAccounts: { dnspod: [5], alidns: [6], huaweicloud: [7], vercel: [8] }, cfExpiryMap };
}
