import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { testDatabase, TEST_AES_KEY, failDatabaseOperation } from "../helpers/database";
import { DomainCatalogRepository } from "../../src/repositories/domain-catalog-repository";
import { DomainCatalogService } from "../../src/services/domain-catalog-service";
import { DatabaseManager, RDAP_CACHE_PREFIX } from "../../src/db";
import { CATALOG_CACHE_PREFIX, CATALOG_REVISION_KEY, versionedCatalogDatabase } from "../../src/db/catalog-version";
import { SUMMARY_CACHE_MS } from "../../src/services/catalog-summary-cache";
import { backupChecksum } from "../../src/db/backup-integrity";

const NOW = Date.parse("2026-11-19T00:00:00Z");
async function fixture(t: TestContext, n = 1) {
  const data = await testDatabase(t);
  data.sqlite.exec(`INSERT INTO accounts(id,alias,api_key,api_secret,provider)
    VALUES(1,'dnshe','fixture-one','plain:Zml4dHVyZQ==','dnshe'),(2,'CF','fixture-two','plain:Zml4dHVyZQ==','cloudflare'),
      (3,'manual','fixture-three','plain:Zml4dHVyZQ==','custom')`);
  const insert = data.sqlite.prepare(`INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,created_at,expires_at,has_dns)
    VALUES(?,1,'d','example.com',?,'已解析','2026-11-01','2027-02-01',1)`);
  data.sqlite.exec("BEGIN");
  for (let id = 1; id <= n; id++) insert.run(id, `d-${id}.example.com`);
  data.sqlite.exec("COMMIT");
  const repo = new DomainCatalogRepository(data.manager), service = new DomainCatalogService(repo);
  return { ...data, repo, service };
}

test("warm summaries need one indexed read and no inventory projection", async t => {
  const { service, repo, manager } = await fixture(t, 10_000);
  const cold = await service.summaryResult(NOW);
  assert.equal(cold.cache, "miss");
  assert.equal(cold.summary.stats.total, 10_000);
  const reads = t.mock.method(manager, "firstRaw");
  t.mock.method(repo, "projection", () => { throw new Error("cache hit loaded inventory"); });
  t.mock.method(repo, "custom", () => { throw new Error("cache hit loaded custom inventory"); });
  const hit = await service.summaryResult(NOW + 1000);
  assert.equal(hit.cache, "hit");
  assert.equal(reads.mock.calls.length, 1);
  assert.equal(hit.summary.stats.total, 10_000);
  assert.equal(hit.summary.snapshot_at, NOW);
  assert.equal(hit.summary.valid_until, NOW + SUMMARY_CACHE_MS);
  assert.ok(hit.summary.stats.expiring[0].daysLeft < cold.summary.stats.expiring[0].daysLeft);
});

test("separate service instances share only active work by database binding", async t => {
  const { manager, service, repo } = await fixture(t, 10_000);
  const calls = t.mock.method(repo, "projection");
  const other = new DomainCatalogService(new DomainCatalogRepository(manager));
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? other : service).summaryResult(NOW)));
  assert.equal(results.filter(result => result.cache === "miss").length, 1);
  assert.equal(results.filter(result => result.cache === "joined").length, 19);
  assert.ok(calls.mock.calls.length <= 1);
  assert.ok(results.every(result => result.summary.stats.total === 10_000));
});

test("cached results survive new manager instances without an in-process data cache", async t => {
  const { service, d1 } = await fixture(t);
  await service.summaryResult(NOW);
  const repo = new DomainCatalogRepository(new DatabaseManager(d1, TEST_AES_KEY));
  t.mock.method(repo, "projection", () => { throw new Error("did not use persisted cache"); });
  assert.equal((await new DomainCatalogService(repo).summaryResult(NOW + 1000)).cache, "hit");
});

test("account updates, domain writes and date overrides invalidate all offset variants", async t => {
  const { manager, service } = await fixture(t);
  await service.summaryResult(NOW, 0); await service.summaryResult(NOW, -480);
  await manager.executeRaw("UPDATE accounts SET alias='new alias' WHERE id=1");
  const one = await service.summaryResult(NOW, 0), two = await service.summaryResult(NOW, -480);
  assert.equal(one.cache, "miss"); assert.equal(two.cache, "miss");
  assert.equal(one.summary.stats.recent[0].alias, "new alias");
  await manager.executeRaw("UPDATE domains_cache SET has_dns=0 WHERE id=1");
  assert.equal((await service.summaryResult(NOW)).summary.account_counts[1].has_dns, 0);
  await manager.upsertDateOverride(1, "d-1.example.com", { expires_at: "2026-11-01" });
  assert.equal((await service.summaryResult(NOW)).summary.stats.expired, 1);
  await manager.deleteDateOverride(1, "d-1.example.com");
  assert.equal((await service.summaryResult(NOW)).summary.stats.expired, 0);
});

test("custom CRUD and cascading account deletion invalidate cached totals", async t => {
  const { manager, service } = await fixture(t);
  await service.summaryResult(NOW);
  await manager.executeRaw("INSERT INTO custom_domains(group_id,full_domain,expires_at) VALUES(3,'manual.example.com','2027-01-01')");
  assert.equal((await service.summaryResult(NOW)).summary.stats.total, 2);
  await manager.executeRaw("DELETE FROM accounts WHERE id=3");
  assert.equal((await service.summaryResult(NOW)).summary.stats.total, 1);
});

test("RDAP writes and deletion invalidate expiry statistics while unrelated caches do not", async t => {
  const { manager, service } = await fixture(t);
  await manager.executeRaw(`INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at)
    VALUES(99,2,'','cf.example.com','cf.example.com','active','0000-00-00')`);
  const first = await service.summaryResult(NOW);
  await manager.setCache(`${RDAP_CACHE_PREFIX}cf.example.com`, JSON.stringify({ found: true, expires_at: "2026-11-01" }));
  assert.equal((await service.summaryResult(NOW)).summary.stats.expired, 1);
  await manager.deleteCache(`${RDAP_CACHE_PREFIX}cf.example.com`);
  assert.equal((await service.summaryResult(NOW)).summary.stats.expired, 0);
  const before = await manager.getSetting(CATALOG_REVISION_KEY);
  await manager.setCache("unrelated_dns_records", "[]");
  await manager.setSetting("unrelated_preference", "changed");
  await manager.writeLog("info", "test", "not a catalog change");
  assert.equal(await manager.getSetting(CATALOG_REVISION_KEY), before);
  assert.equal((await service.summaryResult(NOW)).cache, "hit");
  assert.equal(first.summary.stats.total, 2);
});

test("revision failure rolls back the business write and keeps its old cache valid", async t => {
  const { sqlite, manager, service } = await fixture(t);
  await service.summaryResult(NOW);
  const revision = await manager.getSetting(CATALOG_REVISION_KEY);
  sqlite.exec(`CREATE TRIGGER fail_catalog_revision BEFORE INSERT ON settings WHEN NEW.key='${CATALOG_REVISION_KEY}'
    BEGIN SELECT RAISE(ABORT,'revision failure'); END`);
  await assert.rejects(() => manager.executeRaw("UPDATE accounts SET alias='must rollback' WHERE id=1"), /revision failure/);
  assert.equal((await manager.firstRaw<{ alias: string }>("SELECT alias FROM accounts WHERE id=1"))!.alias, "dnshe");
  assert.equal(await manager.getSetting(CATALOG_REVISION_KEY), revision);
  assert.equal((await service.summaryResult(NOW)).cache, "hit");
});

test("source constraint failure cannot advance its revision", async t => {
  const { manager, service } = await fixture(t);
  await service.summaryResult(NOW);
  const before = await manager.getSetting(CATALOG_REVISION_KEY);
  await assert.rejects(() => manager.executeRaw("UPDATE accounts SET api_key='fixture-two' WHERE id=1"), /UNIQUE/);
  assert.equal(await manager.getSetting(CATALOG_REVISION_KEY), before);
  assert.equal((await service.summaryResult(NOW)).cache, "hit");
});

test("mutations during projection cannot publish or persist a stale summary", async t => {
  const { repo, service, manager } = await fixture(t);
  const original = repo.projection.bind(repo);
  let once = true;
  t.mock.method(repo, "projection", async () => {
    const rows = await original();
    if (once) { once = false; await manager.executeRaw("DELETE FROM domains_cache WHERE id=1"); }
    return rows;
  });
  const result = await service.summaryResult(NOW);
  assert.equal(result.summary.stats.total, 0);
  assert.equal((await service.summaryResult(NOW)).cache, "hit");
});

test("cache expiry is capped before an actual expiration and the 90-day eligibility boundary", async t => {
  const { manager, service } = await fixture(t);
  await manager.executeRaw("UPDATE domains_cache SET expires_at=? WHERE id=1", [new Date(NOW + 2000).toISOString()]);
  const first = await service.summaryResult(NOW);
  assert.equal(first.summary.valid_until, NOW + 2001);
  assert.equal((await service.summaryResult(NOW + 1000)).cache, "hit");
  assert.equal((await service.summaryResult(NOW + 3000)).summary.stats.expired, 1);
  await manager.executeRaw("UPDATE domains_cache SET expires_at=? WHERE id=1", [new Date(NOW + 90 * 86400000 + 2000).toISOString()]);
  assert.equal((await service.summaryResult(NOW)).summary.stats.expiringTotal, 0);
  assert.equal((await service.summaryResult(NOW + 3000)).summary.stats.expiringTotal, 1);
});

test("natural RDAP expiry and month rollover invalidate even without a write", async t => {
  const { manager, service } = await fixture(t);
  await manager.executeRaw(`INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at)
    VALUES(99,2,'','cf.example.com','cf.example.com','active','0000-00-00')`);
  await manager.executeRaw("INSERT INTO cache(key,value,expires_at) VALUES(?,?,?)",
    [`${RDAP_CACHE_PREFIX}cf.example.com`, JSON.stringify({ found: true, expires_at: "2027-01-01" }), NOW / 1000 + 2]);
  assert.equal((await service.summaryResult(NOW)).summary.stats.timeline.permanentCount, 0);
  assert.equal((await service.summaryResult(NOW + 3000)).summary.stats.timeline.permanentCount, 1);
  const at = Date.parse("2026-11-30T23:59:59Z");
  assert.equal((await service.summaryResult(at)).summary.stats.timeline.buckets[0].key, "2026-11");
  assert.equal((await service.summaryResult(at + 2000)).summary.stats.timeline.buckets[0].key, "2026-12");
});

test("operator bypass repairs out-of-band edits and malformed cache entries are never served", async t => {
  const { sqlite, manager, service } = await fixture(t);
  await service.summaryResult(NOW);
  sqlite.exec("UPDATE accounts SET alias='raw operator edit' WHERE id=1");
  assert.equal((await service.summaryResult(NOW, 0, true)).summary.stats.recent[0].alias, "raw operator edit");
  await manager.executeRaw("UPDATE cache SET value='not-json' WHERE key=?", [`${CATALOG_CACHE_PREFIX}0`]);
  assert.equal((await service.summaryResult(NOW)).cache, "miss");
  const data = (await manager.firstRaw<{ value: string }>("SELECT value FROM cache WHERE key=?", [`${CATALOG_CACHE_PREFIX}0`]))!;
  const envelope = JSON.parse(data.value); envelope.summary = { stats: { total: 0 } };
  await manager.executeRaw("UPDATE cache SET value=? WHERE key=?", [JSON.stringify(envelope), `${CATALOG_CACHE_PREFIX}0`]);
  assert.equal((await service.summaryResult(NOW)).summary.stats.total, 1);
});

test("optional cache-storage failure returns a fresh summary, but version-read failure fails closed", async t => {
  const { d1 } = await fixture(t);
  const failedCache = new DatabaseManager(failDatabaseOperation(d1, sql => sql.startsWith("INSERT INTO cache"), "run"), TEST_AES_KEY);
  const result = await new DomainCatalogService(new DomainCatalogRepository(failedCache)).summaryResult(NOW);
  assert.equal(result.summary.stats.total, 1);
  const failedVersion = new DatabaseManager(failDatabaseOperation(d1, sql => sql.includes("SELECT value FROM settings WHERE key=?"), "first"), TEST_AES_KEY);
  await assert.rejects(() => new DomainCatalogService(new DomainCatalogRepository(failedVersion)).summaryResult(NOW), /Injected database failure/);
});

test("bindings and timezone variants do not share cached payloads", async t => {
  const one = await fixture(t, 1), two = await fixture(t, 2);
  const [a, b] = await Promise.all([one.service.summaryResult(NOW, -480), two.service.summaryResult(NOW, -480)]);
  assert.equal(a.summary.stats.total, 1); assert.equal(b.summary.stats.total, 2);
  assert.equal((await one.service.summaryResult(NOW, 0)).cache, "miss");
});

test("prepared writes preserve bind immutability, RETURNING, batch length and session behavior", async t => {
  const { d1, manager } = await fixture(t);
  const db = versionedCatalogDatabase(d1);
  const template = db.prepare("UPDATE accounts SET alias=? WHERE id=1 RETURNING id,alias");
  const one = template.bind("one"), two = template.bind("two");
  assert.equal((await one.first<{ alias: string }>())!.alias, "one");
  assert.equal((await two.all<{ alias: string }>()).results[0].alias, "two");
  assert.deepEqual(await template.bind("three").raw({ columnNames: true }), [["id", "alias"], [1, "three"]]);
  const results = await db.batch([template.bind("four"), db.prepare("SELECT alias FROM accounts WHERE id=1")]);
  assert.equal(results.length, 2);
  const session = db.withSession("first-primary");
  assert.equal(await session.prepare("UPDATE accounts SET alias='session' WHERE id=1 RETURNING alias").first("alias"), "session");
  assert.equal((await manager.firstRaw<{ alias: string }>("SELECT alias FROM accounts WHERE id=1"))!.alias, "session");
  await assert.rejects(() => db.batch([d1.prepare("SELECT id FROM accounts")]), /same database/);
  assert.throws(() => db.exec("DELETE FROM accounts"), /prepare\/batch/);
  assert.throws(() => db.exec("SELECT 1; DELETE FROM accounts"), /prepare\/batch/);
});

test("backup restoration participates in the same cache revision transaction", async t => {
  const { service, manager } = await fixture(t);
  const backup = await manager.exportAllData();
  await service.summaryResult(NOW);
  (backup.data.accounts[0] as { alias: string }).alias = "restored alias";
  backup.metadata.checksum = await backupChecksum(backup);
  await manager.importAllData(backup);
  const result = await service.summaryResult(NOW);
  assert.equal(result.cache, "miss");
  assert.equal(result.summary.stats.recent[0].alias, "restored alias");
});

test("non-catalog cleanup leases keep RETURNING behavior and do not invalidate a summary", async t => {
  const { service, manager, d1 } = await fixture(t);
  await service.summaryResult(NOW);
  const revision = await manager.getSetting(CATALOG_REVISION_KEY);
  const db = versionedCatalogDatabase(d1);
  assert.equal(await db.prepare("INSERT INTO cache(key,value,expires_at) VALUES('notification_cleanup','1',1) RETURNING key").first("key"), "notification_cleanup");
  await manager.syncQueue().recover();
  assert.equal(await manager.getSetting(CATALOG_REVISION_KEY), revision);
  assert.equal((await service.summaryResult(NOW)).cache, "hit");
});
