import assert from "node:assert/strict";
import { test } from "node:test";
import { computeDashboardStats, type DashboardStatsOptions, type SummaryDomain } from "../../shared/dashboard-stats";
import { SUMMARY_CACHE_MS } from "../../src/services/catalog-summary-cache";
import { DomainCatalogRepository } from "../../src/repositories/domain-catalog-repository";
import { DomainCatalogService } from "../../src/services/domain-catalog-service";
import { testDatabase } from "../helpers/database";

// Executable counterexamples for a future persistent projection. No incremental
// producer, background task or public API is installed by these tests.
const NOW = Date.parse("2026-11-23T00:00:00Z");
const row = (full_domain: string, expires_at: string): SummaryDomain => ({ full_domain, expires_at, account_alias: full_domain });
function input(patch: Partial<DashboardStatsOptions> = {}): DashboardStatsOptions {
  return { domains: [], cfZones: [], dpDomains: [], customDomains: [],
    multiProviderDomains: { dnspod: [], alidns: [], huaweicloud: [], vercel: [] },
    dnsheAccounts: [], cfAccountList: [], dpAccountList: [], customGroupList: [],
    multiProviderAccounts: { dnspod: [], alidns: [], huaweicloud: [], vercel: [] }, cfExpiryMap: {}, ...patch };
}

test("partition summaries cannot be added without canonical contributions and cross-source dependencies", () => {
  const left = input({ cfZones: [row("SHARED.example.", "0000-00-00")] });
  const right = input({ domains: [row("shared.example", "2027-01-01")] });
  const a = computeDashboardStats(left, NOW, 20, 0), b = computeDashboardStats(right, NOW, 20, 0);
  const whole = computeDashboardStats(input({ domains: right.domains, cfZones: left.cfZones }), NOW, 20, 0);
  assert.equal(a.total + b.total, 2);
  assert.equal(whole.total, 1);
  assert.equal(a.timeline.permanentCount + b.timeline.permanentCount, 1);
  assert.equal(whole.timeline.permanentCount, 0);
  assert.equal(whole.timeline.scheduledTotal, 1);
});

test("a UTC winning expiry is insufficient to derive a caller-offset summary", () => {
  const data = input({ domains: [row("same.example", "2026-11-23 10:00:00")],
    cfZones: [row("same.example", "2026-11-23T08:00:00Z")] });
  const utc = computeDashboardStats(data, NOW, 20, 0);
  const east = computeDashboardStats(data, NOW, 20, -480);
  assert.equal(utc.expiring[0].source, "Cloudflare");
  assert.equal(east.expiring[0].source, "DNSHE");
  assert.equal(utc.expiring[0].time, Date.parse("2026-11-23T08:00:00Z"));
  assert.equal(east.expiring[0].time, Date.parse("2026-11-23T02:00:00Z"));
});

test("unchanged inventory revision does not make a frozen partial summary valid after a time boundary", async t => {
  const { sqlite, manager } = await testDatabase(t);
  sqlite.exec("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'fixture','fake','fake','dnshe')");
  sqlite.prepare(`INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at)
    VALUES(1,1,'','example','time.example','active',?)`).run(new Date(NOW + 120_000).toISOString());
  const repo = new DomainCatalogRepository(manager), catalog = new DomainCatalogService(repo);
  const revision = await repo.revision();
  const before = await catalog.summary(NOW);
  const later = await catalog.summary(NOW + 360_000);
  assert.equal(await repo.revision(), revision);
  assert.equal(before.stats.expired, 0);
  assert.equal(later.stats.expired, 1);
  assert.ok(before.valid_until! <= NOW + 120_001);
  assert.ok(NOW + 360_000 > NOW + SUMMARY_CACHE_MS);
});

test("one whole-inventory checkpoint blob exceeds the existing summary byte cap", async t => {
  const { sqlite, manager } = await testDatabase(t);
  sqlite.exec(`INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'fixture','fake','fake','dnshe');
    WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<50000)
    INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at,created_at,has_dns)
    SELECT i,1,'','example.net','item-'||i||'.example.net','active','2027-01-01','2026-11-01',1 FROM seq`);
  const compact = await new DomainCatalogRepository(manager).projection();
  const bytes = new TextEncoder().encode(JSON.stringify({ format: 1, phase: "aggregate", rows: compact })).byteLength;
  assert.equal(compact.length, 50000);
  assert.ok(bytes > 524288, "A single durable cache blob must not silently raise the 512KiB policy");
  console.log(`[incremental-assessment] 50000-row compact checkpoint=${bytes} bytes (synthetic, not a production state format)`);
});

test("a stale producer must not publish after a write changes the global revision", async t => {
  const { sqlite, manager } = await testDatabase(t);
  sqlite.exec(`INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'fixture','fake','fake','dnshe');
    INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at)
    VALUES(1,1,'','example','old.example','active','2027-01-01')`);
  const repo = new DomainCatalogRepository(manager), catalog = new DomainCatalogService(repo);
  const before = await catalog.summary(NOW), revision = await repo.revision();
  await manager.executeRaw("UPDATE domains_cache SET full_domain='new.example' WHERE id=1");
  assert.notEqual(await repo.revision(), revision);
  const staged = JSON.stringify({ format: 1, revision, offset: 0, generated_at: NOW,
    valid_until: NOW + SUMMARY_CACHE_MS, summary: before });
  assert.equal(await repo.storeSummary(0, staged, revision, NOW + SUMMARY_CACHE_MS), false);
  assert.equal(await repo.cachedSummary(0, NOW), null);
  assert.equal((await catalog.summary(NOW)).stats.total, 1);
});
