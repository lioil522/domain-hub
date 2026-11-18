import assert from "node:assert/strict";
import { test } from "node:test";
import { computeDashboardStats, type DashboardStatsOptions } from "../../frontend/src/features/dashboard/stats";
import type { Account } from "../../frontend/src/types/account";
import type { Domain } from "../../frontend/src/types/domain";
import type { MultiProviderKey } from "../../frontend/src/types/provider";

const NOW = Date.parse("2026-11-18T00:00:00.000Z");
const iso = (days: number) => new Date(NOW + days * 86400000).toISOString();

function domain(full_domain: string, expires_at = iso(30), overrides: Partial<Domain> = {}): Domain {
  return {
    id: Math.floor(Math.random() * 1e9),
    account_id: 1,
    account_alias: "acct",
    subdomain: "",
    rootdomain: "",
    full_domain,
    status: "active",
    created_at: iso(-10),
    expires_at,
    last_renewed_at: null,
    ...overrides,
  };
}

function account(id: number, provider: Account["provider"]): Account {
  return { id, alias: `acct-${id}`, api_key: "k", provider, created_at: iso(-10) };
}

function emptyMultiDomains(): Record<MultiProviderKey, Domain[]> {
  return { dnspod: [], alidns: [], huaweicloud: [], vercel: [] };
}

function options(overrides: Partial<DashboardStatsOptions> = {}): DashboardStatsOptions {
  return {
    domains: [],
    cfZones: [],
    dpDomains: [],
    customDomains: [],
    multiProviderDomains: emptyMultiDomains(),
    dnsheAccounts: [],
    cfAccountList: [],
    dpAccountList: [],
    customGroupList: [],
    multiProviderAccounts: { dnspod: [], alidns: [], huaweicloud: [], vercel: [] },
    cfExpiryMap: {},
    ...overrides,
  };
}

test("the same domain in multiple sources is counted once in totals and timeline", () => {
  const stats = computeDashboardStats(options({
    domains: [domain("same.example.com")],
    cfZones: [domain("same.example.com", iso(30))],
    customDomains: [{
      id: 1, group_id: 1, account_id: null, full_domain: "same.example.com",
      registered_at: null, expires_at: iso(30), remark: null, updated_at: iso(0),
    }],
    customGroupList: [{ id: 1, alias: "custom" }],
  }), NOW);

  assert.equal(stats.total, 1);
  assert.equal(stats.active, 1);
  assert.equal(stats.expiringTotal, 1);
  assert.equal(stats.timeline.scheduledTotal, 1);
  assert.equal(stats.timeline.buckets.flatMap((bucket) => bucket.items).length, 1);
  assert.equal(stats.recent.length, 1);
});

test("DNSPod, Aliyun, Huawei and Vercel domains and accounts are included", () => {
  const multiProviderDomains: Record<MultiProviderKey, Domain[]> = {
    dnspod: [domain("dnspod.example.com")],
    alidns: [domain("aliyun.example.com")],
    huaweicloud: [domain("huawei.example.com")],
    vercel: [domain("vercel.example.com")],
  };
  const stats = computeDashboardStats(options({
    multiProviderDomains,
    multiProviderAccounts: {
      dnspod: [account(1, "dnspod")],
      alidns: [account(2, "alidns")],
      huaweicloud: [account(3, "huaweicloud")],
      vercel: [account(4, "vercel")],
    },
  }), NOW);

  assert.equal(stats.total, 4);
  assert.equal(stats.accounts, 4);
  assert.deepEqual(
    stats.timeline.buckets.flatMap((bucket) => bucket.items.map((item) => item.source)).sort(),
    ["DNSPod", "Vercel", "华为云 DNS", "阿里云 DNS"],
  );
});

test("permanent placeholders from several sources count once", () => {
  const stats = computeDashboardStats(options({
    cfZones: [domain("permanent.example.com", "0000-00-00")],
    customDomains: [{
      id: 2, group_id: 1, account_id: null, full_domain: "permanent.example.com",
      registered_at: null, expires_at: "0000-00-00", remark: null, updated_at: iso(0),
    }],
  }), NOW);

  assert.equal(stats.total, 1);
  assert.equal(stats.timeline.permanentCount, 1);
  assert.equal(stats.expired, 0);
});

test("a source that calls a domain permanent cannot double count it when another source has a real expiry", () => {
  const stats = computeDashboardStats(options({
    cfZones: [domain("mixed.example.com", "0000-00-00")],
    multiProviderDomains: { ...emptyMultiDomains(), dnspod: [domain("mixed.example.com", iso(45))] },
  }), NOW);

  assert.equal(stats.total, 1);
  assert.equal(stats.timeline.permanentCount, 0);
  assert.equal(stats.timeline.scheduledTotal, 1);
  assert.equal(stats.timeline.buckets.flatMap((bucket) => bucket.items).length, 1);
});

test("an expired source marks a shared domain expired while a healthy source stays active", () => {
  const stats = computeDashboardStats(options({
    domains: [domain("shared.example.com", iso(30))],
    multiProviderDomains: { ...emptyMultiDomains(), vercel: [domain("shared.example.com", iso(-1), { status: "已过期" })] },
  }), NOW);

  assert.equal(stats.total, 1);
  assert.equal(stats.expired, 1);
  assert.equal(stats.active, 0);
  assert.equal(stats.timeline.overdueCount, 1);
  assert.equal(stats.timeline.scheduledTotal, 0);
});

test("the most urgent source wins and the timeline never duplicates a domain", () => {
  const stats = computeDashboardStats(options({
    domains: [domain("urgent.example.com", iso(200))],
    cfZones: [domain("urgent.example.com", iso(10))],
  }), NOW);

  assert.equal(stats.total, 1);
  assert.equal(stats.expiringTotal, 1);
  assert.equal(Math.round(stats.expiring[0].daysLeft), 10);
  assert.equal(stats.timeline.scheduledTotal, 1);
  const items = stats.timeline.buckets.flatMap((bucket) => bucket.items);
  assert.equal(items.length, 1);
  assert.equal(Math.round(items[0].daysLeft), 10);
  assert.equal(stats.recent.length, 1);
});
