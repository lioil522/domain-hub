import "../helpers/block-outbound";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createD1FromSqlite } from "../../server/d1-sqlite";
import { DatabaseManager } from "../../src/db";
import { CloudflareClient, mapZoneToUpstream } from "../../src/cloudflare";
import { DNSHEClient, type ListDnsRecordsResponse } from "../../src/dnshe";
import { syncCloudflareZones, deepSyncAccountDomains, resyncAccountsInBackground } from "../helpers/legacy-account-sync";
import { runDailySyncAndRenewal } from "../../src/cron/jobs/daily-sync";
import { syncDomainStatusAfterDnsChange } from "../../src/services/dns-operations";
import { DnsService } from "../../src/services/dns-service";
import worker from "../../src/index";
import { normalizeDnsInput } from "../../src/services/dns-input";
import { DnsheDnsAdapter } from "../../src/providers/dns/dnshe-adapter";
import { Hono } from "hono";
import type { AppEnv } from "../../src/routes/types";
import { registerDomainRoutes } from "../../src/routes/domains";
import { registerActionRoutes } from "../../src/routes/actions";
import { registerSyncRoutes } from "../../src/routes/sync";
import { syncStep } from "../../src/services/sliced-sync-service";
import { ActionService } from "../../src/services/action-service";
import { ActionRepository, type StoredAction } from "../../src/repositories/action-repository";
import { IncompleteSyncError } from "../../src/services/sync-result";
import { ProviderApiError } from "../../src/errors/provider-api-error";
import { DnspodClient } from "../../src/dnspod";
import { AlidnsClient } from "../../src/alidns";
import { HuaweiCloudClient } from "../../src/huaweicloud";
import { VercelClient } from "../../src/vercel";
import { DigitalPlatClient } from "../../src/digitalplat";
import { LegacyDomainProviderAdapter } from "../../src/providers/domain/legacy-client-adapter";
import { transportProviders, transportFixture, transportErrorBody, transportEmptyDns, dpExisting, businessRateLimits } from "../helpers/provider-transport";
import { SharedProviderRequestScheduler } from "../../src/services/provider-request-scheduler";
import { coordinationFault, deferred } from "../helpers/coordination-fault";
import { dnsheSyncClock, dnsheSyncResponse, syncDomains } from "../helpers/dnshe-sync-fixture";
import { DnsheRequestBudget } from "../../src/services/dnshe-request-budget";
import { DnsheAccountRequestScheduler } from "../../src/services/dnshe-account-scheduler";
import { runScannerWorkers } from "../../frontend/src/features/scanner/utils/scanner-batch-executor";
import { registerDnsRoutes } from "../../src/routes/dns";

test("DNS fallback batch stops after unknown item; preserves confirmed prefix and marks unsent tail", async t => {
  const { db } = await fixture(t); await db.upsertDomain(1, domain);
  const stored = (await db.getDomainById(101))!, calls: string[] = [], client = new DNSHEClient("offline", "offline");
  client.createDnsRecord = async input => { calls.push(input.name); if (calls.length === 2) throw new Error("offline unknown write"); return { success: true, id: 1 }; };
  t.mock.method(db, "getClientForAccount", async () => ({ client, alias: "offline", provider: "dnshe" as const }));
  const result = await new DnsService(db).batchCreate(stored, ["first", "second", "third"].map(name => ({ type: "A", name, content: "192.0.2.1" })));
  assert.deepEqual(calls, ["first", "second"]); assert.equal(result.successCount, 1); assert.equal(result.failCount, 2);
  assert.match(result.results[2].message, /未发送/); assert.equal(await db.getCache("dns_dirty:101"), "1");
});

for (const provider of ["digitalplat", "huaweicloud"] as const) test(`${provider} grouped DNS batch stops later groups after unknown outcome`, async t => {
  const { client } = transportFixture(provider), calls: string[] = [];
  const transport = client as unknown as { request: (method: string, path: string) => Promise<unknown> };
  t.mock.method(transport, "request", async (method, path) => {
    calls.push(method);
    if (method === "GET") return provider === "digitalplat" ? { success: true, data: [] } : { recordsets: [], metadata: { total_count: 0 } };
    throw new Error("offline unknown group");
  });
  const items = ["first", "second"].map(name => ({ name, type: "A", content: "192.0.2.1" }));
  const result = provider === "digitalplat" ? await (client as DigitalPlatClient).batchCreateDnsRecords({ domain: "example.test", items }) :
    await (client as HuaweiCloudClient).batchCreateDnsRecords({ zoneId: "offline-zone", zoneName: "example.test", items });
  assert.equal(calls.filter(method => method !== "GET").length, 1); assert.match(result.results[1].message, /未发送/);
});

for (const mode of ["batch-update", "batch-delete"] as const) test(`DNS HTTP ${mode} stops unsent tail after unknown mutation`, async t => {
  const { db } = await fixture(t); await db.upsertDomain(1, domain); let mutations = 0;
  t.mock.method(DnsService.prototype, mode === "batch-update" ? "update" : "remove", async () => { mutations++; throw new Error("offline unknown mutation"); });
  const app = new Hono<AppEnv>(); app.use("*", async (c, next) => { c.set("db", db); await next(); }); registerDnsRoutes(app, { sleep: async () => {} });
  const response = await app.request(`/api/domains/101/dns/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records: [1, 2, 3].map(id => ({ id, type: "A", name: "@", content: "192.0.2.1" })) }) });
  const body = await response.json(); assert.equal(response.status, 200); assert.equal(mutations, 1);
  assert.equal(body.success_count, 0); assert.equal(body.fail_count, 3); assert.equal(body.results[1].not_sent, true); assert.equal(body.results[2].not_sent, true);
});

test("non-sliced auxiliary Action cancellation cannot falsely promise remote rollback", async t => {
  const { db } = await fixture(t), action = await new ActionService(new ActionRepository(db)).start("dns-update");
  const app = new Hono<AppEnv>(); app.use("*", async (c, next) => { c.set("db", db); await next(); }); registerActionRoutes(app);
  const response = await app.request(`/api/actions/${action.id}/cancel`, { method: "POST" });
  assert.equal(response.status, 409); assert.equal((await response.json()).error_code, "cancel_not_supported");
  assert.equal((await new ActionService(new ActionRepository(db)).get(action.id))!.status, "running");
});

async function fixture(t: TestContext, provider = "dnshe") {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const d1 = createD1FromSqlite(sqlite);
  const db = new DatabaseManager(d1, "offline-test-key");
  assert.equal(await db.ensureTables(), true);
  await db.executeRaw("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'fixture','fixture-key','plain:Zml4dHVyZQ==',?)", [provider]);
  await db.setAppSetting("auto_renew", "0");
  return { sqlite, d1, db };
}

function fault(d1: D1Database, reject: (sql: string) => boolean): D1Database {
  return new Proxy(d1, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => {
        if (reject(sql)) throw new Error("synthetic database fault");
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function request(d1: D1Database, path: string, body?: object, authenticated = false) {
  return worker.fetch(new Request(`https://test.invalid${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: "Bearer offline-admin" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), { DB: d1, AES_KEY: "offline-test-key", ADMIN_TOKEN: "offline-admin" }, {} as ExecutionContext);
}
const zone = (n: number) => ({ id: `fixture-zone-${n}`, name: `zone${n}.example`, status: "active" });
const domain = { id: 101, subdomain: "demo", rootdomain: "example", full_domain: "demo.example", status: "已解析", has_dns: 1, dns_provider: "system", dns_state_known: true, expires_at: "" };

for (const provider of transportProviders) {
  test(`${provider}: transport faults reach real DNS HTTP/Actions and preserve last-known-good`, async t => {
    const { db, d1 } = await fixture(t, provider);
    await db.upsertDomain(1, { ...domain, remote_id: "zone-1" });
    const stored = (await db.getDomainById(101))!;
    const { client } = transportFixture(provider, { timeoutMs: 30, maxResponseBytes: 300 });
    t.mock.method(DatabaseManager.prototype, "getClientForAccount", async () => ({ client, alias: "fixture", provider }));
    t.mock.method(DatabaseManager.prototype, "refreshAccountQuotaCache", async () => {});
    const old = JSON.stringify([{ id: "last-good", type: "A", content: "192.0.2.1" }]);
    const key = "api_cache:dns:101";
    await db.setCache(key, old);
    await new DnsService(db).invalidate(101);
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const { call, drain } = syncRoutes(db);
    for (const mode of ["timeout", "oversized", "429", "403"] as const) {
      const expectedCode = mode === "timeout" ? "request_timeout" : mode === "oversized" ? "response_too_large" : "fixture_denied";
      const upstreamStatus = mode === "429" ? 429 : mode === "403" ? 403 : 502;
      const reply = () => mode === "timeout" ? new Response(new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode("{")); },
      })) : mode === "oversized" ? new Response("x".repeat(301))
        : Response.json(transportErrorBody(provider), { status: upstreamStatus, headers: { "Retry-After": "3" } });
      let writes = 0;
      let writing = false;
      globalThis.fetch = async (_input, init) => {
        if (writing && provider === "digitalplat" && init?.method === "GET") return Response.json({ success: true, data: [dpExisting] });
        if (writing) writes++;
        return reply();
      };
      for (const write of [false, true]) {
        writing = write;
        const response = await request(d1, "/api/domains/101/dns?refresh=1", write
          ? { type: "A", name: "www", content: "192.0.2.2", ttl: 300 } : undefined, true);
        assert.equal(response.status, upstreamStatus);
        const body = await response.json() as { success: boolean; error_code: string; details: { provider: string; upstream_status: number; upstream_code: string } };
        assert.equal(body.success, false);
        assert.equal(body.error_code, `upstream_${expectedCode}`);
        assert.equal(body.details.provider, provider);
        assert.equal(body.details.upstream_status, upstreamStatus);
        assert.equal(body.details.upstream_code, expectedCode);
        if (mode === "429" || mode === "403") assert.equal(response.headers.get("Retry-After"), "3");
      }
      assert.equal(writes, 1, "a failed mutation never causes another mutation");
      writing = false;
      for (const path of ["/api/accounts/1/sync", "/api/domains/sync"]) {
        const state = await driveSliced(call, path);
        assert.equal(state.status, mode === "403" ? "blocked" : "paused");
        assert.equal(state.failure?.error_code, expectedCode);
        assert.equal(state.failure?.status, upstreamStatus);
        if (mode === "429" || mode === "403") assert.equal(state.failure?.retryAfterMs, 3000);
        await call(`/api/actions/${state.taskId}/cancel`, "POST");
      }
      assert.equal(await db.getCache(key), old);
      assert.equal(await db.getCache("dns_dirty:101"), "1");
      assert.deepEqual(await db.getDomainById(101), stored);
    }
    // Only a complete read may adopt the authoritative empty DNS snapshot.
    globalThis.fetch = async () => Response.json(transportEmptyDns(provider));
    assert.deepEqual((await new DnsService(db).list(stored, true)).records, []);
    assert.equal(await db.getCache(key), "[]");
    assert.equal(await db.getCache("dns_dirty:101"), null);
  });
}

function syncRoutes(db: DatabaseManager) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("db", db); await next(); });
  registerDomainRoutes(app, { resyncAccountsInBackground, fetchAllQuotas: async () => ({ accounts: [], quotas: [] }) });
  registerActionRoutes(app);
  registerSyncRoutes(app);
  const jobs: Promise<unknown>[] = [];
  const ctx = { waitUntil: (job: Promise<unknown>) => { jobs.push(job); } } as ExecutionContext;
  return {
    call: (path: string, method = "GET", body?: object) => app.fetch(new Request(`https://test.invalid${path}`, {
      method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
    }), {}, ctx),
    drain: async () => { await Promise.all(jobs.splice(0)); },
  };
}

// Drive actual production HTTP slices; the start route is local-only and never
// manufactures a background Action. Stop on a persisted failure/cooldown.
async function driveSliced(call: ReturnType<typeof syncRoutes>["call"], path = "/api/accounts/1/sync") {
  const response = await call(path, "POST");
  assert.equal(response.status, 200);
  const plan = await response.json() as { syncPlan: boolean; plans: unknown[] };
  assert.equal(plan.syncPlan, true);
  let taskId: string | undefined;
  for (let i = 0; i < 100; i++) {
    const step = await call("/api/accounts/1/sync-step", "POST", { manual: true, taskId });
    assert.equal(step.status, 200);
    const state = await step.json() as ReturnType<typeof import("../../src/services/sliced-sync-service").syncView>;
    taskId = state.taskId;
    if (!state.continuation || state.retry_after_ms) return state;
  }
  assert.fail("sliced fixture did not settle within its bounded test loop");
}

const listProviders = ["dnspod", "alidns", "huaweicloud", "vercel", "digitalplat"] as const;
type ListProvider = typeof listProviders[number];
function listClient(provider: ListProvider) {
  switch (provider) {
    case "dnspod": return new DnspodClient("fixture", "fixture");
    case "alidns": return new AlidnsClient("fixture", "fixture");
    case "huaweicloud": return new HuaweiCloudClient("fixture", "fixture", "dns.myhuaweicloud.com");
    case "vercel": return new VercelClient("fixture", "team-fixture");
    case "digitalplat": return new DigitalPlatClient("fixture");
  }
}
function domainListFixture(provider: ListProvider, items: unknown[], total = items.length, page = 1) {
  switch (provider) {
    case "dnspod": return { Response: { DomainList: items, DomainCountInfo: { AllTotal: total } } };
    case "alidns": return { Domains: { Domain: items }, TotalCount: total, PageNumber: page, PageSize: 100 };
    case "huaweicloud": return { zones: items, metadata: { total_count: total } };
    case "vercel": return { domains: items, pagination: { count: items.length, next: total > items.length ? 1000 : null } };
    case "digitalplat": return { success: true, data: items };
  }
}
function domainRowFixture(provider: ListProvider, n = 1) {
  const name = `fixture${n}.example`;
  switch (provider) {
    case "dnspod": return { DomainId: n, Name: name };
    case "alidns": return { DomainId: String(n), DomainName: name };
    case "huaweicloud": return { id: `zone-${n}`, name: `${name}.` };
    case "vercel": return { id: String(n), name };
    case "digitalplat": return { domain: name };
  }
}
function emptyDnsFixture(provider: ListProvider) {
  switch (provider) {
    case "dnspod": return { Response: { RecordList: [], RecordCountInfo: { TotalCount: 0, ListCount: 0 } } };
    case "alidns": return { DomainRecords: { Record: [] }, TotalCount: 0, PageNumber: 1, PageSize: 100 };
    case "huaweicloud": return { recordsets: [], metadata: { total_count: 0 } };
    case "vercel": return { records: [], pagination: { count: 0, next: null } };
    case "digitalplat": return { success: true, data: [] };
  }
}

for (const provider of listProviders) {
  test(`${provider}: incomplete real domain lists preserve DB rows and settle both sync Actions as failed`, async t => {
    const { db } = await fixture(t, provider);
    await db.upsertDomain(1, { ...domain, remote_id: "old-zone" });
    const before = await db.getDomains("", "", 1, provider);
    assert.equal(before.length, 1);
    const client = listClient(provider);
    db.refreshAccountQuotaCache = async () => {};
    db.getClientForAccount = async () => ({ client, alias: "fixture", provider });
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    let pages = 0;
    globalThis.fetch = async () => {
      const page = ++pages;
      if (provider === "digitalplat") {
        return Response.json({ ...domainListFixture(provider, [domainRowFixture(provider)]), meta: { has_more: true } });
      }
      const length = provider === "alidns" ? 100 : 1;
      return Response.json(domainListFixture(provider, page === 1
        ? Array.from({ length }, (_, i) => domainRowFixture(provider, i + 1)) : [], length + 1, page));
    };
    const { call, drain } = syncRoutes(db);
    for (const path of ["/api/accounts/1/sync", "/api/domains/sync"]) {
      pages = 0;
      const state = await driveSliced(call, path);
      assert.equal(state.status, "blocked");
      assert.equal(state.failure?.error_code, "incomplete_response");
      assert.deepEqual(await db.getDomains("", "", 1, provider), before);
      assert.equal(pages, provider === "digitalplat" ? 1 : 2);
    }
  });

  test(`${provider}: complete empty domain lists clean old rows and complete both sync paths`, async t => {
    const { db } = await fixture(t, provider);
    const client = listClient(provider);
    db.refreshAccountQuotaCache = async () => {};
    db.getClientForAccount = async () => ({ client, alias: "fixture", provider });
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async () => Response.json(domainListFixture(provider, []));
    await db.upsertDomain(1, domain);
    assert.equal((await db.getDomains("", "", 1, provider)).length, 1);
    assert.equal((await resyncAccountsInBackground(db, [1])).status, "completed");
    assert.deepEqual(await db.getDomains("", "", 1, provider), []);
    await db.upsertDomain(1, domain);
    assert.equal((await db.getDomains("", "", 1, provider)).length, 1);
    const { call } = syncRoutes(db);
    assert.equal((await driveSliced(call)).status, "completed");
    assert.deepEqual(await db.getDomains("", "", 1, provider), []);
    await db.upsertDomain(1, domain);
    await runDailySyncAndRenewal(db);
    assert.equal((await db.getDomains("", "", 1, provider)).length, 1, "Cron never discovers an empty list or prunes cached domains");
  });

  test(`${provider}: real DNS reads preserve last-known-good and dirty on failure, replace only on complete empty`, async t => {
    const { db } = await fixture(t, provider);
    const client = listClient(provider);
    db.refreshAccountQuotaCache = async () => {};
    db.getClientForAccount = async () => ({ client, alias: "fixture", provider });
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async () => Response.json(domainListFixture(provider, [domainRowFixture(provider)]));
    await resyncAccountsInBackground(db, [1]);
    const stored = (await db.getDomains("", "", 1, provider))[0];
    assert.ok(stored);
    const old = JSON.stringify([{ id: "last-good", type: "A", content: "192.0.2.1" }]);
    const key = `api_cache:dns:${stored.id}`;
    const dirty = `dns_dirty:${stored.id}`;
    await db.setCache(key, old);
    const dns = new DnsService(db);
    await dns.invalidate(stored.id);
    // Missing arrays/totals are never repaired into an authoritative empty snapshot.
    globalThis.fetch = async () => Response.json(provider === "digitalplat" ? { success: true } : provider === "dnspod" ? { Response: {} } : {});
    const bad = (e: unknown) => e instanceof ProviderApiError && e.error_code === "incomplete_response" && e.provider === provider;
    await assert.rejects(dns.list(stored, true), bad);
    await assert.rejects(dns.list(stored), bad); // dirty prevents serving stale cache as a fresh read
    await assert.rejects(new LegacyDomainProviderAdapter(provider, client).listDnsRecords(stored), bad);
    await dns.refreshStatus(stored); // best-effort refresh must not erase last-known-good
    assert.equal(await db.getCache(key), old);
    assert.equal(await db.getCache(dirty), "1");
    assert.deepEqual((await db.getDomains("", "", 1, provider))[0], stored);
    globalThis.fetch = async () => Response.json(emptyDnsFixture(provider));
    assert.deepEqual((await dns.list(stored, true)).records, []);
    assert.equal(await db.getCache(key), "[]");
    assert.equal(await db.getCache(dirty), null);
    assert.equal((await dns.list(stored)).cached, true);
  });
}

test("DNS partial sync persists successful records and reports failed domain IDs and provider metadata", async t => {
  const { db } = await fixture(t);
  await db.upsertDomain(1, domain);
  await db.setCache("api_cache:dns:101", "[1]");
  const client = new DNSHEClient("fixture", "fixture");
  client.listSubdomains = async () => ({ success: true, subdomains: [domain, { ...domain, id: 102, full_domain: "two.example" }] });
  client.listDnsRecords = async id => {
    if (id === 101) throw new ProviderApiError("dnshe", 429, "rate_limit_exceeded", "fixture rate limit", undefined, 12000);
    return { success: true, records: [], complete: true };
  };
  await assert.rejects(deepSyncAccountDomains(db, 1, client), error => {
    assert.ok(error instanceof IncompleteSyncError);
    assert.equal(error.result.status, "partial");
    assert.equal(error.result.accounts[0].total, 2);
    assert.deepEqual(error.result.accounts[0].issues, [{ phase: "dns", message: "fixture rate limit", domainId: 101,
      error_code: "rate_limit_exceeded", status: 429, retryAfterMs: 12000, panelStatus: 429 }]);
    return true;
  });
  assert.equal(await db.getCache("api_cache:dns:101"), "[1]");
  assert.equal(await db.getCache("api_cache:dns:102"), "[]");
  assert.equal((await db.getDomains()).length, 2);
});

const budgetSyncModes = ["deep", "auto", "account-action", "global-action", "cron-cache", "cron-always"] as const;
type BudgetSyncMode = typeof budgetSyncModes[number];

async function budgetSyncFixture(t: TestContext) {
  const { db, d1 } = await fixture(t);
  const clock = dnsheSyncClock(d1);
  const calls: Array<{ url: URL; at: number }> = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, "GET", "sync fixture must not send writes");
    const url = new URL(String(input));
    calls.push({ url, at: clock.now });
    return dnsheSyncResponse(url);
  };
  db.getClientForAccount = async () => ({ client: clock.makeClient(), alias: "fixture", provider: "dnshe" });
  // Inject only construction/clock, not client methods: quota refresh uses a
  // separate real budget/client sharing the same D1 key as the subsequent sync.
  db.refreshAccountQuotaCache = async () => { await clock.makeClient().getQuota(); };
  await clock.makeClient().getQuota(); // binding validation / previous reservation
  const run = async (mode: BudgetSyncMode) => {
    if (mode === "deep") return { status: "completed", total: await deepSyncAccountDomains(db, 1, clock.makeClient()) };
    if (mode === "auto") return resyncAccountsInBackground(db, [1], "auto");
    if (mode === "cron-cache" || mode === "cron-always") {
      if (mode === "cron-always") await db.setAppSetting("dns_records_cache_mode", "always");
      return runDailySyncAndRenewal(db, undefined, "custom", true);
    }
    const { call, drain } = syncRoutes(db);
    const path = mode === "account-action" ? "/api/accounts/1/sync" : "/api/domains/sync";
    return driveSliced(call, path);
  };
  return { db, d1, clock, calls, run };
}

for (const mode of budgetSyncModes) {
  test(`DNSHE real shared budget: ${mode} sync serializes multi-domain/cursor reads after quota and offset pages`, async t => {
    const { db, clock, calls, run } = await budgetSyncFixture(t);
    const result = await run(mode);
    assert.equal(result.status, "completed");
    if (mode === "cron-cache" || mode === "cron-always") {
      assert.equal(calls.length, 1, "Cron adds zero upstream calls after the fixture's prior quota read");
      assert.deepEqual(await db.getDomains(), []);
      return;
    }
    assert.equal(clock.maxPending, 1, "one sync must not compete with its own reservations");
    assert.ok(clock.waits.length > 0);
    assert.ok(clock.waits.every(ms => ms === 2100), "keep the production interval, do not enlarge the 4s reservation window");
    assert.ok(calls.slice(1).every((call, i) => call.at - calls[i].at === 2100));
    assert.deepEqual(calls.filter(call => call.url.searchParams.get("endpoint") === "subdomains").map(call => call.url.searchParams.get("page")), mode === "account-action" || mode === "global-action" ? ["1"] : ["1", "2"]);
    assert.deepEqual(calls.filter(call => call.url.searchParams.get("endpoint") === "dns_records").map(call => [call.url.searchParams.get("subdomain_id"), call.url.searchParams.get("cursor")]),
      syncDomains.flatMap(sub => [[String(sub.id), "0"], [String(sub.id), "1"]]));
    assert.equal(calls.filter(call => call.url.searchParams.get("endpoint") === "quota").length,
      mode === "auto" ? 2 : 1);
    const rows = await db.getDomains("", "", 1, "dnshe");
    assert.equal(rows.length, 4);
    for (const sub of syncDomains) {
      assert.equal(JSON.parse((await db.getCache(`api_cache:dns:${sub.id}`))!).length, 2);
      assert.equal(await db.getCache(`dns_dirty:${sub.id}`), null);
      assert.equal((await db.getDomainById(sub.id))?.status, "已解析");
    }
  });
}

for (const mode of ["auto", "account-action", "global-action", "cron-always"] as const) {
  for (const failure of ["upstream-429", "external-budget"] as const) {
    test(`DNSHE serial ${mode} still reports ${failure}, retains complete caches, and does not retry`, async t => {
      const { db, clock, calls, run } = await budgetSyncFixture(t);
      const old = JSON.stringify([{ id: "last-good", type: "A", content: "192.0.2.1" }]);
      for (const sub of syncDomains) {
        await db.upsertDomain(1, { ...sub, status: "已解析", has_dns: 1, dns_provider: "system", dns_state_known: true });
        await db.setCache(`api_cache:dns:${sub.id}`, old);
        if (mode === "auto") await db.setCache(`dns_dirty:${sub.id}`, "1");
      }
      globalThis.fetch = async (input, init) => {
        assert.equal(init?.method, "GET");
        const url = new URL(String(input));
        calls.push({ url, at: clock.now });
        if (url.searchParams.get("endpoint") === "dns_records" && url.searchParams.get("subdomain_id") === "102" && url.searchParams.get("cursor") === "1") {
          if (failure === "upstream-429") return Response.json({ success: false, error_code: "rate_limit_exceeded" }, { status: 429, headers: { "Retry-After": "60" } });
          // Another caller extends this key's budget. Serializing a single sync
          // must not bypass shared protection or silently turn partial into success.
          await clock.makeBudget().block(60_000);
        }
        return dnsheSyncResponse(url);
      };
      let summary;
      if (mode === "account-action" || mode === "global-action") {
        const state = await run(mode) as Awaited<ReturnType<typeof driveSliced>>;
        assert.equal(state.status, "paused");
        assert.equal(state.phase, "dns");
        assert.equal(state.failure?.error_code, failure === "upstream-429" ? "rate_limit_exceeded" : "rate_limited");
      } else if (mode === "cron-always") {
        await run(mode);
        assert.equal(calls.length, 1, "Cron must not observe a list or DNS error because it never fetches them");
        for (const sub of syncDomains) assert.equal(await db.getCache(`api_cache:dns:${sub.id}`), old);
        return;
      } else {
        try { await run(mode); assert.fail("incomplete sync must reject"); }
        catch (error) { assert.ok(error instanceof IncompleteSyncError); summary = error.result; }
      }
      if (summary) {
        assert.equal(summary.status, "partial");
        assert.ok(summary.accounts[0].issues.every(issue => issue.phase === "dns"));
        assert.ok(summary.accounts[0].issues.some(issue => issue.error_code === (failure === "upstream-429" ? "rate_limit_exceeded" : "rate_limited")));
      }
      assert.equal(calls.filter(call => call.url.searchParams.get("endpoint") === "dns_records").length, 4, "one successful domain and one failed page; no resend or further upstream during cooldown");
      for (const id of [failure === "upstream-429" ? 102 : 103, 104]) {
        assert.equal(await db.getCache(`api_cache:dns:${id}`), old);
        assert.equal(await db.getCache(`dns_dirty:${id}`), mode === "auto" ? "1" : null);
        assert.equal((await db.getDomainById(id))?.status, "已解析");
      }
      assert.equal(JSON.parse((await db.getCache("api_cache:dns:101"))!).length, 2);
    });
  }
}

test("DNSHE Cron never refreshes DNS caches, including legacy always mode", async t => {
  const { db, calls, run } = await budgetSyncFixture(t);
  for (const sub of syncDomains) await db.replaceDnsRecordsCache(sub.id, [{ id: sub.id * 10, type: "TXT", content: "cached" }]);
  assert.equal((await run("cron-cache")).status, "completed");
  assert.equal(calls.filter(call => call.url.searchParams.get("endpoint") === "dns_records").length, 0);
  assert.equal((await run("cron-always")).status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls.filter(call => call.url.searchParams.get("endpoint") === "dns_records").length, 0);
  assert.equal(JSON.parse((await db.getCache("api_cache:dns:101"))!).length, 1);
});

test("multi-account sync aggregates successful empty accounts and failures without false completion", async t => {
  const { db } = await fixture(t);
  const client = new DNSHEClient("fixture", "fixture");
  client.listSubdomains = async () => ({ success: true, subdomains: [] });
  db.refreshAccountQuotaCache = async () => {};
  db.getClientForAccount = async id => {
    if (id === 2) throw new Error("fixture account unavailable");
    return { client, alias: "fixture", provider: "dnshe" };
  };
  await assert.rejects(resyncAccountsInBackground(db, [1, 1, 2]), error => {
    assert.ok(error instanceof IncompleteSyncError);
    assert.equal(error.result.status, "partial");
    assert.deepEqual(error.result.accounts.map(a => [a.accountId, a.status, a.total]), [[1, "completed", 0], [2, "failed", 0]]);
    return true;
  });
  await assert.rejects(resyncAccountsInBackground(db, [2]), error => error instanceof IncompleteSyncError && error.result.status === "failed");
});

for (const mode of ["empty", "dns-partial", "account-failed"] as const) {
  test(`real sync/action HTTP routes settle accurate terminal states: ${mode}`, async t => {
    const { db } = await fixture(t);
    const client = new DNSHEClient("fixture", "fixture");
    client.listSubdomains = async () => {
      if (mode === "account-failed") throw new Error("fixture upstream unavailable");
      return { success: true, subdomains: mode === "empty" ? [] : [domain] };
    };
    client.listDnsRecordsPage = async () => ({ success: false, message: "fixture DNS unavailable" });
    db.refreshAccountQuotaCache = async () => {};
    db.getClientForAccount = async () => ({ client, alias: "fixture", provider: "dnshe" });
    const { call, drain } = syncRoutes(db);
    const state = await driveSliced(call);
    assert.equal(state.status, mode === "empty" ? "completed" : mode === "dns-partial" ? "blocked" : "paused");
    const { action } = await (await call(`/api/actions/${state.taskId}`)).json() as { action: StoredAction };
    assert.equal(action.status, mode === "empty" ? "completed" : "partial");
    assert.deepEqual((action.metadata as { accountIds: number[] }).accountIds, [1]);
  });
}

test("provider CF Action is partial for the first fragment and completed only after the final snapshot", async t => {
  const { db } = await fixture(t, "cloudflare");
  const client = new CloudflareClient("fixture");
  client.listZones = async ({ startPage = 1 } = {}) => ({
    zones: Array.from({ length: 151 }, (_, i) => zone(i + 1)).slice((startPage - 1) * 50, startPage * 50),
    hasMore: startPage < 4, nextPage: startPage + 1,
  });
  db.refreshAccountQuotaCache = async () => {};
  db.getClientForAccount = async () => ({ client, alias: "fixture", provider: "cloudflare" });
  const { call, drain } = syncRoutes(db);
  const plan = await (await call("/api/providers/cloudflare/sync", "POST")).json() as { syncPlan: boolean };
  assert.equal(plan.syncPlan, true);
  const first = await syncStep(db, 1, { manual: true });
  for (let i = 0; i < 3; i++) await syncStep(db, 1, { manual: true, taskId: first.taskId });
  const partial = await (await call(`/api/actions/${first.taskId}`)).json() as { action: StoredAction };
  assert.equal(partial.action.status, "queued");
  assert.equal((await db.getDomains()).length, 0, "all list pages must be seen before publishing");
  assert.equal((await driveSliced(call, "/api/providers/cloudflare/sync")).status, "completed");
  assert.equal((await db.getDomains("", "", 1, "cloudflare")).length, 151);
});

test("full manual sync Action reports DNS failure instead of swallowing it; empty global sync completes", async t => {
  const { db } = await fixture(t);
  const client = new DNSHEClient("fixture", "fixture");
  client.listSubdomains = async () => ({ success: true, subdomains: [domain] });
  client.listDnsRecordsPage = async () => ({ success: false });
  db.getClientForAccount = async () => ({ client, alias: "fixture", provider: "dnshe" });
  const { call, drain } = syncRoutes(db);
  assert.equal((await driveSliced(call, "/api/domains/sync")).status, "blocked");
  await db.executeRaw("DELETE FROM accounts");
  const empty = await (await call("/api/domains/sync", "POST")).json() as { plans: unknown[]; actionId?: string };
  assert.deepEqual(empty.plans, []);
  assert.equal(empty.actionId, undefined, "empty plans do not forge a completed Action");
});

test("Action HTTP PATCH preserves absent fields, concurrent patches, explicit nulls and terminal immutability", async t => {
  const { db, d1 } = await fixture(t);
  const service = new ActionService(new ActionRepository(db));
  const action = await service.start("sync", { label: "keep-me" });
  const patch = (body: object) => worker.fetch(new Request(`https://test.invalid/api/actions/${action.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Authorization: "Bearer offline-admin" }, body: JSON.stringify(body),
  }), { DB: d1, AES_KEY: "offline-test-key", ADMIN_TOKEN: "offline-admin" }, {} as ExecutionContext);
  await Promise.all([patch({ progress: 25 }), patch({ error: "temporary" })]);
  let stored = (await service.get(action.id))!;
  assert.equal(stored.status, "running");
  assert.equal(stored.progress, 25);
  assert.equal(stored.error, "temporary");
  assert.deepEqual(stored.metadata, { label: "keep-me" });
  assert.equal((await patch({ progress: null })).status, 400);
  assert.equal((await patch({ progress: 101 })).status, 400);
  assert.equal((await patch({ status: "partial", metadata: null, error: null })).status, 200);
  stored = (await service.get(action.id))!;
  assert.equal(stored.status, "partial");
  assert.ok(stored.finished_at);
  assert.equal(stored.metadata, null);
  assert.equal(stored.error, null);
  await service.complete(action.id);
  await patch({ status: "running", metadata: { overwritten: true } });
  assert.deepEqual(await service.get(action.id), stored);
});

test("late sync runner cannot overwrite cancelled Action terminal state", async t => {
  const { db } = await fixture(t);
  const service = new ActionService(new ActionRepository(db));
  const { queueSyncAction } = await import("../../src/services/sync-action-service");
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let job!: Promise<unknown>;
  const id = await queueSyncAction(db, { accountIds: [1], label: "fixture" }, async () => {
    await hold;
    return { status: "completed", accounts: [] };
  }, promise => { job = promise; });
  const cancelled = await service.cancel(id);
  release();
  await job;
  assert.deepEqual(await service.get(id), cancelled);
});

test("real binding, batch binding and Vercel credential replacement return page-driven plans, not background Actions", async t => {
  const { db, d1 } = await fixture(t);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (input, options) => {
    assert.equal(new URL(String(input)).hostname, "api.vercel.com");
    const token = new Headers(options?.headers).get("Authorization") || "";
    if (String(input).includes("/v2/user")) return Response.json({ user: { id: token.includes("two") ? "owner-two" : "owner-one", username: "fixture" } });
    assert.ok(String(input).includes("/domains"));
    return Response.json({ domains: [], pagination: { count: 0, next: null, prev: null } });
  };
  const jobs: Promise<unknown>[] = [];
  const call = (path: string, method: string, body: object) => worker.fetch(new Request(`https://test.invalid${path}`, {
    method, headers: { "Content-Type": "application/json", Authorization: "Bearer offline-admin" }, body: JSON.stringify(body),
  }), { DB: d1, AES_KEY: "offline-test-key", ADMIN_TOKEN: "offline-admin" }, { waitUntil: (job: Promise<unknown>) => { jobs.push(job); } } as ExecutionContext);
  const created = await (await call("/api/accounts", "POST", { provider: "vercel", api_token: "fixture-one" })).json() as {
    success: boolean; account: { id: number }; actionId?: string; syncPlan: boolean; account_ids: number[];
  };
  assert.equal(created.success, true);
  assert.equal(created.actionId, undefined);
  assert.equal(created.syncPlan, true);
  assert.deepEqual(created.account_ids, [created.account.id]);
  assert.equal(jobs.length, 0);
  const updated = await (await call(`/api/accounts/${created.account.id}`, "PUT", { alias: "renamed", api_secret: "fixture-replacement" })).json() as { success: boolean; actionId?: string; syncPlan: boolean };
  assert.equal(updated.success, true);
  assert.equal(updated.actionId, undefined);
  assert.equal(updated.syncPlan, true);
  assert.equal(jobs.length, 0);
  const rename = await (await call(`/api/accounts/${created.account.id}`, "PUT", { alias: "alias-only" })).json() as { actionId?: string };
  assert.equal(rename.actionId, undefined);
  const batch = await (await call("/api/accounts/batch", "POST", { provider: "vercel", accounts: [{ api_token: "fixture-two" }] })).json() as {
    success_count: number; actionId?: string; syncPlan: boolean; account_ids: number[];
  };
  assert.equal(batch.success_count, 1);
  assert.equal(batch.actionId, undefined);
  assert.equal(batch.syncPlan, true);
  assert.equal(jobs.length, 0);
  assert.deepEqual(await new ActionRepository(db).list(), []);
  assert.equal(batch.account_ids.length, 1);
});

for (const operation of ["create", "batch", "update"] as const) {
  test(`saved account ${operation} remains successful when sync Action insertion fails`, async t => {
    const { db, d1, sqlite } = await fixture(t, "vercel");
    sqlite.exec("CREATE TRIGGER fail_action BEFORE INSERT ON actions BEGIN SELECT RAISE(ABORT, 'fixture action unavailable'); END");
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    let verifyCalls = 0;
    globalThis.fetch = async input => {
      assert.equal(new URL(String(input)).hostname, "api.vercel.com");
      assert.ok(String(input).includes("/v2/user"), "no domain sync may run without an Action");
      verifyCalls++;
      return Response.json({ user: { id: "owner-new", username: "fixture" } });
    };
    let registered = 0;
    const path = operation === "update" ? "/api/accounts/1" : operation === "batch" ? "/api/accounts/batch" : "/api/accounts";
    const item = { provider: "vercel", alias: "saved", api_token: "fixture-new-token" };
    const response = await worker.fetch(new Request(`https://test.invalid${path}`, {
      method: operation === "update" ? "PUT" : "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer offline-admin" },
      body: JSON.stringify(operation === "batch" ? { provider: "vercel", accounts: [item] } : item),
    }), { DB: d1, AES_KEY: "offline-test-key", ADMIN_TOKEN: "offline-admin" }, {
      waitUntil: () => { registered++; },
    } as ExecutionContext);
    assert.equal(response.status, 200);
    const data = await response.json() as { success: boolean; actionId?: string; syncPlan: boolean; success_count?: number };
    assert.equal(data.success, true);
    assert.equal(data.actionId, undefined);
    assert.equal(data.syncPlan, true, "binding no longer depends on an Action insertion");
    if (operation === "batch") assert.equal(data.success_count, 1);
    assert.equal((await db.getAccounts()).some(a => a.alias === "saved" && a.api_key === "vercel:owner-new"), true);
    assert.deepEqual(await new ActionRepository(db).list(), []);
    assert.equal(verifyCalls, 1);
    assert.equal(registered, 0);
  });
}

test("failed waitUntil registration settles the Action without issuing upstream work", async t => {
  const { db } = await fixture(t);
  const { queueSyncAction } = await import("../../src/services/sync-action-service");
  let ran = false;
  await assert.rejects(queueSyncAction(db, { label: "fixture" }, async () => {
    ran = true;
    return { status: "completed", accounts: [] };
  }, () => { throw new Error("fixture registration failure"); }), /fixture registration failure/);
  const [action] = await new ActionRepository(db).list();
  assert.equal(ran, false);
  assert.equal(action.status, "failed");
  assert.ok(action.finished_at);
});

test("custom account binding explicitly skips sync and does not create an Action", async t => {
  const { db, d1 } = await fixture(t);
  const response = await request(d1, "/api/accounts", { provider: "custom", alias: "offline-group" }, true);
  const data = await response.json() as { success: boolean; skipped: boolean; actionId?: string };
  assert.equal(response.status, 200);
  assert.equal(data.success, true);
  assert.equal(data.skipped, true);
  assert.equal(data.actionId, undefined);
  assert.deepEqual(await new ActionRepository(db).list(), []);
});

test("public setup fails closed on an auth read fault and preserves the old password", async t => {
  const { db, d1 } = await fixture(t);
  await db.setPassword("original", "original-password");
  const broken = fault(d1, sql => sql.includes("SELECT key, value FROM settings WHERE key IN"));
  const res = await request(broken, "/api/auth/setup", { username: "replacement", password: "replacement-password" });
  assert.equal(res.status, 503);
  assert.equal((await request(broken, "/api/auth/status")).status, 503);
  assert.equal(await db.verifyPassword("original-password"), true);
  assert.equal(await db.verifyPassword("replacement-password"), false);
});

test("schema bootstrap failure blocks anonymous setup before any credential write", async t => {
  const { d1, db } = await fixture(t);
  const broken = fault(d1, sql => sql.includes("CREATE TABLE"));
  assert.equal((await request(broken, "/api/auth/setup", { username: "newadmin", password: "new-password" })).status, 503);
  assert.equal((await db.getAuthConfig()).initialized, false);
});

test("two concurrent real setup requests have exactly one winner", async t => {
  const { d1, db } = await fixture(t);
  const responses = await Promise.all([
    request(d1, "/api/auth/setup", { username: "admin-one", password: "password-one" }),
    request(d1, "/api/auth/setup", { username: "admin-two", password: "password-two" }),
  ]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 403]);
  const winner = responses[0].status === 200 ? "one" : "two";
  assert.equal((await db.getAuthConfig()).username, `admin-${winner}`);
  assert.equal(await db.verifyPassword(`password-${winner}`), true);
  assert.equal((await request(d1, "/api/auth/setup", { username: "third", password: "password-three" })).status, 403);
});

test("first initialization and password changes roll back all credential writes on failure", async t => {
  const { sqlite, db } = await fixture(t);
  sqlite.exec("CREATE TRIGGER fail_salt BEFORE INSERT ON settings WHEN NEW.key = 'auth_pass_salt' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  await assert.rejects(db.initializePassword("admin", "initial-password"));
  assert.equal((await db.getAuthConfig()).initialized, false);
  assert.equal(await db.firstRaw("SELECT * FROM settings WHERE key = 'auth_initialized'"), null);
  sqlite.exec("DROP TRIGGER fail_salt");
  await db.setPassword("original", "original-password");
  sqlite.exec("CREATE TRIGGER fail_salt BEFORE UPDATE ON settings WHEN NEW.key = 'auth_pass_salt' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  await assert.rejects(db.setPassword("replacement", "replacement-password"));
  assert.equal((await db.getAuthConfig()).username, "original");
  assert.equal(await db.verifyPassword("original-password"), true);
});

test("legacy partial credential rows cannot reopen setup", async t => {
  const { d1, db } = await fixture(t);
  await db.setSetting("auth_pass_salt", "legacy-partial-salt");
  assert.equal((await request(d1, "/api/auth/setup", { username: "admin", password: "password-new" })).status, 503);
});

for (const mode of ["manual", "cron"] as const) for (const count of [150, 151]) {
  test(`${mode}: ${count} zones survive cross-run sync, including an empty terminal page`, async t => {
    const { db } = await fixture(t, "cloudflare");
    await db.upsertDomain(1, mapZoneToUpstream(zone(999)));
    const client = new CloudflareClient("offline-token");
    const pages: number[] = [];
    client.listZones = async ({ startPage = 1 } = {}) => {
      pages.push(startPage);
      const zones = Array.from({ length: count }, (_, i) => zone(i + 1)).slice((startPage - 1) * 50, startPage * 50);
      return { zones, hasMore: zones.length === 50, nextPage: startPage + 1 };
    };
    db.getClientForAccount = async () => ({ client, alias: "fixture", provider: "cloudflare" });
    const sync = async () => {
      if (mode === "cron") await driveSliced(syncRoutes(db).call);
      else await syncCloudflareZones(db, 1, client);
    };
    if (mode === "cron") {
      await runDailySyncAndRenewal(db, undefined, "custom", true);
      assert.deepEqual(pages, [], "Cron itself never lists or deletes zones");
      const first = await syncStep(db, 1, { manual: true });
      await syncStep(db, 1, { manual: true, taskId: first.taskId });
      await db.upsertDomain(1, mapZoneToUpstream(zone(777)));
      await sync();
      assert.deepEqual(pages, [1, 2, 3, 4]);
      const rows = await db.getDomains("", "", 1, "cloudflare");
      assert.equal(rows.length, count + 1);
      assert.equal(rows.some(r => r.full_domain === "zone999.example"), false);
      assert.equal(rows.some(r => r.full_domain === "zone777.example"), true);
      return;
    }
    if (mode === "manual") await assert.rejects(sync(), /继续拉取/);
    else await sync();
    assert.equal(JSON.parse((await db.getCache("cf_zone_cursor:1"))!).startPage, 4);
    assert.equal((await db.getDomains("", "", 1, "cloudflare")).length, 151);
    // A locally added domain after the snapshot began is not a prune candidate.
    await db.upsertDomain(1, mapZoneToUpstream(zone(777)));
    await sync();
    const rows = await db.getDomains("", "", 1, "cloudflare");
    assert.deepEqual(pages, [1, 2, 3, 4]);
    assert.equal(rows.length, count + 1);
    assert.equal(rows.some(r => r.full_domain === "zone999.example"), false);
    assert.equal(rows.some(r => r.full_domain === "zone1.example"), true);
    assert.equal(rows.some(r => r.full_domain === "zone777.example"), true);
  });
}

test("CF cursor write failure rolls back that page, and retry resumes safely", async t => {
  const { db, sqlite } = await fixture(t, "cloudflare");
  await db.upsertDomain(1, mapZoneToUpstream(zone(999)));
  const client = new CloudflareClient("offline-token");
  client.listZones = async () => ({ zones: [zone(1)], hasMore: false, nextPage: 2 });
  sqlite.exec("CREATE TRIGGER fail_cursor BEFORE INSERT ON cache WHEN NEW.key = 'cf_zone_cursor:1' BEGIN SELECT RAISE(ABORT, 'synthetic cursor fault'); END");
  await assert.rejects(syncCloudflareZones(db, 1, client));
  assert.deepEqual((await db.getDomains("", "", 1, "cloudflare")).map(r => r.full_domain), ["zone999.example"]);
  sqlite.exec("DROP TRIGGER fail_cursor");
  assert.equal(await syncCloudflareZones(db, 1, client), 1);
});

test("old CF cursor restarts at page one; concurrent runners cannot take the lease", async t => {
  const { db } = await fixture(t, "cloudflare");
  await db.setCache("cf_zone_cursor:1", JSON.stringify({ startPage: 4, syncedBefore: 150 }));
  const client = new CloudflareClient("offline-token");
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  client.listZones = async ({ startPage } = {}) => {
    assert.equal(startPage, 1);
    entered();
    await blocked;
    return { zones: [], hasMore: false, nextPage: 2 };
  };
  const first = syncCloudflareZones(db, 1, client);
  await started;
  await assert.rejects(syncCloudflareZones(db, 1, client), /正在同步/);
  release();
  assert.equal(await first, 0);
});

test("stale CF runner cannot write a page after another runner took its expired lease", async t => {
  const { db } = await fixture(t, "cloudflare");
  await db.setCache("sync_lock:cloudflare:1", "new-owner");
  await assert.rejects(db.commitSyncPage(1, [mapZoneToUpstream(zone(1))], "sync_lock:cloudflare:1", "old-owner", "cf_zone_cursor:1", "bad", 120), /失效/);
  assert.equal((await db.getDomains("", "", 1, "cloudflare")).length, 0);
  assert.equal(await db.getCache("cf_zone_cursor:1"), null);
});

test("upstream page failure preserves prior pages and their persisted nextPage", async t => {
  const { db } = await fixture(t, "cloudflare");
  await db.upsertDomain(1, mapZoneToUpstream(zone(999)));
  const client = new CloudflareClient("offline-token");
  client.listZones = async ({ startPage = 1 } = {}) => {
    if (startPage === 2) throw new Error("synthetic upstream failure");
    return { zones: [zone(1)], hasMore: true, nextPage: 2 };
  };
  await assert.rejects(syncCloudflareZones(db, 1, client));
  assert.equal((await db.getDomains("", "", 1, "cloudflare")).length, 2);
  assert.equal(JSON.parse((await db.getCache("cf_zone_cursor:1"))!).startPage, 2);
});

test("CF credential scope changes restart the full snapshot rather than resuming an old fragment", async t => {
  const { db } = await fixture(t, "cloudflare");
  const oldClient = new CloudflareClient("old-offline-token");
  const client = new CloudflareClient("new-offline-token");
  const scope = await oldClient.syncScope();
  assert.notEqual(scope, await client.syncScope());
  assert.equal(scope.includes("old-offline-token"), false);
  const previous = mapZoneToUpstream(zone(1));
  await db.upsertDomain(1, previous);
  await db.upsertDomain(1, mapZoneToUpstream(zone(999)));
  await db.setCache("cf_zone_cursor:1", JSON.stringify({ version: 2, scope, startPage: 4, syncedBefore: 1,
    seenIds: [previous.id], candidates: [] }));
  client.listZones = async ({ startPage } = {}) => {
    assert.equal(startPage, 1);
    return { zones: [zone(2)], hasMore: false, nextPage: 1 };
  };
  assert.equal(await syncCloudflareZones(db, 1, client), 1);
  assert.deepEqual((await db.getDomains("", "", 1, "cloudflare")).map(r => r.full_domain), ["zone2.example"]);
});

test("malformed CF snapshots restart safely, including bad counters, duplicated IDs and candidate rows", async t => {
  const { db } = await fixture(t, "cloudflare");
  const client = new CloudflareClient("offline-token");
  const valid = { version: 2, scope: await client.syncScope(), startPage: 4, syncedBefore: 1, seenIds: [1], candidates: [] };
  const invalid = ["{", JSON.stringify({ ...valid, syncedBefore: -1 }), JSON.stringify({ ...valid, seenIds: undefined }),
    JSON.stringify({ ...valid, syncedBefore: 2, seenIds: [1, 1] }), JSON.stringify({ ...valid, candidates: [null] }),
    JSON.stringify({ ...valid, startPage: 1 })];
  for (const raw of invalid) {
    await db.upsertDomain(1, mapZoneToUpstream(zone(999)));
    await db.setCache("cf_zone_cursor:1", raw);
    client.listZones = async ({ startPage } = {}) => {
      assert.equal(startPage, 1);
      return { zones: [], hasMore: false, nextPage: 1 };
    };
    assert.equal(await syncCloudflareZones(db, 1, client), 0);
    assert.equal((await db.getDomains("", "", 1, "cloudflare")).length, 0);
  }
});

for (const query of ["SELECT value FROM cache", "SELECT id, updated_at FROM domains_cache"]) {
  test(`CF strict coordination read failure aborts before upstream reads: ${query}`, async t => {
    const { db, d1 } = await fixture(t, "cloudflare");
    await db.upsertDomain(1, mapZoneToUpstream(zone(999)));
    const broken = new DatabaseManager(fault(d1, sql => sql.includes(query)), "offline-test-key");
    const client = new CloudflareClient("offline-token");
    let called = false;
    client.listZones = async () => { called = true; return { zones: [], hasMore: false, nextPage: 1 }; };
    await assert.rejects(syncCloudflareZones(broken, 1, client), /synthetic database fault/);
    assert.equal(called, false);
    assert.equal((await db.getDomains("", "", 1, "cloudflare")).length, 1);
    assert.equal(await db.getCache("sync_lock:cloudflare:1"), null);
  });
}

for (const mode of ["repeat-page", "duplicate-id", "skip-page"] as const) {
  test(`CF invalid pagination cannot prune or commit the bad page: ${mode}`, async t => {
    const { db } = await fixture(t, "cloudflare");
    await db.upsertDomain(1, mapZoneToUpstream(zone(999)));
    const client = new CloudflareClient("offline-token");
    client.listZones = async ({ startPage = 1 } = {}) => {
      if (mode === "duplicate-id") return { zones: [zone(1), zone(1)], hasMore: false, nextPage: 1 };
      if (mode === "skip-page") return { zones: [zone(1)], hasMore: true, nextPage: startPage + 2 };
      return { zones: [zone(1)], hasMore: startPage === 1, nextPage: startPage + 1 };
    };
    await assert.rejects(syncCloudflareZones(db, 1, client), /分页/);
    const rows = await db.getDomains("", "", 1, "cloudflare");
    assert.equal(rows.some(r => r.full_domain === "zone999.example"), true);
    assert.equal(rows.length, mode === "repeat-page" ? 2 : 1);
    if (mode === "repeat-page") assert.equal(JSON.parse((await db.getCache("cf_zone_cursor:1"))!).startPage, 2);
    else assert.equal(await db.getCache("cf_zone_cursor:1"), null);
  });
}

test("CF finishing snapshot preserves a candidate edited after cycle start", async t => {
  const { db } = await fixture(t, "cloudflare");
  const candidate = mapZoneToUpstream(zone(999));
  await db.upsertDomain(1, candidate);
  const client = new CloudflareClient("offline-token");
  client.listZones = async () => {
    await db.executeRaw("UPDATE domains_cache SET updated_at = 'modified-after-snapshot' WHERE id = ?", [candidate.id]);
    return { zones: [], hasMore: false, nextPage: 1 };
  };
  assert.equal(await syncCloudflareZones(db, 1, client), 0);
  assert.equal((await db.getDomainById(candidate.id))?.updated_at, "modified-after-snapshot");
});

test("old CF runner finally cannot release a new owner's lease", async t => {
  const { db } = await fixture(t, "cloudflare");
  const client = new CloudflareClient("offline-token");
  client.listZones = async () => {
    await db.setCache("sync_lock:cloudflare:1", "new-owner");
    return { zones: [], hasMore: false, nextPage: 1 };
  };
  await assert.rejects(syncCloudflareZones(db, 1, client), /失效/);
  assert.equal(await db.getCache("sync_lock:cloudflare:1"), "new-owner");
  assert.equal(await db.getCache("cf_zone_cursor:1"), null);
});

for (const bad of [{ success: false, message: "temporary failure" }, { success: true }, { success: true, records: [], complete: false }] satisfies ListDnsRecordsResponse[]) {
  test(`failed/partial DNS reads preserve last-known-good across mutation, manual sync and cron: ${JSON.stringify(bad)}`, async t => {
    const { db } = await fixture(t);
    await db.upsertDomain(1, domain);
    const old = JSON.stringify([{ id: 1, type: "A", content: "192.0.2.1" }]);
    await db.setCache("api_cache:dns:101", old);
    const client = new DNSHEClient("fixture", "fixture");
    client.listDnsRecords = async () => bad;
    client.listSubdomains = async () => ({ success: true, subdomains: [domain] });
    db.getClientForAccount = async () => ({ client, alias: "fixture", provider: "dnshe" });
    await new DnsService(db).invalidate(101);
    await syncDomainStatusAfterDnsChange(db, client, (await db.getDomainById(101))!);
    await assert.rejects(deepSyncAccountDomains(db, 1, client), /同步未全部完成/);
    await runDailySyncAndRenewal(db); // no DNS read, so no upstream DNS failure
    assert.equal((await db.getDomainById(101))?.status, "已解析");
    assert.equal(await db.getCache("api_cache:dns:101"), old);
    assert.equal(await db.getCache("dns_dirty:101"), "1");
  });
}

test("authoritative empty DNSHE domain list clears stale rows", async t => {
  const { db } = await fixture(t);
  await db.upsertDomain(1, domain);
  const client = new DNSHEClient("fixture", "fixture");
  client.listSubdomains = async () => ({ success: true, subdomains: [], pagination: { has_more: false, total: 0 } });
  assert.equal(await deepSyncAccountDomains(db, 1, client), 0);
  assert.equal((await db.getDomains()).length, 0);
});

test("WHOIS 429 and DNS 409 retain upstream metadata through real HTTP routes", async t => {
  const { db, d1 } = await fixture(t);
  await db.upsertDomain(1, domain);
  await db.setCache("api_cache:dns:101", "[1]");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ success: false, error_code: "rate_limit_exceeded", message: "fixture limit", details: { limit: 30 } }, { status: 429, headers: { "Retry-After": "12" } });
  const whois = await request(d1, "/api/whois?domain=demo.example&account_id=1", undefined, true);
  assert.equal(whois.status, 429);
  assert.equal(whois.headers.get("Retry-After"), "12");
  assert.equal((await whois.json() as { error_code: string }).error_code, "upstream_rate_limit_exceeded");
  // Independent upstream status case: reset both fixture budgets after asserting
  // the shared deployment cooldown is in effect.
  await assert.rejects(new DnsheAccountRequestScheduler(d1, "fixture-key").acquire(1000),
    error => error instanceof ProviderApiError && error.error_code === "scheduler_cooldown");
  await db.executeRaw("DELETE FROM cache WHERE key LIKE 'provider_scheduler:%'");
  await db.executeRaw("DELETE FROM cache WHERE key LIKE 'dnshe_budget:%'");
  await db.executeRaw("DELETE FROM cache WHERE key LIKE 'dnshe_queue:%:blocked'");
  globalThis.fetch = async () => Response.json({ success: false, error_code: "external_dns_delegated", message: "use actual provider" }, { status: 409 });
  const dns = await request(d1, "/api/domains/101/dns?refresh=1", undefined, true);
  assert.equal(dns.status, 409);
  assert.equal((await dns.json() as { error_code: string }).error_code, "upstream_external_dns_delegated");
  assert.equal(await db.getCache("api_cache:dns:101"), "[1]");
});

test("enabled 2FA without a usable secret fails closed instead of allowing password-only login", async t => {
  const { d1, db } = await fixture(t);
  await db.setPassword("admin", "password-one");
  await db.setSetting("auth_2fa_enabled", "1");
  assert.equal((await request(d1, "/api/auth/login", { username: "admin", password: "password-one" })).status, 503);
});

test("complete DNS reads atomically replace last-known-good and clear dirty only on success", async t => {
  const { db, sqlite } = await fixture(t);
  await db.upsertDomain(1, domain);
  await db.setCache("api_cache:dns:101", "[1]");
  await new DnsService(db).invalidate(101);
  const client = new DNSHEClient("fixture", "fixture");
  client.listDnsRecords = async () => ({ success: true, records: [], complete: true });
  db.getClientForAccount = async () => ({ client, alias: "fixture", provider: "dnshe" });
  sqlite.exec("CREATE TRIGGER fail_dns BEFORE UPDATE ON cache WHEN NEW.key = 'api_cache:dns:101' BEGIN SELECT RAISE(ABORT, 'synthetic fault'); END");
  await assert.rejects(new DnsService(db).list((await db.getDomainById(101))!));
  assert.equal(await db.getCache("api_cache:dns:101"), "[1]");
  assert.equal(await db.getCache("dns_dirty:101"), "1");
  sqlite.exec("DROP TRIGGER fail_dns");
  await new DnsService(db).list((await db.getDomainById(101))!);
  assert.equal(await db.getCache("api_cache:dns:101"), "[]");
  assert.equal(await db.getCache("dns_dirty:101"), null);
});

test("DNSHE create/update real HTTP routes accept structured SRV/CAA and ignore client routing fields", async t => {
  const { d1, db } = await fixture(t);
  await db.upsertDomain(1, domain);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const writes: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, options) => {
    const action = new URL(String(input)).searchParams.get("action");
    if (action === "list") return Response.json({ success: true, records: [], pagination: { has_more: false } });
    writes.push(JSON.parse(String(options?.body)));
    return Response.json({ success: true, id: 42, record: { id: 42 } });
  };
  const srv = await request(d1, "/api/domains/101/dns", { type: "SRV", name: "_sip._tcp.DEMO.EXAMPLE.", priority: 10,
    weight: 5, port: 5060, target: "sip.example.invalid", subdomain_id: 999, record_id: "evil" }, true);
  assert.equal(srv.status, 200);
  assert.equal(writes[0].subdomain_id, 101);
  assert.equal(writes[0].record_id, undefined);
  assert.equal(writes[0].name, "_sip._tcp");
  assert.equal(writes[0].content, "10 5 5060 sip.example.invalid");
  // Every real route uses a shared budget. Clear only the fixture's synthetic reservations between cases.
  await db.executeRaw("DELETE FROM cache WHERE key LIKE 'dnshe_budget:%'");
  const caa = await worker.fetch(new Request("https://test.invalid/api/domains/101/dns/42", { method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer offline-admin" },
    body: JSON.stringify({ type: "CAA", name: "@", caa_flag: 0, caa_tag: "issue", caa_value: "letsencrypt.org", subdomain_id: 999, record_id: "evil" }),
  }), { DB: d1, AES_KEY: "offline-test-key", ADMIN_TOKEN: "offline-admin" }, {} as ExecutionContext);
  assert.equal(caa.status, 200);
  assert.equal(writes[1].subdomain_id, 101);
  assert.equal(writes[1].record_id, "42");
  assert.equal(writes[1].content, '0 issue "letsencrypt.org"');
});

test("DNS name and input normalization preserve TXT whitespace, IDN, wildcard and safe routing", async t => {
  assert.equal(normalizeDnsInput({ type: "TXT", name: "@", content: "  payload  " }, "demo.example").content, "  payload  ");
  assert.equal(normalizeDnsInput({ type: "A", name: "*.DEMO.EXAMPLE.", content: "192.0.2.1" }, "demo.example").name, "*");
  assert.equal(normalizeDnsInput({ type: "A", name: "测试.demo.example", content: "192.0.2.1" }, "demo.example").name, "xn--0zwm56d");
  assert.throws(() => normalizeDnsInput({ type: "SRV", port: -1, target: "host" }, "demo.example"));
  const { db } = await fixture(t);
  await db.upsertDomain(1, domain);
  const client = new DNSHEClient("fixture", "fixture");
  client.createDnsRecord = async params => { assert.equal(params.subdomain_id, 101); return { success: true }; };
  client.updateDnsRecord = async params => { assert.equal(params.subdomain_id, 101); assert.equal(params.record_id, "42"); return { success: true }; };
  const input = { type: "A", name: "@", content: "192.0.2.1", subdomain_id: 999, record_id: "evil" };
  const context = { domain: (await db.getDomainById(101))!, client };
  await new DnsheDnsAdapter().createRecord(context, input);
  await new DnsheDnsAdapter().updateRecord(context, "42", input);
});

for (const provider of transportProviders) {
  test(`${provider}: real DAO/HTTP binding and credential changes share cooldown and retain typed failures`, async t => {
    const { db, d1, sqlite } = await fixture(t, provider);
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async () => { assert.fail("shared cooldown must block every production credential path before fetch"); };
    await new SharedProviderRequestScheduler(d1, provider).block(60_000);
    const existing = sqlite.prepare("SELECT * FROM accounts WHERE id=1").get();
    const created = await db.getClientForAccount(1);
    const read = created.client instanceof DNSHEClient ? () => created.client.getQuota()
      : created.client instanceof CloudflareClient ? () => created.client.listZones()
        : () => (created.client as DnspodClient).listDomains();
    await assert.rejects(read(), error => error instanceof ProviderApiError && error.error_code === "scheduler_cooldown");
    const key = provider === "dnspod" ? "AKIDfixture" : provider === "alidns" ? "LTAIfixture123" : "new-key";
    const body = { provider, alias: "changed", api_key: key, api_secret: "new-secret", api_token: "new-token" };
    for (const method of ["POST", "PUT"]) {
      sqlite.exec("DELETE FROM cache WHERE key LIKE 'dnshe_budget:%'");
      const response = await worker.fetch(new Request(`https://test.invalid/api/accounts${method === "PUT" ? "/1" : ""}`, {
        method, headers: { "Content-Type": "application/json", Authorization: "Bearer offline-admin" }, body: JSON.stringify(body),
      }), { DB: d1, AES_KEY: "offline-test-key", ADMIN_TOKEN: "offline-admin" }, {} as ExecutionContext);
      assert.equal(response.status, 429);
      const result = await response.json() as { error_code: string; details: { provider: string } };
      assert.equal(result.error_code, "upstream_scheduler_cooldown");
      assert.equal(result.details.provider, provider);
      assert.ok(Number(response.headers.get("Retry-After")) > 0);
      assert.deepEqual(sqlite.prepare("SELECT * FROM accounts WHERE id=1").get(), existing);
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM accounts").get()?.n, 1);
    }
  });
}

test("seven real batch-binding routes keep per-item scheduler metadata, masks and zero saved accounts", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { assert.fail("a cooled-down batch must not reach an upstream"); };
  for (const provider of transportProviders) {
    const { d1, sqlite } = await fixture(t, provider);
    await new SharedProviderRequestScheduler(d1, provider).block(60_000);
    const key = provider === "dnspod" ? "AKIDfixture123" : provider === "alidns" ? "LTAIfixture123" : "batch-key-fixture";
    const item = { alias: "batch", api_key: key, api_secret: "batch-secret-fixture", api_token: "batch-token-fixture" };
    const response = await request(d1, "/api/accounts/batch", { provider, accounts: [item, {}] }, true);
    assert.equal(response.status, 200, "batch envelope remains successful even when individual bindings fail");
    const body = await response.json() as { success_count: number; fail_count: number; account_ids: number[];
      results: { success: boolean; error_code?: string; status?: number; retry_after_ms?: number;
        details?: { provider: string; details: { scope: string; request_sent: boolean } } }[]; actionId?: string };
    assert.equal(body.success_count, 0);
    assert.equal(body.fail_count, 2);
    assert.deepEqual(body.account_ids, []);
    assert.equal(body.actionId, undefined);
    const result = body.results[0];
    assert.equal(result.success, false);
    assert.equal(result.error_code, "upstream_scheduler_cooldown");
    assert.equal(result.status, 429);
    assert.ok(result.retry_after_ms! > 50_000);
    assert.equal(result.details?.provider, provider);
    assert.equal(result.details?.details.scope, "deployment_provider");
    assert.equal(result.details?.details.request_sent, false);
    assert.equal(body.results[1].error_code, undefined, "missing fields remain ordinary item validation failures");
    const wire = JSON.stringify(body);
    for (const credential of [key, item.api_secret, item.api_token]) assert.equal(wire.includes(credential), false);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM accounts").get()?.n, 1);
  }
});

test("scanner WHOIS and manual/account sync share credential cooldown without corrupting cached results", async t => {
  const { db, d1, sqlite } = await fixture(t);
  await db.upsertDomain(1, domain);
  const stored = await db.getDomainById(101);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { assert.fail("saturated scanner/sync must not send any upstream request"); };
  const storedKey = String(sqlite.prepare("SELECT api_key FROM accounts WHERE id=1").get()?.api_key);
  await new DnsheAccountRequestScheduler(d1, storedKey).block(60_000);
  const response = await request(d1, "/api/whois?domain=demo.example&account_id=1&batch=1", undefined, true);
  assert.equal(response.status, 429);
  assert.equal((await response.json() as { error_code: string }).error_code, "upstream_scheduler_cooldown");
  assert.deepEqual(await db.getWhoisPool(["demo.example"]), []);
  sqlite.exec("DELETE FROM cache WHERE key LIKE 'dnshe_budget:%'");
  await assert.rejects(resyncAccountsInBackground(db, [1]), error => {
    assert.ok(error instanceof IncompleteSyncError);
    assert.equal(error.result.accounts[0].issues[0].error_code, "scheduler_cooldown");
    assert.equal(error.result.accounts[0].status, "failed");
    return true;
  });
  assert.deepEqual(await db.getDomainById(101), stored);
});

test("five-account scanner uses independent credential lanes; all WHOIS results reach the pool", async t => {
  const { db, d1 } = await fixture(t);
  const accounts = [1, 2, 3, 4, 5].map(id => ({ id, alias: `fixture-${id}` }));
  const tasks = accounts.map(acc => ({ sub: `a${acc.id}`, root: "example", full: `a${acc.id}.example`, queryFull: `a${acc.id}.example` }));
  t.mock.method(DatabaseManager.prototype, "getClientForAccount", async (id: number) => {
    const key = `offline-scanner-${id}`;
    return { client: new DNSHEClient(key, "offline-secret", undefined,
      { scheduler: new DnsheAccountRequestScheduler(d1, key) }), alias: `fixture-${id}`, provider: "dnshe" };
  });
  let active = 0;
  let peak = 0;
  let sent = 0;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(url.searchParams.get("endpoint"), "whois");
    sent++;
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active--;
    return Response.json({ success: true, registered: true, domain: url.searchParams.get("domain") });
  };
  const statuses: number[] = [];
  const result = await runScannerWorkers({ tasks, accounts: accounts as import("../../frontend/src/types/account").Account[], rateLimitMs: 0,
    getStatus: () => "running", waitWhilePaused: async () => {}, shouldSkip: () => false, onTaskClaimed: () => {}, onSkipped: () => {},
    processTask: async (task, account) => {
      const response = await request(d1, `/api/whois?domain=${task.queryFull}&account_id=${account!.id}&batch=1`, undefined, true);
      statuses.push(response.status);
      if (!response.ok) return "failed";
      assert.equal((await response.json() as { whois: { registered: boolean } }).whois.registered, true);
    },
  });
  assert.deepEqual(statuses, [200, 200, 200, 200, 200]);
  assert.equal(sent, 5);
  assert.equal(peak, 5);
  assert.equal(result.processedCount, 5);
  assert.equal((await db.getWhoisPool(tasks.map(task => task.queryFull))).length, 5);
});

const businessProviderCases = businessRateLimits.filter((item, index, all) => all.findIndex(v => v.provider === item.provider) === index);
for (const { provider, code } of businessProviderCases) {
  test(`${provider}: business limits reach DNS HTTP and sync Actions without adopting empty/failed snapshots`, async t => {
    const { db, d1 } = await fixture(t, provider);
    await db.upsertDomain(1, { ...domain, remote_id: "zone-1" });
    const stored = (await db.getDomainById(101))!;
    const { client } = transportFixture(provider, { scheduler: new SharedProviderRequestScheduler(d1, provider) });
    t.mock.method(DatabaseManager.prototype, "getClientForAccount", async () => ({ client, alias: "fixture", provider }));
    t.mock.method(DatabaseManager.prototype, "refreshAccountQuotaCache", async () => {});
    const old = JSON.stringify([{ id: "last-good", type: "A", content: "192.0.2.1" }]);
    await db.setCache("api_cache:dns:101", old);
    await new DnsService(db).invalidate(101);
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    let sent = 0;
    globalThis.fetch = async () => {
      sent++;
      return Response.json(transportErrorBody(provider, code), { headers: { "Retry-After": "3" } });
    };
    for (const write of [false, true]) {
      await db.executeRaw("DELETE FROM cache WHERE key LIKE 'provider_scheduler:%'");
      const before = sent;
      const response = await request(d1, "/api/domains/101/dns?refresh=1", write
        ? { type: "A", name: "www", content: "192.0.2.2", ttl: 300 } : undefined, true);
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("Retry-After"), "3");
      const body = await response.json() as { error_code: string; details: { upstream_status: number; upstream_code: string; rate_limited: boolean } };
      assert.equal(body.error_code, `upstream_${code}`);
      assert.equal(body.details.upstream_status, 200);
      assert.equal(body.details.upstream_code, code);
      assert.equal(body.details.rate_limited, true);
      assert.equal(sent, before + 1, "one upstream attempt only, even for a mutation");
    }
    const { call, drain } = syncRoutes(db);
    for (const path of ["/api/accounts/1/sync", "/api/domains/sync"]) {
      await db.executeRaw("DELETE FROM cache WHERE key LIKE 'provider_scheduler:%'");
      const state = await driveSliced(call, path);
      assert.equal(state.status, "paused");
      const issue = state.failure!;
      assert.equal(issue.error_code, code);
      assert.equal(issue.status, 200, "existing status continues to carry the upstream HTTP status");
      assert.equal(issue.panelStatus, 429);
      assert.equal(issue.rateLimited, true);
      assert.equal(issue.retryAfterMs, 3000);
      await call(`/api/actions/${state.taskId}/cancel`, "POST");
    }
    assert.equal(await db.getCache("api_cache:dns:101"), old);
    assert.equal(await db.getCache("dns_dirty:101"), "1");
    assert.deepEqual(await db.getDomainById(101), stored);
  });
}

test("real batch binding retains business metadata and applies provider-specific cooldown scope without saving or leaking credentials", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const { provider, code } of businessProviderCases) {
    const { d1, sqlite } = await fixture(t, provider);
    let sent = 0;
    globalThis.fetch = async () => {
      sent++;
      return Response.json(transportErrorBody(provider, code), { status: provider === "alidns" ? 400 : 200, headers: { "Retry-After": "60" } });
    };
    const make = (n: number) => ({ alias: `business-${n}`, api_key: provider === "dnspod" ? `AKIDbusinessfixture${n}`
      : provider === "alidns" ? `LTAIbusinessfixture${n}` : `business-key-fixture${n}`,
      api_secret: `business-secret-fixture${n}`, api_token: `business-token-fixture${n}` });
    const items = [make(1), make(2)];
    const response = await request(d1, "/api/accounts/batch", { provider, accounts: items }, true);
    assert.equal(response.status, 200);
    const body = await response.json() as { success_count: number; fail_count: number; actionId?: string;
      results: { error_code: string; status: number; retry_after_ms: number;
        details: { upstream_status: number; upstream_code: string; rate_limited?: boolean; details?: { request_sent: boolean } } }[] };
    assert.equal(body.success_count, 0);
    assert.equal(body.fail_count, 2);
    assert.equal(body.actionId, undefined);
    const first = body.results[0];
    assert.equal(first.error_code, `upstream_${code}`);
    assert.equal(first.status, 429);
    assert.equal(first.retry_after_ms, 60_000);
    assert.equal(first.details.upstream_status, provider === "alidns" ? 400 : 200);
    assert.equal(first.details.upstream_code, code);
    assert.equal(first.details.rate_limited, true);
    if (provider === "dnshe") {
      assert.equal(body.results[1].error_code, `upstream_${code}`);
      assert.equal(sent, 2, "DNSHE distinct credentials do not share new upstream cooldowns");
    } else {
      assert.equal(body.results[1].error_code, "upstream_scheduler_cooldown");
      assert.equal(body.results[1].details.details?.request_sent, false);
      assert.equal(sent, 1, "other providers keep deployment/provider cooldown");
    }
    const wire = JSON.stringify(body);
    for (const item of items) for (const credential of [item.api_key, item.api_secret, item.api_token]) assert.equal(wire.includes(credential), false);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM accounts").get()?.n, 1);
  }
});

for (const provider of transportProviders) {
  test(`${provider}: hung coordination reaches DNS HTTP and both Actions, preserving cached DNS/dirty and domain rows`, async t => {
    const { db, d1 } = await fixture(t, provider);
    await db.upsertDomain(1, { ...domain, remote_id: "zone-1" });
    const stored = (await db.getDomainById(101))!;
    const old = JSON.stringify([{ id: "last-good", type: "A", content: "192.0.2.1" }]);
    await db.setCache("api_cache:dns:101", old);
    await new DnsService(db).invalidate(101);
    const gate = deferred();
    let claims = 0;
    const slow = coordinationFault(d1, (sql, _method, execute) => {
      if (sql.startsWith("INSERT INTO cache")) { claims++; return gate.promise.then(() => null); }
      return execute();
    });
    const { client } = transportFixture(provider, { scheduler: new SharedProviderRequestScheduler(slow, provider, Date.now, 30) });
    t.mock.method(DatabaseManager.prototype, "getClientForAccount", async () => ({ client, alias: "fixture", provider }));
    t.mock.method(DatabaseManager.prototype, "refreshAccountQuotaCache", async () => {});
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async () => { assert.fail("failed coordination must not send a DNS request"); };
    for (const write of [false, true]) {
      const response = await request(d1, "/api/domains/101/dns?refresh=1", write
        ? { type: "A", name: "www", content: "192.0.2.2", ttl: 300 } : undefined, true);
      assert.equal(response.status, 502);
      const body = await response.json() as { error_code: string; details: { details: { request_sent: boolean; coordination_operation: string } } };
      assert.equal(body.error_code, "upstream_scheduler_timeout");
      assert.equal(body.details.details.request_sent, false);
      assert.equal(body.details.details.coordination_operation, "acquire");
    }
    const { call, drain } = syncRoutes(db);
    for (const path of ["/api/accounts/1/sync", "/api/domains/sync"]) {
      const state = await driveSliced(call, path);
      assert.equal(state.status, "paused");
      assert.equal(state.failure?.error_code, "scheduler_timeout");
      assert.equal(state.failure?.status, 502);
      assert.equal(state.failure?.panelStatus, 502);
      await call(`/api/actions/${state.taskId}/cancel`, "POST");
    }
    const before = claims;
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(claims, before, "late empty claims must not continue into a second slot or restart failed Actions");
    assert.equal(await db.getCache("api_cache:dns:101"), old);
    assert.equal(await db.getCache("dns_dirty:101"), "1");
    assert.deepEqual(await db.getDomainById(101), stored);
  });
}

test("real DAO/default 2s scheduler bounds single/batch binding DB hangs and retains per-item metadata without saving", async t => {
  const { d1, sqlite } = await fixture(t, "vercel");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { assert.fail("hung production coordination must not send or bind"); };
  const gate = deferred();
  let claims = 0;
  const slow = coordinationFault(d1, (sql, _method, execute) => {
    if (sql.includes("SELECT ?, ?, ? WHERE NOT EXISTS")) { claims++; return gate.promise.then(() => null); }
    return execute();
  });
  const single = await request(slow, "/api/accounts", { provider: "vercel", api_token: "secret-single-token", alias: "single" }, true);
  assert.equal(single.status, 502);
  assert.equal((await single.json() as { error_code: string }).error_code, "upstream_scheduler_timeout");
  const batch = await request(slow, "/api/accounts/batch", { provider: "vercel", accounts: [{ api_token: "secret-batch-token", alias: "batch" }] }, true);
  assert.equal(batch.status, 200);
  const body = await batch.json() as { success_count: number; fail_count: number; actionId?: string; results: {
    error_code: string; status: number; details: { details: { coordination_timeout_ms: number; request_sent: boolean } } }[] };
  assert.equal(body.success_count, 0);
  assert.equal(body.fail_count, 1);
  assert.equal(body.actionId, undefined);
  assert.equal(body.results[0].error_code, "upstream_scheduler_timeout");
  assert.equal(body.results[0].status, 502);
  assert.equal(body.results[0].details.details.coordination_timeout_ms, 2000);
  assert.equal(body.results[0].details.details.request_sent, false);
  assert.equal(JSON.stringify(body).includes("secret-batch-token"), false);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM accounts").get()?.n, 1);
  gate.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(claims, 2);
});
