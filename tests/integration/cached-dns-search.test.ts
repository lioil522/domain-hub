import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { testDatabase, TEST_AES_KEY, failDatabaseOperation } from "../helpers/database";
import { DatabaseManager } from "../../src/db";
import { CachedDnsSearchRepository } from "../../src/repositories/cached-dns-search-repository";
import { DomainCatalogRepository } from "../../src/repositories/domain-catalog-repository";
import { DomainCatalogService, CatalogQueryError } from "../../src/services/domain-catalog-service";
import { SearchService } from "../../src/services/search-service";
import { CATALOG_PROVIDERS } from "../../shared/domain-catalog";
import { toASCII } from "../../shared/punycode";
import worker from "../../src/index";

async function fixture(t: TestContext, count = 180) {
  const data = await testDatabase(t);
  const { sqlite, manager } = data;
  for (const [i, provider] of CATALOG_PROVIDERS.entries()) {
    sqlite.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(?,?,?,?,?)")
      .run(i + 1, `owner-${provider}`, `forbidden-key-${i}`, "plain:c2VjcmV0", provider);
  }
  const insert = sqlite.prepare(`INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at)
    VALUES(?,?,'','example.net',?,'已解析','2035-01-01')`);
  sqlite.exec("BEGIN");
  for (let id = 1; id <= count; id++) insert.run(id, 1, `inventory-${id}.example.net`);
  for (let i = 1; i < 7; i++) insert.run(i * 10000 + 1, i + 1, `managed-${i}.example.net`);
  sqlite.prepare("INSERT INTO custom_domains(id,group_id,full_domain,expires_at) VALUES(1,8,'manual.example.net','2035-01-01')").run();
  sqlite.exec("COMMIT");
  const put = (id: number, records: unknown, expiry = Math.floor(Date.now() / 1000) + 3600, prefix = "api_cache:dns:") => {
    sqlite.prepare("INSERT INTO cache(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(`${prefix}${id}`, typeof records === "string" ? records : JSON.stringify(records), expiry);
  };
  const repository = new DomainCatalogRepository(manager), dns = new CachedDnsSearchRepository(manager);
  return { ...data, put, count, dns, repository, catalog: new DomainCatalogService(repository, dns), legacy: new SearchService(manager), insert };
}
const cached = (content = "192.0.2.42", name = "@", id = "reused-record-id") => [{ id, type: "TXT", name, content }];

test("content-only DNS search finds a domain past the old name/50-row filter", async t => {
  const { catalog, legacy, put, count } = await fixture(t);
  put(count, cached());
  assert.equal((await catalog.search("192.0.2.42")).groups.dnshe.total, 0, "default API remains domain-only");
  const hit = await catalog.search("192.0.2.42", "all");
  assert.equal(hit.groups.dnshe.total, 1);
  assert.equal(hit.groups.dnshe.items[0].id, count);
  assert.equal(hit.groups.dnshe.items[0].dns_match?.preview, "192.0.2.42");
  assert.equal(hit.dns_scope, "valid_cached_records");
  const old = await legacy.search("192.0.2.42");
  assert.equal(old.find(row => row.type === "dns")?.metadata?.domainId, count);
});
test("all managed sources search their cached DNS; custom names remain available without invented DNS", async t => {
  const { catalog, legacy, put, count } = await fixture(t);
  put(count, cached());
  for (let i = 1; i < 7; i++) put(i * 10000 + 1, cached());
  const result = await catalog.search("192.0.2.42", "dns");
  for (const provider of CATALOG_PROVIDERS.slice(0, 7)) assert.equal(result.groups[provider].total, 1, provider);
  assert.equal(result.groups.custom.total, 0);
  assert.equal((await catalog.search("manual", "all")).groups.custom.total, 1);
  const rows = (await legacy.search("192.0.2.42", 100)).filter(row => row.type === "dns");
  assert.equal(rows.length, 7);
  assert.equal(new Set(rows.map(row => row.id)).size, 7, "identical upstream record IDs must not collide");
  assert.equal(rows.find(row => row.provider === "cloudflare")?.route, "cloudflare");
});
test("union search counts each inventory row once and keeps bounded source candidates", async t => {
  const { catalog, manager, put, count } = await fixture(t);
  for (let id = 1; id <= 25; id++) put(id, [...cached("findme"), ...cached("findme", "other", "second")]);
  await manager.executeRaw("UPDATE domains_cache SET full_domain='findme.example.net' WHERE id=1");
  const all = await catalog.search("findme", "all");
  assert.equal(all.groups.dnshe.total, 25);
  assert.equal(all.groups.dnshe.items.length, 8);
  assert.equal((await catalog.search("findme", "domain")).groups.dnshe.total, 1);
  assert.equal((await catalog.search("findme", "dns")).groups.dnshe.total, 25);
  assert.equal((await catalog.page({ provider: "dnshe", search: "findme", searchIn: "all", limit: 100 })).total, 25);
  assert.equal(count, 180);
});
test("expired, malformed, oversized, wrong-namespace and orphan caches cannot masquerade as DNS hits", async t => {
  const { dns, put, manager, sqlite } = await fixture(t);
  const before = sqlite.prepare("SELECT COUNT(*) n FROM cache").get()?.n;
  put(1, cached("ignored"), Math.floor(Date.now() / 1000) - 1);
  put(2, "{broken-json-ignored");
  put(3, { records: cached("ignored") });
  put(4, [null, 5, "ignored", { type: "TXT", name: {}, content: "ignored" }, { type: "TXT", content: {} }]);
  put(5, cached("ignored"), undefined, "api_cache:other:");
  put(999999, cached("ignored"));
  put(6, cached("x".repeat(524288) + "ignored"));
  put(7, cached("ignored"), undefined, "api_cache:dns:000");
  await manager.executeRaw("INSERT INTO settings(key,value) VALUES('private_search_fixture','ignored')");
  const bytes = sqlite.prepare("SELECT key,value,expires_at FROM cache ORDER BY key").all();
  assert.deepEqual(await dns.matches("ignored"), []);
  assert.deepEqual(sqlite.prepare("SELECT key,value,expires_at FROM cache ORDER BY key").all(), bytes, "search must not remove/repair data or warm providers");
  assert.equal(before, 0);
});
test("only searchable record fields are examined, with literal wildcard, ASCII case and Chinese TXT matching", async t => {
  const { dns, put, legacy } = await fixture(t);
  put(1, [{ type: "TXT", name: "_VERIFY", content: "缓存测试 token_100% 2001:DB8::BEEF", raw: { secret: "private-hidden-record-field" } }]);
  assert.equal((await dns.matches("缓存测试")).length, 1);
  assert.equal((await dns.matches("token_100%")).length, 1);
  assert.equal((await dns.matches("2001:db8::beef")).length, 1);
  assert.equal((await dns.matches("_verify")).length, 1);
  assert.equal((await dns.matches("TXT")).length, 1);
  assert.deepEqual(await legacy.search("private-hidden-record-field"), []);
  assert.deepEqual(await legacy.search("forbidden-key-1"), []);
});
test("long TXT snippets include the matched token while staying bounded; IDN aliases still work", async t => {
  const { dns, put } = await fixture(t);
  put(1, cached("a".repeat(2000) + "content-tail-token" + "b".repeat(2000)));
  const hit = (await dns.matches("content-tail-token"))[0];
  assert.ok(hit.preview.includes("content-tail-token"));
  assert.ok(hit.preview.length <= 512);
  put(2, cached("target.example", toASCII("测试.example.net")));
  assert.equal((await dns.matches("测试.example.net"))[0].id, 2);
  put(3, cached("😀".repeat(1000) + "emoji-tail-token" + "😀".repeat(1000)));
  const emoji = (await dns.matches("emoji-tail-token"))[0];
  assert.ok(emoji.preview.includes("emoji-tail-token"));
  assert.ok(Array.from(emoji.preview).length <= 512);
});
test("legacy bounded ranking retains a later exact DNS/name match over hundreds of earlier content hits", async t => {
  const { legacy, put, manager } = await fixture(t, 600);
  for (let id = 1; id <= 550; id++) put(id, cached("ranking-token", "@", String(id)));
  put(599, cached("different", "ranking-token", "exact"));
  const result = await legacy.search("ranking-token", 1);
  assert.equal(result[0].metadata?.domainId, 599);
  await manager.executeRaw("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(999,'ranking-token','late-key','plain:c2VjcmV0','custom')");
  assert.equal((await legacy.search("ranking-token", 2))[0].type, "account");
});
test("content-filtered keyset pages preserve counts and tie cursors to their search scope/account", async t => {
  const { catalog, put } = await fixture(t);
  for (const id of [120, 130, 140, 150, 160]) put(id, cached("page-content-token"));
  const first = await catalog.page({ provider: "dnshe", search: "page-content-token", searchIn: "dns", filter: 1, limit: 2 });
  assert.deepEqual(first.domains.map(row => row.id), [120, 130]);
  const next = await catalog.page({ provider: "dnshe", search: "page-content-token", searchIn: "dns", filter: 1, limit: 2, cursor: first.next_cursor! });
  assert.deepEqual(next.domains.map(row => row.id), [140, 150]);
  assert.equal(next.total, 5);
  assert.equal(next.account_counts[1].total, 5);
  await assert.rejects(() => catalog.page({ provider: "dnshe", search: "page-content-token", searchIn: "domain", filter: 1, limit: 2, cursor: first.next_cursor! }), CatalogQueryError);
  assert.equal((await catalog.page({ provider: "dnshe", search: "page-content-token", searchIn: "all", filter: 9, limit: 100 })).total, 0);
});
test("same-name different-account hits locate the exact inventory ID and cannot fall back to a different owner", async t => {
  const { catalog, manager, put, insert } = await fixture(t);
  await manager.executeRaw("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(9,'second owner','second-key','plain:c2VjcmV0','dnshe')");
  await manager.executeRaw("UPDATE domains_cache SET full_domain='same.example.net' WHERE id=1");
  insert.run(100001, 9, "same.example.net");
  put(100001, cached("second-owner-content"));
  const hit = (await catalog.search("second-owner-content", "all")).groups.dnshe.items[0];
  assert.equal(hit.account_id, 9);
  const page = await catalog.page({ provider: "dnshe", filter: hit.account_id, focus: hit.full_domain, focusId: hit.id, limit: 100 });
  assert.equal(page.domains[0].id, 100001);
  await assert.rejects(() => catalog.page({ provider: "dnshe", filter: 1, focus: hit.full_domain, focusId: hit.id, limit: 100 }), CatalogQueryError);
  await assert.rejects(() => catalog.page({ provider: "dnshe", focus: "wrong.example", focusId: hit.id, limit: 100 }), CatalogQueryError);
  await assert.rejects(() => catalog.page({ provider: "dnshe", focus: hit.full_domain, focusId: hit.id, status: "未解析", limit: 100 }), CatalogQueryError);
});
test("target deletion between focus validation and page read fails instead of jumping to the next row", async t => {
  const { catalog, repository, manager } = await fixture(t);
  const focus = repository.focus.bind(repository);
  t.mock.method(repository, "focus", async (input, id) => {
    const row = await focus(input, id);
    await manager.executeRaw("DELETE FROM domains_cache WHERE id=?", [id]);
    return row;
  });
  await assert.rejects(() => catalog.page({ provider: "dnshe", focus: "inventory-120.example.net", focusId: 120, limit: 100 }), /重新搜索/);
});
test("search never hydrates credentials or performs upstream requests, and DB failures cannot produce partial success", async t => {
  const { legacy, manager, d1, put } = await fixture(t);
  put(180, cached("readonly-search-token"));
  for (const name of ["getAccounts", "getDomains", "getDnsRecordsCacheBatch", "getClientForAccount"] as const) {
    t.mock.method(manager, name, () => { throw new Error(`Forbidden search hydration: ${name}`); });
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Search attempted an upstream request"); });
  assert.equal((await legacy.search("readonly-search-token")).length, 1);
  const failing = failDatabaseOperation(d1, sql => sql.includes("FROM cache c"), "all");
  await assert.rejects(() => new SearchService(new DatabaseManager(failing, TEST_AES_KEY)).search("readonly-search-token"), /Injected database failure/);
  const db = new DatabaseManager(failing, TEST_AES_KEY);
  await assert.rejects(() => new DomainCatalogService(new DomainCatalogRepository(db), new CachedDnsSearchRepository(db)).search("readonly-search-token", "all"));
});
test("cached DNS lookups use the cache namespace index and do not cap to first candidate domains", async t => {
  const { dns, manager, sqlite, put } = await fixture(t, 10000);
  put(9999, cached("lookup-index-token"));
  const all = manager.allRaw.bind(manager), queries: Array<{ sql: string; bindings: unknown[] }> = [];
  t.mock.method(manager, "allRaw", async (sql, bindings = []) => { queries.push({ sql, bindings }); return all(sql, bindings); });
  assert.equal((await dns.matches("lookup-index-token"))[0].id, 9999);
  assert.equal(queries.length, 1);
  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${queries[0].sql}`).all(...queries[0].bindings).map(row => row.detail).join(" ");
  console.log(`[dns-search-plan] ${plan}`);
  assert.match(plan, /sqlite_autoindex_cache/);
  assert.ok(!JSON.stringify(await dns.matches("lookup-index-token")).includes('"value"'));
});
test("a failed D1 result envelope cannot become an empty successful DNS search", async t => {
  const { d1 } = await fixture(t);
  const failing = new Proxy(d1, { get(target, property) {
    if (property === "prepare") return (sql: string) => {
      const statement = target.prepare(sql);
      if (!sql.includes("FROM cache c")) return statement;
      const wrap = (item: D1PreparedStatement): D1PreparedStatement => new Proxy(item, { get(native, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(native.bind(...values));
        if (key === "all") return async () => ({ success: false, results: [], meta: {} });
        const value = Reflect.get(native, key); return typeof value === "function" ? value.bind(native) : value;
      } });
      return wrap(statement);
    };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  const manager = new DatabaseManager(failing, TEST_AES_KEY);
  await assert.rejects(() => new SearchService(manager).search("failure-envelope"), /读取数据库结果失败/);
});
test("API search is authenticated, private, scope-aware and rejects malformed limits/locator arguments", async t => {
  const { catalog, manager, d1, put } = await fixture(t);
  put(180, cached("api-cached-token"));
  const token = await manager.createSession(), ctx = { waitUntil() {}, props: {} } as unknown as ExecutionContext;
  const call = (url: string, auth = true) => worker.fetch(new Request(`http://localhost${url}`, {
    headers: auth ? { Authorization: `Bearer ${token}` } : {},
  }), { DB: d1, AES_KEY: TEST_AES_KEY }, ctx);
  for (const route of ["/api/search?q=api-cached-token", "/api/domains/search?search=api-cached-token&search_in=all"]) {
    assert.equal((await call(route, false)).status, 401);
    const result = await call(route);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("Cache-Control"), "private, no-store");
    assert.ok((await result.text()).includes("api-cached-token"));
  }
  for (const query of ["limit=NaN", "limit=0", "limit=101", "limit=1.5"]) {
    assert.equal((await call(`/api/search?q=api-cached-token&${query}`)).status, 400);
  }
  assert.equal((await call(`/api/search?q=${"x".repeat(254)}`)).status, 400);
  for (const query of ["search_in=bad", "focus_id=180", "focus=inventory-180.example.net&focus_id=-1"]) {
    assert.equal((await call(`/api/domains/page?provider=dnshe&${query}`)).status, 400);
  }
  assert.equal((await catalog.search("")).groups.dnshe.total, 0);
  assert.equal((await catalog.search("api-cached-token", "dns")).groups.dnshe.total, 1);
});
