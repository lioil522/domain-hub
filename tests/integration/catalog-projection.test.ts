import assert from "node:assert/strict";
import { test } from "node:test";
import { testDatabase, failDatabaseOperation, TEST_AES_KEY } from "../helpers/database";
import { semanticFixture, selectionFixture } from "../helpers/catalog-semantic-fixture";
import { computeDashboardStats, type DashboardStatsOptions, type SummaryDomain } from "../../shared/dashboard-stats";
import { normalizeDomainKey } from "../../shared/domain-keys";
import { CatalogProjectionPrototype, PROJECTION_AGGREGATE_SQL } from "../prototypes/catalog-projection";
import { DatabaseManager } from "../../src/db";
import { DomainCatalogRepository } from "../../src/repositories/domain-catalog-repository";
import { DomainCatalogService } from "../../src/services/domain-catalog-service";
import { captureProjectionInput } from "../prototypes/catalog-projection-capture";
import { RDAP_CACHE_PREFIX } from "../../src/db";

const NOW = Date.parse("2026-11-24T00:00:00Z");
function empty(patch: Partial<DashboardStatsOptions> = {}): DashboardStatsOptions {
  return { domains: [], cfZones: [], dpDomains: [], customDomains: [],
    multiProviderDomains: { dnspod: [], alidns: [], huaweicloud: [], vercel: [] },
    dnsheAccounts: [], cfAccountList: [], dpAccountList: [], customGroupList: [],
    multiProviderAccounts: { dnspod: [], alidns: [], huaweicloud: [], vercel: [] }, cfExpiryMap: {}, ...patch };
}
const row = (name: string, expiry: string, created = ""): SummaryDomain => ({ full_domain: name, expires_at: expiry,
  created_at: created, account_alias: name });
function compare(actual: ReturnType<typeof computeDashboardStats>, expected: ReturnType<typeof computeDashboardStats>,
  mode: string, input: DashboardStatsOptions) {
  if (mode === "sql-top-six") { assert.deepEqual(actual, expected); return; }
  // Preserve the user's legacy NaN comparator policy, not a fictional
  // cross-runtime/JIT permutation guarantee.
  const { recent: a, ...stableA } = actual, { recent: b, ...stableB } = expected;
  assert.deepEqual(stableA, stableB);
  assert.equal(a.length, b.length);
  const candidates = new Map<string, { full_domain: string; created_at: string | undefined; source: string; alias: string }>();
  const sources = [[input.domains, "DNSHE"], [input.cfZones, "Cloudflare"], [input.dpDomains, "DigitalPlat"],
    [input.multiProviderDomains.dnspod, "DNSPod"], [input.multiProviderDomains.alidns, "阿里云 DNS"],
    [input.multiProviderDomains.huaweicloud, "华为云 DNS"], [input.multiProviderDomains.vercel, "Vercel"]] as const;
  for (const [rows, source] of sources) for (const domain of rows) {
    const key = normalizeDomainKey(domain.full_domain);
    if (!key || !domain.created_at || candidates.has(key)) continue;
    candidates.set(key, { full_domain: domain.full_domain, created_at: domain.created_at, source, alias: domain.account_alias });
  }
  assert.equal(new Set(a.map(item => normalizeDomainKey(item.full_domain))).size, a.length);
  for (const item of a) assert.deepEqual(item, candidates.get(normalizeDomainKey(item.full_domain)));
}

test("prototype SQL matches canonical stats for seeded Unicode, date, source and stable-order cases", async t => {
  const { d1 } = await testDatabase(t);
  for (const seed of [1, 2, 3, 7, 18, 19, 25, 50, 77, 100]) for (const offset of [-480, 0, 330]) {
    for (const input of [semanticFixture(seed), selectionFixture(seed)]) {
      const writer = new CatalogProjectionPrototype(d1);
      const staged = await writer.stage(input, { validatedAt: NOW, offset });
      const result = await new CatalogProjectionPrototype(d1).read(staged.generation, NOW, offset);
      compare(result.stats, computeDashboardStats(input, NOW, 20, offset), result.recentMode, input);
      const fold = new CatalogProjectionPrototype(d1, "folded");
      const gen = await fold.stage(input, { validatedAt: NOW, offset });
      const folded = await fold.read(gen.generation, NOW, offset);
      assert.equal(folded.recentMode, result.recentMode);
      compare(folded.stats, result.stats, folded.recentMode, input);
      if (seed === 1 || seed === 18) {
        const original = await new CatalogProjectionPrototype(d1, "baseline").read(staged.generation, NOW, offset);
        compare(result.stats, original.stats, result.recentMode, input);
      }
    }
  }
});

test("empty and blank-key inventories remain legitimate zero statistics, not malformed-page fallbacks", async t => {
  const { d1 } = await testDatabase(t);
  for (const input of [empty(), empty({ domains: [row("", "2027-01-05", "invalid")] })]) {
    const writer = new CatalogProjectionPrototype(d1), staged = await writer.stage(input, { validatedAt: NOW, offset: 0 });
    const result = await writer.read(staged.generation, NOW, 0);
    assert.deepEqual(result.stats, computeDashboardStats(input, NOW, 20, 0));
    assert.equal(result.stats.total, 0);
  }
});

test("finite large inventory readers return bounded aggregate rows without full inventory transfer", async t => {
  const { d1, sqlite } = await testDatabase(t);
  const input = empty({ domains: Array.from({ length: 10000 }, (_, i) => row(`item-${i}.example`, "2027-01-05", "2026-11-23")) });
  const writer = new CatalogProjectionPrototype(d1), staged = await writer.stage(input, { validatedAt: NOW, offset: 0 });
  assert.ok(staged.pages >= 40);
  const reader = new CatalogProjectionPrototype(d1), result = await reader.read(staged.generation, NOW, 0);
  assert.equal(result.recentMode, "sql-top-six");
  assert.equal(result.metrics.returnedRows, 2, "empty revision reads return no rows");
  assert.equal(result.metrics.calls, 4);
  assert.equal(result.stats.total, 10000);
  assert.equal(result.stats.timeline.buckets.find(bucket => bucket.key === "2027-01")?.count, 10000);
  assert.equal(result.stats.timeline.buckets.find(bucket => bucket.key === "2027-01")?.items.length, 20);
  assert.deepEqual(result.stats, computeDashboardStats(input, NOW, 20, 0));
  const scope = reader.queryScope(staged.generation, NOW);
  const months = Array.from({ length: 12 }, (_, slot) => ({ slot, start: Date.UTC(2026, 10 + slot, 1), end: Date.UTC(2026, 11 + slot, 1) }));
  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${PROJECTION_AGGREGATE_SQL}`).all(...scope, JSON.stringify(months))
    .map(row => row.detail).join(" ");
  assert.match(plan, /sqlite_autoindex_cache/);
  assert.ok(result.metrics.returnedBytes < 100000);
});

test("projected times are reevaluated at read time but metadata age, offset and revision remain guarded", async t => {
  const { d1, sqlite } = await testDatabase(t);
  const input = empty({ domains: [row("time.example", new Date(NOW + 120000).toISOString())] });
  const writer = new CatalogProjectionPrototype(d1), staged = await writer.stage(input, { validatedAt: NOW, offset: 0 });
  const later = await new CatalogProjectionPrototype(d1).read(staged.generation, NOW + 120001, 0);
  assert.equal(later.stats.expired, 1);
  assert.deepEqual(later.stats, computeDashboardStats(input, NOW + 120001, 20, 0));
  await assert.rejects(() => writer.read(staged.generation, NOW, -480), /scope/);
  await assert.rejects(() => writer.read(staged.generation, NOW + 300000, 0), /validity/);
  const expiringMetadata = await writer.stage(input, { validatedAt: NOW, offset: 0, sourceValidUntil: NOW + 60000 });
  await assert.rejects(() => writer.read(expiringMetadata.generation, NOW + 60000, 0), /validity/);
  sqlite.prepare("INSERT INTO settings(key,value) VALUES('catalog_summary_revision','changed')").run();
  await assert.rejects(() => writer.read(staged.generation, NOW, 0), /revision/);
});

test("folded rows keep raw expiry OR, winner identity, first-finite order and registration identity across time boundaries", async t => {
  const { d1, manager } = await testDatabase(t);
  const start = Date.parse("2027-01-31T23:59:00Z"), at = start + 60000;
  const near = new Date(at).toISOString(), later = new Date(at + 1000).toISOString();
  const input = empty({ domains: [
    row("a.example", "", ""), row("b.example", later, near), row("c.example", near, near),
    row("cutoff.example", new Date(at + 90*86400000).toISOString()),
    row("raw-only.example", near, later), row("permanent.example",near),
  ], cfZones: [row("A.example.", later, later), row("raw-only.example", "", "")],
    dpDomains: [row("B.example.", near, later), { ...row("status.example", "0000-00-00"), status: "已过期" }],
    cfExpiryMap: { "permanent.example": { manual: true, found: false }, "raw-only.example": { found: true, expires_at: later } } });
  const fold = new CatalogProjectionPrototype(d1,"folded");
  const gen = await fold.stage(input,{ validatedAt:start, offset:0, sourceValidUntil:start+180000 });
  assert.equal(gen.source_rows, 10);
  assert.equal(gen.rows, 7);
  for (const now of [start,at-1,at,at+1,at+1001]) {
    assert.deepEqual((await fold.read(gen.generation,now,0)).stats,computeDashboardStats(input,now,20,0));
  }
  await assert.rejects(() => fold.read(gen.generation,at,-480), /scope/);
  await assert.rejects(() => fold.read(gen.generation,start+180000,0), /expired/);
  await manager.executeRaw("INSERT INTO accounts(alias,api_key,api_secret,provider) VALUES('change','test-key','fake','dnshe')");
  await assert.rejects(() => fold.read(gen.generation,at,0), /revision/);
});

test("folded storage rejects duplicate canonical rows or missing nested registration positions even at matching byte size", async t => {
  const { d1, sqlite } = await testDatabase(t);
  const input = empty({domains:[row("a.example","2027-01-01","invalid"),row("b.example","2027-01-02","2026-01-01")]});
  for (const corrupt of ["duplicate-domain","duplicate-first-finite","duplicate-registration","missing-registration","missing-page"]) {
    const fold = new CatalogProjectionPrototype(d1,"folded"), g = await fold.stage(input,{validatedAt:NOW,offset:0});
    const key = `catalog_prototype:2:${g.generation}:rows:00000000`;
    const raw = String(sqlite.prepare("SELECT value FROM cache WHERE key=?").get(key)?.value);
    if (corrupt === "missing-page") sqlite.prepare("DELETE FROM cache WHERE key=?").run(key);
    else {
      const [a,b] = JSON.parse(raw);
      if (corrupt === "duplicate-domain") b.canonical=a.canonical;
      if (corrupt === "duplicate-first-finite") b.first_finite=a.first_finite;
      if (corrupt === "duplicate-registration") b.registration.pos=a.registration.pos;
      if (corrupt === "missing-registration") delete b.registration.pos;
      const updated = JSON.stringify([a,b]);
      sqlite.prepare("UPDATE cache SET value=? WHERE key=?").run(updated,key);
      sqlite.prepare("UPDATE cache SET value=json_set(value,'$.encoded_bytes',?) WHERE key=?")
        .run(Buffer.byteLength(updated),`catalog_prototype:2:${g.generation}:manifest`);
    }
    await assert.rejects(() => fold.read(g.generation,NOW,0), /malformed|incomplete/,corrupt);
    await assert.rejects(() => new CatalogProjectionPrototype(d1).read(g.generation,NOW,0),/manifest/);
  }
});

test("folded builder does not silently approximate extreme dates or admit unlimited discarded source rows", async t => {
  const { d1 } = await testDatabase(t);
  const fold = new CatalogProjectionPrototype(d1,"folded");
  const extreme = empty({domains:[row("extreme.example","+250000-01-01T00:00:00Z")]});
  await assert.rejects(() => fold.stage(extreme,{validatedAt:NOW,offset:0}), /cannot prove expiry order/);
  const copies = empty({domains:Array.from({length:80},()=>row("same.example","",""))});
  await assert.rejects(() => fold.stage(copies,{validatedAt:NOW,offset:0,generationBytes:2048}), /source contribution budget/);
  assert.equal(copies.domains.length,80);
  for (const data of [empty(),empty({domains:[row("",new Date(NOW).toISOString(),"invalid")]})]) {
    const gen = await fold.stage(data,{validatedAt:NOW,offset:0});
    assert.equal(gen.pages,0);
    assert.deepEqual((await fold.read(gen.generation,NOW,0)).stats,computeDashboardStats(data,NOW,20,0));
  }
});

test("legacy invalid first registrations keep their first source and explicitly use full-sort fallback", async t => {
  const { d1 } = await testDatabase(t);
  const input = empty({ domains: Array.from({ length: 100 }, (_, i) => row(`bad-${i}.example`, "0000-00-00", "invalid")) });
  input.cfZones = [row("bad-0.example", "2027-01-05", "2026-11-23")];
  const writer = new CatalogProjectionPrototype(d1), staged = await writer.stage(input, { validatedAt: NOW, offset: 0 });
  const result = await new CatalogProjectionPrototype(d1).read(staged.generation, NOW, 0);
  assert.equal(result.recentMode, "legacy-full-sort");
  assert.equal(result.metrics.returnedRows, 102);
  assert.deepEqual(result.stats, computeDashboardStats(input, NOW, 20, 0));
  assert.equal(result.stats.recent[0].created_at, "invalid");
  assert.equal(result.stats.recent[0].source, "DNSHE");
});

test("missing, malformed and unsupported projection rows cannot become successful partial statistics", async t => {
  const { d1, sqlite } = await testDatabase(t);
  const input = empty({ domains: [row("one.example", "2027-01-05")] });
  for (const corruption of ["delete", "bad-json", "bad-format"]) {
    const writer = new CatalogProjectionPrototype(d1), staged = await writer.stage(input, { validatedAt: NOW, offset: 0 });
    const key = `catalog_prototype:1:${staged.generation}:rows:00000000`;
    if (corruption === "delete") sqlite.prepare("DELETE FROM cache WHERE key=?").run(key);
    else if (corruption === "bad-json") sqlite.prepare("UPDATE cache SET value='invalid' WHERE key=?").run(key);
    else sqlite.prepare("UPDATE cache SET value=? WHERE key=?").run(JSON.stringify([{ canonical: "fake", ordinal: 0 }]), key);
    await assert.rejects(() => writer.read(staged.generation, NOW, 0), /incomplete|malformed/);
  }
});

test("projection whitelists fields and rejects oversized rows without modifying original inputs", async t => {
  const { d1, sqlite } = await testDatabase(t);
  const domain = { ...row("safe.example", "2027-01-05"), api_key: "never-stage-credential", api_secret: "never-stage-secret" };
  const input = empty({ domains: [domain] });
  const writer = new CatalogProjectionPrototype(d1), staged = await writer.stage(input, { validatedAt: NOW, offset: 0 });
  const data = sqlite.prepare("SELECT value FROM cache WHERE key LIKE ?").all(`catalog_prototype:1:${staged.generation}:%`);
  assert.ok(!JSON.stringify(data).includes("never-stage"));
  const large = empty({ domains: [{ ...domain, account_alias: "x".repeat(200000) }] });
  await assert.rejects(() => writer.stage(large, { validatedAt: NOW, offset: 0 }), /page budget/);
  assert.equal(large.domains[0].account_alias.length, 200000);
  assert.equal(domain.api_key, "never-stage-credential");
  assert.ok(sqlite.prepare("SELECT value FROM cache WHERE value LIKE '%\"status\":\"failed\"%'").all().length > 0);
});

test("ill-formed Unicode fields fail admission instead of changing bytes through SQLite JSON decoding", async t => {
  const { d1 } = await testDatabase(t);
  const input = empty({ domains: [row("bad-\ud800.example", "2027-01-05")] });
  await assert.rejects(() => new CatalogProjectionPrototype(d1).stage(input, { validatedAt: NOW, offset: 0 }), /UTF-16/);
  assert.equal(input.domains[0].full_domain, "bad-\ud800.example");
  const valid = empty({ domains: [row("😀.example", "2027-01-05", "2026-11-23")] });
  const writer = new CatalogProjectionPrototype(d1), staged = await writer.stage(valid, { validatedAt: NOW, offset: 0 });
  assert.deepEqual((await writer.read(staged.generation, NOW, 0)).stats, computeDashboardStats(valid, NOW, 20, 0));
});

test("whole-generation storage admission is bounded independently of individual page limits", async t => {
  const { d1, sqlite } = await testDatabase(t);
  const input = empty({ domains: [row("one.example", "2027-01-05"), row("two.example", "2027-01-05"), row("three.example", "2027-01-05")] });
  await assert.rejects(() => new CatalogProjectionPrototype(d1).stage(input, {
    validatedAt: NOW, offset: 0, generationBytes: 1024,
  }), /generation storage budget/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM cache WHERE value LIKE '%\"status\":\"ready\"%'").get()?.n, 0);
  assert.equal(input.domains.length, 3);
});

test("failed database envelopes and source mutations during staging cannot mark a projection ready", async t => {
  const { d1, sqlite } = await testDatabase(t);
  const input = empty({ domains: [row("one.example", "2027-01-05")] });
  const failure = failDatabaseOperation(d1, sql => sql.includes("SELECT value FROM settings"), "all");
  await assert.rejects(() => new CatalogProjectionPrototype(failure).stage(input, { validatedAt: NOW, offset: 0 }), /Injected/);
  const batch = d1.batch.bind(d1);
  t.mock.method(d1, "batch", async statements => {
    const result = await batch(statements);
    sqlite.prepare("INSERT INTO settings(key,value) VALUES('catalog_summary_revision','next') ON CONFLICT(key) DO UPDATE SET value='next'").run();
    return result;
  });
  await assert.rejects(() => new CatalogProjectionPrototype(d1).stage(input, { validatedAt: NOW, offset: 0 }), /revision/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM cache WHERE value LIKE '%\"status\":\"ready\"%'").get()?.n, 0);
  // Keep the shared manager constructible; the prototype must not migrate or
  // replace the real business schema/key mechanism.
  assert.equal(await new DatabaseManager(d1, TEST_AES_KEY).ensureTables(), true);
});

test("read-only real repository capture preserves custom group/account identity and cached/manual expiry priority", async t => {
  const { d1, sqlite, manager } = await testDatabase(t);
  sqlite.exec(`INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES
    (1,'DNSHE','private-key-one','private-secret-one','dnshe'),(2,'Cloudflare','private-key-two','private-secret-two','cloudflare'),
    (3,'Manual group','private-key-three','private-secret-three','custom');
    INSERT INTO custom_accounts(id,group_id,name) VALUES(9,3,'nested custom owner');
    INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at,created_at) VALUES
    (101,1,'','example','same.example','active','2027-01-05','2026-11-01'),
    (201,2,'','example','SAME.example.','active','0000-00-00','2026-11-23');
    INSERT INTO custom_domains(id,group_id,account_id,full_domain,expires_at) VALUES(301,3,9,'manual.example','2027-03-01');
    INSERT INTO domain_date_overrides(account_id,full_domain,expires_at,updated_at)
    VALUES(2,'same.example','2027-02-01','2026-11-23')`);
  sqlite.prepare("INSERT INTO cache(key,value,expires_at) VALUES(?,?,?)")
    .run(`${RDAP_CACHE_PREFIX}same.example`, JSON.stringify({ found: true, expires_at: "2026-12-01" }), Math.floor(NOW / 1000) + 60);
  const captured = await captureProjectionInput(manager, NOW);
  const expected = await new DomainCatalogService(new DomainCatalogRepository(manager)).summary(NOW);
  const writer = new CatalogProjectionPrototype(d1), staged = await writer.stage(captured.input, {
    validatedAt: NOW, offset: 0, revision: captured.revision, sourceValidUntil: captured.sourceValidUntil,
  });
  const result = await new CatalogProjectionPrototype(d1).read(staged.generation, NOW, 0);
  assert.deepEqual(result.stats, expected.stats);
  const payload = sqlite.prepare("SELECT value FROM cache WHERE key LIKE ? ORDER BY key").all(`catalog_prototype:1:${staged.generation}:rows:%`);
  const records = payload.flatMap(item => JSON.parse(String(item.value))) as Array<{ table: string; inventory_id: number; group_id: number; account_id: number }>;
  const custom = records.find(item => item.table === "custom")!;
  assert.equal(custom.inventory_id, 301); assert.equal(custom.group_id, 3); assert.equal(custom.account_id, 9);
  assert.ok(!JSON.stringify(payload).includes("private-key") && !JSON.stringify(payload).includes("private-secret"));
  await assert.rejects(() => writer.read(staged.generation, NOW + 60000, 0), /validity/);
});

test("false success envelopes fail closed and oversized aggregate output is rejected rather than truncated", async t => {
  const { d1 } = await testDatabase(t);
  const input = empty({ domains: [row("one.example", "2027-01-05")] });
  const writer = new CatalogProjectionPrototype(d1), staged = await writer.stage(input, { validatedAt: NOW, offset: 0 });
  const failing = new Proxy(d1, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const statement = target.prepare(sql);
      if (!sql.includes("invalid_pages")) return statement;
      const wrap = (item: D1PreparedStatement): D1PreparedStatement => new Proxy(item, { get(native, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(native.bind(...values));
        if (property === "all") return async () => ({ success: false, results: [], meta: {} });
        const value = Reflect.get(native, property); return typeof value === "function" ? value.bind(native) : value;
      } });
      return wrap(statement);
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(() => new CatalogProjectionPrototype(failing).read(staged.generation, NOW, 0), /result failed/);
  const big = empty({ domains: Array.from({ length: 4 }, (_, i) => ({
    ...row(`large-${i}.example`, "2027-01-05", "2026-11-23"), account_alias: "x".repeat(60000),
  })) });
  const largeStage = await writer.stage(big, { validatedAt: NOW, offset: 0 });
  await assert.rejects(() => writer.read(largeStage.generation, NOW, 0), /summary budget/);
  assert.equal(big.domains[0].account_alias.length, 60000);
});

test("null-safe optimized audit rejects missing fields even when byte and row counts still match", async t => {
  const { d1, sqlite } = await testDatabase(t);
  const input = empty({ domains: [row("one.example", "2027-01-05", "2026-11-23")] });
  const required = ["canonical", "full_domain", "alias", "source", "table", "raw_expiry", "raw_status",
    "resolved_expiry", "created_at", "ordinal", "source_rank", "inventory_id", "permanent",
    "raw_status_expired", "created_present", "raw_time", "resolved_time", "created_time", "account_id", "group_id"];
  for (const field of required) {
    const writer = new CatalogProjectionPrototype(d1), staged = await writer.stage(input, { validatedAt: NOW, offset: 0 });
    const key = `catalog_prototype:1:${staged.generation}:rows:00000000`;
    const records = JSON.parse(String(sqlite.prepare("SELECT value FROM cache WHERE key=?").get(key)?.value)) as Array<Record<string, unknown>>;
    delete records[0][field];
    const changed = JSON.stringify(records), manifestKey = `catalog_prototype:1:${staged.generation}:manifest`;
    // Match the altered encoded byte size so this tests schema validation,
    // not merely the separate byte-count fence.
    const storedManifest = JSON.parse(String(sqlite.prepare("SELECT value FROM cache WHERE key=?").get(manifestKey)?.value)) as Record<string, unknown>;
    storedManifest.encoded_bytes = Buffer.byteLength(changed);
    sqlite.prepare("UPDATE cache SET value=? WHERE key=?").run(changed, key);
    sqlite.prepare("UPDATE cache SET value=? WHERE key=?").run(JSON.stringify(storedManifest), manifestKey);
    await assert.rejects(() => writer.read(staged.generation, NOW, 0), /malformed/, field);
    await assert.rejects(() => new CatalogProjectionPrototype(d1, "baseline").read(staged.generation, NOW, 0), /malformed/, field);
  }
});

test("invalid audit suppresses derived output before the combined reader rejects the generation", async t => {
  const { d1, sqlite } = await testDatabase(t);
  const input = empty({ domains: [row("one.example", "2027-01-05", "2026-11-23")] });
  const writer = new CatalogProjectionPrototype(d1), staged = await writer.stage(input, { validatedAt: NOW, offset: 0 });
  const key = `catalog_prototype:1:${staged.generation}:rows:00000000`;
  sqlite.prepare("UPDATE cache SET value='[]' WHERE key=?").run(key);
  const scope = writer.queryScope(staged.generation, NOW, staged);
  const query = sqlite.prepare(PROJECTION_AGGREGATE_SQL).get(...scope, JSON.stringify([]))!;
  assert.equal(query.valid, 0);
  assert.equal(query.warnings, "[]"); assert.equal(query.bucket_items, "[]"); assert.equal(query.recent, "[]");
  await assert.rejects(() => writer.read(staged.generation, NOW, 0), /incomplete/);
});

test("late display hydration preserves urgency order, same-day first-finite ties and recent source order", async t => {
  const { d1 } = await testDatabase(t);
  const input = empty({ domains: [
    row("a.example", "2027-01-05T23:00:00Z", "2026-11-23"),
    row("b.example", "2027-01-05T00:00:00Z", "2026-11-23"),
    row("c.example", "0000-00-00", "2026-11-23"),
    row("d.example", "2027-01-05T12:00:00Z", "2026-11-23"),
  ], cfZones: [row("c.example", "2027-01-05T23:00:00Z", "2026-11-23")],
    dpDomains: [{ ...row("A.example.", "2027-01-05T20:00:00Z", "2026-11-23"), account_alias: "late replacement" }] });
  const writer = new CatalogProjectionPrototype(d1), staged = await writer.stage(input, { validatedAt: NOW, offset: 0 });
  const result = await writer.read(staged.generation, NOW, 0);
  assert.deepEqual(result.stats, computeDashboardStats(input, NOW, 20, 0));
  assert.deepEqual(result.stats.expiring.map(item => normalizeDomainKey(item.full_domain)), ["b.example", "d.example", "a.example", "c.example"]);
  assert.deepEqual(result.stats.timeline.buckets.find(bucket => bucket.key === "2027-01")?.items.map(item => normalizeDomainKey(item.full_domain)),
    ["a.example", "b.example", "d.example", "c.example"]);
  assert.deepEqual(result.stats.recent.map(item => item.full_domain), ["a.example", "b.example", "c.example", "d.example"]);
});
