import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { testDatabase, TEST_AES_KEY, TEST_PASSWORD, failDatabaseOperation } from "../helpers/database";
import { DomainCatalogRepository } from "../../src/repositories/domain-catalog-repository";
import { DomainCatalogService, CatalogQueryError } from "../../src/services/domain-catalog-service";
import { CATALOG_PROVIDERS } from "../../shared/domain-catalog";
import { toASCII } from "../../shared/punycode";
import { RDAP_CACHE_PREFIX, DatabaseManager } from "../../src/db";
import worker from "../../src/index";

const NOW = Date.parse("2026-11-18T00:00:00Z");
async function fixture(t: TestContext, n = 250) {
  const data = await testDatabase(t);
  const account = data.sqlite.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(?,?,?,?,?)");
  CATALOG_PROVIDERS.forEach((provider, i) => account.run(i + 1, provider, `fixture-key-${i}`, `fixture-secret-${i}`, provider));
  const insert = data.sqlite.prepare(`INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,created_at,expires_at,has_dns)
    VALUES(?,?,'d','example.com',?,'已解析','2026-11-01','2027-02-01',1)`);
  data.sqlite.exec("BEGIN");
  for (let id = 1; id <= n; id++) insert.run(id, 1, `d-${id}.example.com`);
  for (let provider = 2; provider <= 7; provider++) {
    for (let i = 1; i <= 150; i++) insert.run(provider * 100_000 + i, provider, `p${provider}-${i}.example.com`);
  }
  const custom = data.sqlite.prepare("INSERT INTO custom_domains(id,group_id,full_domain,expires_at) VALUES(?,8,?,'2027-02-01')");
  for (let i = 1; i <= 150; i++) custom.run(i, `custom-${i}.example.com`);
  data.sqlite.exec("COMMIT");
  const repo = new DomainCatalogRepository(data.manager), service = new DomainCatalogService(repo);
  return { ...data, repo, service };
}

test("10,000 domains traverse SQL keyset pages without duplicates or missing IDs", async t => {
  const { service, repo } = await fixture(t, 10_000);
  t.mock.method(repo, "projection", () => { throw new Error("ordinary paging must not load the full projection"); });
  t.mock.method(repo, "searchProjection", () => { throw new Error("ordinary paging must not scan the names index"); });
  const seen: number[] = [];
  let cursor: string | undefined;
  do {
    const page = await service.page({ provider: "dnshe", limit: 100, cursor });
    assert.ok(page.domains.length <= 100);
    assert.equal(page.total, 10_000);
    assert.equal(page.account_counts[1].total, 10_000);
    seen.push(...page.domains.map(row => row.id));
    cursor = page.next_cursor || undefined;
  } while (cursor);
  assert.equal(new Set(seen).size, 10_000);
  assert.deepEqual(seen, Array.from({ length: 10_000 }, (_, i) => i + 1));
});

test("every managed provider and custom provider has bounded pages and correct totals", async t => {
  const { service } = await fixture(t);
  for (const provider of CATALOG_PROVIDERS) {
    const page = await service.page({ provider, limit: 100 });
    assert.equal(page.domains.length + page.custom_domains.length, 100);
    assert.equal(page.total, provider === "dnshe" ? 250 : 150);
    assert.ok(page.next_cursor);
    if (provider === "custom") assert.equal(page.domains.length, 0);
    else assert.ok(page.domains.every(row => "account_provider" in row && row.account_provider === provider));
    assert.ok(!JSON.stringify(page).includes("fixture-key") && !JSON.stringify(page).includes("fixture-secret"));
  }
});

test("renewal sorting changes and deletion between pages cannot duplicate earlier IDs", async t => {
  const { service, manager } = await fixture(t);
  const first = await service.page({ provider: "dnshe", limit: 100 });
  await manager.executeRaw("UPDATE domains_cache SET expires_at='2035-01-01' WHERE id IN (1,101)");
  await manager.executeRaw("DELETE FROM domains_cache WHERE id=50 OR id=101");
  const second = await service.page({ provider: "dnshe", limit: 100, cursor: first.next_cursor! });
  assert.equal(second.domains[0].id, 102);
  assert.ok(second.domains.every(row => row.id > 100));
  assert.equal(second.total, 248);
});

test("cursors are versioned, bounded and tied to provider, account, search and status", async t => {
  const { service } = await fixture(t);
  const first = await service.page({ provider: "dnshe", limit: 10 });
  for (const change of [{ provider: "cloudflare" as const }, { filter: 2 }, { search: "d" }, { status: "未解析" }]) {
    await assert.rejects(() => service.page({ provider: "dnshe", limit: 10, cursor: first.next_cursor!, ...change }), CatalogQueryError);
  }
  for (const cursor of ["bad-json", "x".repeat(4097), btoa('{"version":2}')]) {
    await assert.rejects(() => service.page({ provider: "dnshe", limit: 100, cursor }), CatalogQueryError);
  }
  for (const limit of [0, 101, 1.5, NaN]) await assert.rejects(() => service.page({ provider: "dnshe", limit }), CatalogQueryError);
});

test("partial Unicode searches work beyond the first page and Unicode cursor scopes round-trip", async t => {
  const { service, manager } = await fixture(t);
  for (let id = 1000; id < 1005; id++) {
    await manager.executeRaw(`INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at)
      VALUES(?,1,'','example.com',?,'未解析','2027-02-01')`, [id, toASCII(`测试${id}.example.com`)]);
  }
  const result = await service.search("测");
  assert.equal(result.groups.dnshe.total, 5);
  const first = await service.page({ provider: "dnshe", search: "测", limit: 2 });
  const second = await service.page({ provider: "dnshe", search: "测", limit: 2, cursor: first.next_cursor! });
  assert.deepEqual(first.domains.map(row => row.id), [1000, 1001]);
  assert.deepEqual(second.domains.map(row => row.id), [1002, 1003]);
  assert.equal(second.total, 5);
});

test("global search counts all rows and caps results per source, including custom", async t => {
  const { service } = await fixture(t, 10_000);
  const result = await service.search("example");
  for (const provider of CATALOG_PROVIDERS) {
    assert.equal(result.groups[provider].items.length, 8);
    assert.equal(result.groups[provider].total, provider === "dnshe" ? 10_000 : 150);
  }
});

test("server summary is independent of paging and caps timeline lists without losing counts", async t => {
  const { service } = await fixture(t, 10_000);
  const summary = await service.summary(NOW);
  assert.equal(summary.stats.total, 11_050);
  assert.equal(summary.stats.accounts, 8);
  assert.equal(summary.provider_counts.dnshe, 10_000);
  assert.equal(summary.stats.timeline.scheduledTotal, 11_050);
  const bucket = summary.stats.timeline.buckets.find(bucket => bucket.key === "2027-02")!;
  assert.equal(bucket.count, 11_050);
  assert.equal(bucket.items.length, 20);
  assert.equal(summary.stats.expiring.length, 8);
  assert.ok(JSON.stringify(summary).length < 50_000);
  await service.page({ provider: "dnshe", filter: 999, search: "nothing", limit: 100 });
  assert.deepEqual(await service.summary(NOW), summary);
});

test("same domain in multiple sources deduplicates; manual expiry overrides and cache apply globally", async t => {
  const { service, manager } = await fixture(t);
  await manager.executeRaw("UPDATE domains_cache SET full_domain='d-1.example.com' WHERE id=200001");
  await manager.executeRaw("INSERT INTO domain_date_overrides(account_id,full_domain,expires_at) VALUES(2,'D-1.EXAMPLE.COM.', '2026-11-01')");
  await manager.setCache(`${RDAP_CACHE_PREFIX}p2-2.example.com`, JSON.stringify({ found: true, expires_at: "2026-11-02" }));
  const summary = await service.summary(NOW);
  assert.equal(summary.stats.total, 1299);
  assert.equal(summary.stats.expired, 2);
  assert.equal(summary.stats.timeline.overdueCount, 2);
  const page = await service.page({ provider: "dnshe", limit: 100 });
  assert.deepEqual(page.hints["d-1.example.com"].providers, ["dnshe", "cloudflare"]);
});

test("focus locates a domain beyond the first page and works with normalized name keys", async t => {
  const { service } = await fixture(t, 10_000);
  const page = await service.page({ provider: "dnshe", limit: 100, focus: ".D-9990.EXAMPLE.COM." });
  assert.equal(page.domains[0].id, 9990);
  assert.equal(page.total, 10_000);
  assert.equal(page.domains.length, 11);
  await assert.rejects(() => service.page({ provider: "dnshe", limit: 100, focus: "removed.example" }), CatalogQueryError);
});

test("summary and paging database failures propagate instead of returning successful partial counts", async t => {
  const { d1 } = await fixture(t);
  const failing = failDatabaseOperation(d1, sql => sql.includes("FROM domains_cache"), "all");
  const service = new DomainCatalogService(new DomainCatalogRepository(new DatabaseManager(failing, TEST_AES_KEY)));
  await assert.rejects(() => service.summary(NOW), /Injected database failure/);
  await assert.rejects(() => service.page({ provider: "dnshe", limit: 100 }), /Injected database failure/);
});

test("catalog routes require authentication, validate query bounds, and preserve the legacy list API", async t => {
  const { d1, manager } = await fixture(t);
  await manager.setPassword("admin", TEST_PASSWORD);
  const token = await manager.createSession();
  const request = (route: string, authorized = true) => worker.fetch(new Request(`http://localhost${route}`, {
    headers: authorized ? { Authorization: `Bearer ${token}` } : {},
  }), { DB: d1, AES_KEY: TEST_AES_KEY }, { waitUntil() {}, passThroughOnException() {}, props: {} } as ExecutionContext);
  for (const route of ["/api/domains/page", "/api/domains/search", "/api/domains/summary"]) {
    assert.equal((await request(route, false)).status, 401);
    assert.equal((await request(route)).status, 200);
  }
  for (const query of ["provider=unknown", "limit=101", "account_id=wat", "cursor=invalid", "focus=" + "x".repeat(254)]) {
    assert.equal((await request(`/api/domains/page?${query}`)).status, 400);
  }
  assert.equal((await request("/api/domains/summary?timezone_offset=9999")).status, 400);
  const old = await (await request("/api/domains")).json() as { domains: unknown[] };
  assert.equal(old.domains.length, 250);
  const page = await (await request("/api/domains/page")).json() as { domains: unknown[]; next_cursor: string };
  assert.equal(page.domains.length, 100);
  assert.ok(page.next_cursor);
  const custom = await (await request("/api/custom-groups/overview?include_domains=0")).json() as { domains: unknown[] };
  assert.deepEqual(custom.domains, []);
});

test("summary months use the caller offset, including timestamps without an explicit zone", async t => {
  const { service, manager } = await fixture(t, 1);
  await manager.executeRaw("UPDATE domains_cache SET expires_at='2026-10-31T18:00:00Z' WHERE id=1");
  const now = Date.parse("2026-10-31T17:00:00Z");
  const east = await service.summary(now, -480);
  assert.equal(east.stats.timeline.buckets[0].key, "2026-11");
  assert.ok(east.stats.timeline.buckets[0].items.some(row => row.full_domain === "d-1.example.com" && row.day === 1));
  const utc = await service.summary(now, 0);
  assert.equal(utc.stats.timeline.buckets[0].key, "2026-10");
  await manager.executeRaw("UPDATE domains_cache SET expires_at='2026-11-01 00:30:00' WHERE id=1");
  const offset = await service.summary(now, -480);
  assert.ok(offset.stats.expiring.some(row => row.full_domain === "d-1.example.com" && row.expired));
});
