import "../helpers/block-outbound";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createD1FromSqlite } from "../../server/d1-sqlite";
import { DatabaseManager } from "../../src/db";
import { AUTOMATION_SCHEMA } from "../../src/db/automation-schema";
import { DNSHEClient } from "../../src/dnshe";
import { CloudflareClient } from "../../src/cloudflare";
import { syncPlan, syncStep, syncView } from "../../src/services/sliced-sync-service";
import { cancelSyncTask, getSyncTask, purgeSyncHistory, claimSyncTask } from "../../src/db/dao/sync-task-dao";
import { runReminderRenewal } from "../../src/services/reminder-renewal-service";
import { renewCachedDomain } from "../../src/services/renewal-service";
import { ProviderApiError } from "../../src/errors/provider-api-error";
import { InvocationBudget, InvocationBudgetError } from "../../src/services/invocation-budget";
import { withBudgetD1 } from "../../src/db/budget-d1";
import { canAdvanceSync, validateSliceState } from "../../frontend/src/lib/sliced-sync";
import { coordinationFault } from "../helpers/coordination-fault";
import { DnsheAccountRequestScheduler } from "../../src/services/dnshe-account-scheduler";
import { sha256Hex } from "../../src/db/crypto";
import { scaleSync, scalePlan, sqlProbe } from "../helpers/sync-scale";

const schema = readFileSync("schema.sql", "utf8");

test("scale: snapshot collision and DNS joins seek integer primary keys instead of scanning domains", async () => {
  const result = await scaleSync({ accounts: 2, domains: 3, dnsPages: 2, unrelatedDomains: 100 });
  const joins = result.sql.filter(s => s.sql.includes("CAST(d.id AS TEXT)=i.domain_id"));
  assert.equal(joins.length, 3, "all three production collision/DNS queries must be exercised");
  for (const query of joins) assert.ok(query.plan.some(line => /SEARCH d USING INTEGER PRIMARY KEY/.test(line)), `${query.sql}\n${query.plan.join("\n")}`);
  assert.equal(result.externalPages, 14); assert.equal(result.growth[0].fragments, 12);
});

test("scale: plan chooses one latest row per account, including timestamp ties, in bounded pages", async () => {
  const result = await scalePlan(51, 30);
  assert.deepEqual(result.pages.map(page => page.accounts), [25, 25, 1]);
  assert.ok(result.pages.every(page => page.d1 <= 3));
  const queries = result.sql.filter(s => s.sql.startsWith("SELECT t.*"));
  assert.ok(queries.length > 0);
  for (const query of queries) assert.ok(query.plan.some(line => /SEARCH t USING INTEGER PRIMARY KEY/.test(line)), query.plan.join("\n"));
});

test("scale: latest plan preserves time ordering, full-mode isolation and account filters", async t => {
  const { sqlite, db } = fixture(t);
  sqlite.exec("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(2,'custom','custom-key','offline','custom'),(3,'offline','key-3','offline','dnshe')");
  const insert = sqlite.prepare(`INSERT INTO sync_tasks(id,generation,account_id,provider,scope_revision,mode,phase,status,last_completed_at,created_at,updated_at)
    VALUES(?,'offline',1,'dnshe',1,?,'done','completed',100,?,100)`);
  insert.run("latest-full", "full", 200); insert.run("later-insert-older-time", "full", 100); insert.run("latest-list", "list", 300);
  sqlite.exec("UPDATE sync_tasks SET cursor='{}' WHERE id='later-insert-older-time'");
  const plan = await syncPlan(db, { manual: true });
  assert.deepEqual(plan.plans.map(row => row.accountId), [1, 3]); assert.equal(plan.plans[0].taskId, "latest-full");
  assert.deepEqual((await syncPlan(db, { manual: true, after: 1, accountIds: [1, 3], provider: "dnshe" })).plans.map(row => row.accountId), [3]);
  assert.deepEqual((await syncPlan(db, { accountIds: [] })).plans, []);
});

test("scale: indexed snapshot publication and DNS preserve signed, zero and large safe IDs", async t => {
  const { sqlite } = fixture(t), probe = sqlProbe(sqlite);
  const ids = [-Number.MAX_SAFE_INTEGER, -10, -1, 0, 2, 10, Number.MAX_SAFE_INTEGER];
  const step = async (taskId?: string) => {
    const budget = new InvocationBudget(), db = new DatabaseManager(withBudgetD1(probe.connection, budget));
    const client = dnsClient(db);
    client.listSubdomains = async () => ({ success: true, total: ids.length, subdomains: ids.map(id => ({ id, subdomain: `d${id}`, rootdomain: "example.test", full_domain: `d${id}.example.test`, status: "active", expires_at: "2027-01-01" })) });
    client.listDnsRecordsPage = async id => ({ success: true, records: [{ id: String(id), name: "@", type: "A", content: "192.0.2.1", ttl: 60 }], pagination: { has_more: false } });
    return syncStep(db, 1, { manual: true, taskId });
  };
  let state = await step();
  for (let n = 0; state.status === "queued" && n < 40; n++) state = await step(state.taskId);
  assert.equal(state.status, "completed"); assert.equal(state.dns_completed, ids.length);
  assert.deepEqual(sqlite.prepare("SELECT id FROM domains_cache ORDER BY id").all().map(row => row.id), ids);
  for (const id of ids) assert.equal(JSON.parse(String(sqlite.prepare("SELECT value FROM cache WHERE key=?").get(`api_cache:dns:${id}`)!.value))[0].id, String(id));
  // Inspect the production predicate's exact-match semantics, not a rewritten
  // test query: coercible noncanonical text must not alias a real integer ID.
  const query = [...probe.samples.values()].find(s => s.sql.startsWith("SELECT d.id,COALESCE") && s.sql.includes("sync_items"))!.sql;
  for (const text of ["02", "+2", "2.0", "2e0", "2junk", " 2"]) {
    sqlite.prepare("UPDATE sync_items SET domain_id=? WHERE task_id=? AND kind='seen' AND domain_id='2'").run(text, state.taskId);
    assert.deepEqual(sqlite.prepare(query).all(state.taskId, sqlite.prepare("SELECT generation FROM sync_tasks WHERE id=?").get(state.taskId)!.generation, "19", 1).map(row => row.id), [Number.MAX_SAFE_INTEGER]);
    sqlite.prepare("UPDATE sync_items SET domain_id='2' WHERE task_id=? AND kind='seen' AND domain_id=?").run(state.taskId, text);
  }
});

test("scale: indexed atomic assertion still blocks a cross-account collision introduced after the snapshot read", async t => {
  const { connection, sqlite, db } = fixture(t); domain(sqlite); dnsClient(db);
  sqlite.exec("INSERT INTO accounts(id,alias,api_key,api_secret) VALUES(2,'offline-other','other-key','offline')");
  const first = await syncStep(db, 1, { manual: true }); await syncStep(db, 1, { manual: true, taskId: first.taskId });
  const cursor = sqlite.prepare("SELECT cursor FROM sync_tasks WHERE id=?").get(first.taskId)!.cursor;
  let snapshotRead = false, injected = false;
  const faulty = coordinationFault(connection, async (sql, method, execute) => {
    if (method === "batch" && snapshotRead && !injected) { injected = true; sqlite.exec("UPDATE domains_cache SET account_id=2 WHERE id=1"); }
    const result = await execute();
    if (sql.startsWith("SELECT COUNT(*) AS count")) snapshotRead = true;
    return result;
  });
  const budget = new InvocationBudget(), manager = new DatabaseManager(withBudgetD1(faulty, budget)); dnsClient(manager);
  const state = await syncStep(manager, 1, { manual: true, taskId: first.taskId });
  assert.equal(injected, true); assert.equal(state.status, "blocked"); assert.equal(state.last_completed_at, null);
  assert.equal(sqlite.prepare("SELECT cursor FROM sync_tasks WHERE id=?").get(first.taskId)!.cursor, cursor);
  assert.equal(sqlite.prepare("SELECT account_id FROM domains_cache WHERE id=1").get()!.account_id, 2);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sync_commit_assertions").get()!.n, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM logs WHERE type='success'").get()!.n, 0);
  assert.ok(budget.snapshot().used.d1 <= 40); assert.deepEqual(budget.snapshot().reserved, { d1: 0, external: 0 });
});
function fixture(t: TestContext, provider = "dnshe") {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close()); sqlite.exec(schema);
  sqlite.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'offline','offline','offline',?)").run(provider);
  const connection = createD1FromSqlite(sqlite);
  return { sqlite, connection, db: new DatabaseManager(connection) };
}
function domain(sqlite: DatabaseSync, id = 1, expiry = "2026-11-02") {
  sqlite.prepare("INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at) VALUES(?,1,'a','example.test',?,'已解析',?)").run(id, `a${id}.example.test`, expiry);
}
function dnsClient(db: DatabaseManager) {
  const client = new DNSHEClient("offline", "offline");
  db.getClientForAccount = async () => ({ client, alias: "offline", provider: "dnshe" });
  client.listSubdomains = async () => ({ success: true, subdomains: [{ id: 1, subdomain: "a", rootdomain: "example.test", full_domain: "a1.example.test", status: "active", created_at: "", expires_at: "2026-11-02" }], total: 1 });
  client.listDnsRecordsPage = async () => ({ success: true, records: [], pagination: { has_more: false } });
  return client;
}

for (const bytes of [32768, 32769]) test(`dense DNS single-page UTF-8 boundary ${bytes} bytes preserves safety`, async t => {
  const { db, sqlite } = fixture(t); domain(sqlite); const client = dnsClient(db);
  sqlite.exec("INSERT INTO cache VALUES('api_cache:dns:1','[\"keep-old\"]',9999999999)");
  const record = { id: "dense", name: "@", type: "TXT", content: "中", ttl: 60 };
  const base = new TextEncoder().encode(JSON.stringify({ cursor: 0, records: [record] })).length;
  record.content += "x".repeat(bytes-base);
  client.listDnsRecordsPage = async () => ({ success: true, records: [record], pagination: { has_more: false } });
  const state = await finish(db);
  assert.equal(state.status, bytes === 32768 ? "completed" : "blocked");
  const cached = String(sqlite.prepare("SELECT value FROM cache WHERE key='api_cache:dns:1'").get()!.value);
  if (bytes === 32768) assert.deepEqual(JSON.parse(cached), [record]);
  else { assert.equal(cached, '["keep-old"]'); assert.match(state.error!, /32KiB/); }
});

for (const pages of [4, 5]) test(`dense DNS ${pages} pages of 100 records enforce cumulative 128KiB`, async t => {
  const { db, sqlite } = fixture(t); domain(sqlite); const client = dnsClient(db);
  sqlite.exec("INSERT INTO cache VALUES('api_cache:dns:1','[\"keep-old\"]',9999999999)");
  let calls = 0;
  client.listDnsRecordsPage = async (_id, cursor = 0) => {
    calls++; const page = Number(cursor);
    const records = Array.from({ length: 100 }, (_, n) => ({ id: `${page}-${n}`, name: "@", type: "TXT", content: "x".repeat(220), ttl: 60 }));
    assert.ok(new TextEncoder().encode(JSON.stringify({ cursor, records })).length <= 32768);
    return { success: true, records, pagination: page + 1 < pages ? { has_more: true, next_cursor: page+1 } : { has_more: false } };
  };
  const state = await finish(db); assert.equal(calls, pages);
  assert.equal(state.status, pages === 4 ? "completed" : "blocked");
  const value = String(sqlite.prepare("SELECT value FROM cache WHERE key='api_cache:dns:1'").get()!.value);
  if (pages === 4) assert.equal(JSON.parse(value).length, 400); else assert.equal(value, '["keep-old"]');
});

for (const invalid of [null, "", {}, 1.5]) test(`DNS malformed identity ${JSON.stringify(invalid)} never publishes`, async t => {
  const { db, sqlite } = fixture(t); domain(sqlite); const client = dnsClient(db);
  sqlite.exec("INSERT INTO cache VALUES('api_cache:dns:1','[\"keep-old\"]',9999999999)");
  client.listDnsRecordsPage = async () => ({ success: true, records: [{ id: invalid as unknown as string, name: "@", type: "A", content: "192.0.2.1", ttl: 60 }], pagination: { has_more: false } });
  assert.equal((await finish(db)).status, "blocked");
  assert.equal(sqlite.prepare("SELECT value FROM cache WHERE key='api_cache:dns:1'").get()!.value, '["keep-old"]');
});
async function finish(db: DatabaseManager, taskId?: string) {
  let result;
  for (let n = 0; n < 80; n++) {
    result = await syncStep(db, 1, { manual: true, taskId }); taskId = result.taskId;
    if (!result.continuation || result.retry_after_ms) break;
  }
  return result!;
}
test("automation migration is equivalent and idempotent", t => {
  const { sqlite } = fixture(t); const b = new DatabaseSync(":memory:"); t.after(() => b.close());
  b.exec(schema.slice(0, schema.indexOf("-- 11.")));
  for (const sql of AUTOMATION_SCHEMA) { b.exec(sql); b.exec(sql); }
  const defs = (s: DatabaseSync) => s.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'domain_mut%' OR name LIKE 'renewal_%' OR name LIKE 'reminder_%' OR name IN ('sync_commit_assertions','idx_domains_expiry','idx_renewal_pending') ORDER BY name").all().map(r => ({ ...r, sql: String(r.sql).replace(/\s+/g, " ").replace(/;$/, "").trim() }));
  assert.deepEqual(defs(sqlite), defs(b));
});
test("Cron with no candidates/channels sends zero upstream requests", async t => {
  const { db } = fixture(t); assert.deepEqual(await runReminderRenewal(db), { renewed: 0, failed: 0, deferred: 0, reportCount: 0 });
});
test("Cron reminder-only uses local CF/RDAP dates and never fetches", async t => {
  const { db, sqlite } = fixture(t, "cloudflare"); domain(sqlite);
  sqlite.exec("INSERT INTO cache VALUES('rdap:4:a1.example.test','{\"found\":true,\"expires_at\":\"2026-11-02\"}',9999999999)");
  assert.equal((await runReminderRenewal(db)).reportCount, 1);
});
test("success channel is deduplicated; failure is backed off, never marked sent", async t => {
  const { db, sqlite } = fixture(t); domain(sqlite, 1, "2020-01-01");
  sqlite.exec("INSERT INTO settings VALUES('cfg_tg_token','offline',''); INSERT INTO settings VALUES('cfg_tg_chat_id','offline',''); INSERT INTO settings VALUES('cfg_webhook_url','https://offline.invalid','')");
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; }); let telegram = 0, webhook = 0;
  globalThis.fetch = async input => { if (String(input).includes("telegram.org")) { telegram++; return new Response('{"ok":true}'); } webhook++; return new Response("failure", { status: 503 }); };
  await runReminderRenewal(db); await runReminderRenewal(db); assert.equal(telegram, 1); assert.equal(webhook, 1);
  assert.deepEqual(sqlite.prepare("SELECT channel,status FROM reminder_deliveries ORDER BY channel").all().map(r => ({ ...r })), [{ channel: "telegram", status: "sent" }, { channel: "webhook", status: "failed" }]);
});
test("unknown renewal intent only GET-verifies on the next attempt", async t => {
  const { db, sqlite } = fixture(t); domain(sqlite); const client = dnsClient(db); let posts = 0, gets = 0;
  client.renewSubdomain = async () => { posts++; throw new ProviderApiError("dnshe", 502, "transport_error", "unknown", { request_sent: "unknown" }); };
  client.getSubdomain = async () => { gets++; return { success: true, subdomain: { id: 1, subdomain: "a", rootdomain: "example.test", full_domain: "a1.example.test", status: "active", created_at: "", expires_at: "2027-11-02" } }; };
  await assert.rejects(renewCachedDomain(db, 1)); assert.equal(sqlite.prepare("SELECT status FROM renewal_intents").get()?.status, "verify");
  sqlite.exec("UPDATE renewal_intents SET next_attempt_at=0,lease_until=0");
  assert.equal((await renewCachedDomain(db, 1)).new_expires_at, "2027-11-02"); assert.equal(posts, 1); assert.equal(gets, 1);
});
test("overlapping manual renewals cannot send a second POST", async t => {
  const { db, sqlite } = fixture(t); domain(sqlite); const client = dnsClient(db);
  let release!: () => void; const hold = new Promise<void>(r => release = r); let entered!: () => void; const started = new Promise<void>(r => entered = r); let posts = 0;
  client.renewSubdomain = async () => { posts++; entered(); await hold; return { success: true, new_expires_at: "2027-11-02" }; };
  const first = renewCachedDomain(db, 1); await started; await assert.rejects(renewCachedDomain(db, 1), /正在处理/); release(); await first; assert.equal(posts, 1);
});
test("renewal scope change cannot overwrite cache", async t => {
  const { db, sqlite } = fixture(t); domain(sqlite); const client = dnsClient(db);
  client.renewSubdomain = async () => { sqlite.exec("UPDATE accounts SET api_secret='new-secret'"); return { success: true, new_expires_at: "2027-11-02" }; };
  await assert.rejects(renewCachedDomain(db, 1)); assert.equal(sqlite.prepare("SELECT expires_at FROM domains_cache").get()?.expires_at, "2026-11-02");
  assert.equal(sqlite.prepare("SELECT status FROM renewal_intents").get()?.status, "verify");
});
test("old list cannot overwrite concurrent confirmed renewal", async t => {
  const { db, sqlite } = fixture(t); domain(sqlite); dnsClient(db); const first = await syncStep(db, 1, { manual: true });
  await syncStep(db, 1, { manual: true, taskId: first.taskId }); sqlite.exec("UPDATE domains_cache SET expires_at='2027-11-02'");
  assert.equal((await finish(db, first.taskId)).status, "completed"); assert.equal(sqlite.prepare("SELECT expires_at FROM domains_cache").get()?.expires_at, "2027-11-02");
});
test("multi-cursor DNS is staged and only the complete snapshot is published", async t => {
  const { db, sqlite } = fixture(t); domain(sqlite); const client = dnsClient(db);
  sqlite.exec("INSERT INTO cache VALUES('api_cache:dns:1','[{\"id\":\"old\"}]',9999999999)");
  client.listDnsRecordsPage = async (_id, cursor) => ({ success: true, records: [{ id: String(cursor), name: "@", type: "A", content: "192.0.2.1", ttl: 60 }], pagination: cursor === 0 ? { has_more: true, next_cursor: "next" } : { has_more: false } });
  let state = await syncStep(db, 1, { manual: true }); for (let n = 0; n < 3; n++) state = await syncStep(db, 1, { manual: true, taskId: state.taskId });
  assert.equal(sqlite.prepare("SELECT value FROM cache WHERE key='api_cache:dns:1'").get()?.value, '[{"id":"old"}]');
  assert.equal((await finish(db, state.taskId)).status, "completed"); assert.equal(JSON.parse(String(sqlite.prepare("SELECT value FROM cache WHERE key='api_cache:dns:1'").get()?.value)).length, 2);
});

for (const boundary of ["list", "dns", "leased-dns"] as const) {
  test(`file-backed ${boundary} interruption resumes the same generation after SQLite reopen without page replay`, async t => {
    const temp = process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Temp/opencode") : tmpdir();
    // Retain only this newly created synthetic fixture, never copy real accounts.
    const file = join(mkdtempSync(join(temp, "sync-reopen-")), "fixture.db");
    let sqlite = new DatabaseSync(file); t.after(() => sqlite.close()); sqlite.exec(schema);
    sqlite.exec("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'offline','offline','offline','dnshe')");
    domain(sqlite); sqlite.exec("INSERT INTO cache VALUES('api_cache:dns:1','[{\"id\":\"old\"}]',9999999999)");
    let connection = createD1FromSqlite(sqlite), lists = 0;
    const pages: string[] = [];
    const client = new DNSHEClient("offline", "offline");
    client.listSubdomains = async () => { lists++; return { success: true, total: 1, subdomains: [{ id: 1, subdomain: "a", rootdomain: "example.test", full_domain: "a1.example.test", status: "active", expires_at: "2027-01-01" }] }; };
    client.listDnsRecordsPage = async (_id, cursor) => {
      pages.push(String(cursor));
      return { success: true, records: [{ id: `page-${cursor}`, name: "@", type: "A", content: "192.0.2.1", ttl: 60 }],
        pagination: cursor === 0 ? { has_more: true, next_cursor: "second" } : { has_more: false } };
    };
    const step = async (taskId?: string) => {
      const budget = new InvocationBudget(); const db = new DatabaseManager(withBudgetD1(connection, budget));
      db.getClientForAccount = async () => ({ client, alias: "offline", provider: "dnshe" });
      const state = await syncStep(db, 1, { manual: true, taskId });
      assert.ok(budget.snapshot().used.d1 <= 40); assert.equal(budget.snapshot().used.external, 0);
      assert.deepEqual(budget.snapshot().reserved, { d1: 0, external: 0 });
      return state;
    };
    let state = await step(); const taskId = state.taskId;
    for (let n = 0; n < 10 && (boundary === "list" ? state.list_stage !== "publish" : pages.length !== 1); n++) state = await step(taskId);
    assert.equal(lists, 1); assert.equal(state.last_completed_at, null);
    assert.equal(sqlite.prepare("SELECT value FROM cache WHERE key='api_cache:dns:1'").get()?.value, '[{"id":"old"}]');
    const saved = (await getSyncTask(connection, taskId))!;
    if (boundary === "leased-dns") {
      assert.ok(await claimSyncTask(connection, saved, "abandoned-offline-runner"));
    }
    const fragments = sqlite.prepare("SELECT * FROM sync_fragments ORDER BY page").all();
    sqlite.close(); sqlite = new DatabaseSync(file); connection = createD1FromSqlite(sqlite);
    assert.equal(sqlite.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    const reopened = (await getSyncTask(connection, taskId))!;
    assert.equal(reopened.generation, saved.generation); assert.equal(reopened.cursor, saved.cursor);
    assert.deepEqual(sqlite.prepare("SELECT * FROM sync_fragments ORDER BY page").all(), fragments);
    if (boundary === "leased-dns") {
      const calls = pages.length;
      assert.equal((await step(taskId)).status, "running"); assert.equal(pages.length, calls, "valid abandoned lease must not be reclaimed early");
      // Only the synthetic fixture clock boundary is expired; production state
      // is never edited and no runtime crash/cancellation guarantee is implied.
      sqlite.prepare("UPDATE sync_tasks SET lease_until=CAST(strftime('%s','now') AS INTEGER)-1 WHERE id=?").run(taskId);
    }
    for (let n = 0; n < 20 && state.status !== "completed"; n++) {
      state = await step(taskId); assert.equal(state.taskId, taskId);
    }
    assert.equal(state.status, "completed"); assert.equal(state.dns_completed, 1);
    assert.equal(lists, 1); assert.deepEqual(pages, ["0", "second"]);
    assert.equal((await getSyncTask(connection, taskId))!.generation, saved.generation);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sync_tasks").get()?.n, 1);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM logs WHERE type='success' AND category='sync'").get()?.n, 1);
    const cache = JSON.parse(String(sqlite.prepare("SELECT value FROM cache WHERE key='api_cache:dns:1'").get()?.value));
    assert.deepEqual(cache.map((record: { id: string }) => record.id), ["page-0", "page-second"]);
    const version = state.version;
    assert.equal((await step(taskId)).version, version, "terminal reread must not start a replacement task");
    assert.equal(lists, 1); assert.deepEqual(pages, ["0", "second"]);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM logs WHERE type='success' AND category='sync'").get()?.n, 1);
  });
}

test("paused DNS 12/16 resumes the same task through a REAL lease with fresh 40-call slices", async t => {
  const { db, connection, sqlite } = fixture(t); const client = dnsClient(db); let lists = 0;
  client.listSubdomains = async () => { lists++; return {success:true,total:16,subdomains:Array.from({length:16}, (_,i) => ({id:100+i,subdomain:`a${i}`,rootdomain:"example.test",full_domain:`a${i}.example.test`,status:"active",expires_at:"2027-01-01"}))}; };
  let state = await syncStep(db, 1, {manual:true}); const taskId = state.taskId;
  for (let n = 0; n < 30 && state.dns_completed !== 12; n++) state = await syncStep(db, 1, {manual:true,taskId});
  assert.equal(state.dns_completed, 12); assert.equal(state.domain_count, 16);
  const before = (await getSyncTask(connection, taskId))!;
  client.listDnsRecordsPage = async () => { throw new ProviderApiError("dnshe",429,"rate_limited","offline queue timeout",{request_sent:false,scope:"dnshe_key"},1000); };
  const paused = await syncStep(db, 1, {manual:true,taskId});
  assert.equal(paused.status,"paused"); assert.equal(paused.dns_completed,12);
  assert.equal((await getSyncTask(connection, taskId))!.cursor,before.cursor);
  const oldCaches = sqlite.prepare("SELECT key,value FROM cache WHERE key LIKE 'api_cache:dns:%' ORDER BY key").all();
  assert.equal(oldCaches.length,12); assert.equal(paused.last_completed_at,null);
  const key = `dnshe_queue:v1:${await sha256Hex("offline")}`;
  let clock = 1793550000000;
  sqlite.prepare("INSERT INTO cache VALUES(?,?,?)").run(key, `{"owner":"abandoned","leaseUntil":1793547434000.0,"events":${JSON.stringify(Array(30).fill(clock-1000))}}`, 9999999999);
  // Test-only expiry of known task backoff, not a production repair or reset.
  sqlite.prepare("UPDATE sync_tasks SET next_attempt_at=0 WHERE id=?").run(taskId);
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; }); const sends: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(init?.method ?? "GET","GET");
    assert.equal(url.searchParams.get("endpoint"),"dns_records"); sends.push(url.searchParams.get("subdomain_id")!);
    return Response.json({success:true,records:[],pagination:{has_more:false}});
  };
  for (let n = 0; n < 12 && state.status !== "completed"; n++) {
    const budget = new InvocationBudget(); const wrapped = withBudgetD1(connection,budget); const fresh = new DatabaseManager(wrapped);
    fresh.getClientForAccount = async () => ({alias:"offline",provider:"dnshe",client:new DNSHEClient("offline","offline",undefined,{
      budget,scheduler:new DnsheAccountRequestScheduler(wrapped,"offline",() => clock,async ms => {clock+=ms;}),
    })});
    state = await syncStep(fresh,1,{manual:true,taskId});
    assert.equal(state.taskId,taskId); assert.ok(budget.snapshot().used.d1<=40); assert.ok(budget.snapshot().used.external<=1);
    assert.equal(state.status === "paused",false);
  }
  assert.equal(state.status,"completed"); assert.equal(state.dns_completed,16); assert.equal(lists,1);
  assert.deepEqual(sends,["112","113","114","115"]);
  assert.equal((await getSyncTask(connection,taskId))!.generation,before.generation);
  for (const row of oldCaches) assert.equal(sqlite.prepare("SELECT value FROM cache WHERE key=?").get(row.key)?.value,row.value);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sync_tasks WHERE account_id=1").get()?.n,1);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM logs WHERE type='success' AND category='sync'").get()?.n,1);
});
test("DNS concurrent mutation blocks task without replacing the old cache", async t => {
  const { db, sqlite } = fixture(t); domain(sqlite); const client = dnsClient(db);
  sqlite.exec("INSERT INTO cache VALUES('api_cache:dns:1','[{\"id\":\"old\"}]',9999999999)");
  client.listDnsRecordsPage = async () => { sqlite.exec("UPDATE domains_cache SET updated_at=updated_at"); return { success: true, records: [], pagination: { has_more: false } }; };
  assert.equal((await finish(db)).status, "blocked"); assert.equal(sqlite.prepare("SELECT value FROM cache WHERE key='api_cache:dns:1'").get()?.value, '[{"id":"old"}]');
});
test("51 CF zones use two invocations; deletion checks original candidate version", async t => {
  const { db, sqlite } = fixture(t, "cloudflare"); domain(sqlite, 99); domain(sqlite, 98); const client = new CloudflareClient("offline"); let pages = 0;
  db.getClientForAccount = async () => ({ client, alias: "offline", provider: "cloudflare" });
  client.listZones = async options => { pages++; const count = options?.startPage === 1 ? 50 : 1; return { zones: Array.from({ length: count }, (_, n) => ({ id: (n + (options?.startPage === 1 ? 1 : 51)).toString(16).padStart(32, "0"), name: `z${n + (options?.startPage === 1 ? 1 : 51)}.example.test`, status: "active", name_servers: [] })), hasMore: options?.startPage === 1 }; };
  let state = await syncStep(db, 1, { manual: true }); state = await syncStep(db, 1, { manual: true, taskId: state.taskId });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM domains_cache").get()?.n, 2); sqlite.exec("UPDATE domains_cache SET expires_at='2027-01-01' WHERE id=98");
  assert.equal((await finish(db, state.taskId)).status, "completed"); assert.equal(pages, 2); assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM domains_cache").get()?.n, 52);
  assert.ok(sqlite.prepare("SELECT id FROM domains_cache WHERE id=98").get()); assert.equal(sqlite.prepare("SELECT id FROM domains_cache WHERE id=99").get(), undefined);
});
test("explicit cancellation stays stopped after login and history cleanup", async t => {
  const { db, connection, sqlite } = fixture(t); dnsClient(db); sqlite.exec("INSERT INTO settings VALUES('cfg_login_sync_enabled','true','')");
  const state = await syncStep(db, 1, { manual: true }); await cancelSyncTask(connection, (await getSyncTask(connection, state.taskId))!);
  sqlite.exec("UPDATE sync_tasks SET updated_at=0"); await purgeSyncHistory(connection, 1);
  assert.equal((await syncPlan(db)).plans[0].eligible, false); assert.equal((await syncStep(db, 1)).status, "cancelled");
});
test("1000 accounts produce 25 local plans and upgrade default is disabled", async t => {
  const { db, sqlite } = fixture(t); for (let n = 2; n <= 1000; n++) sqlite.prepare("INSERT INTO accounts(id,alias,api_key,api_secret) VALUES(?,'offline',?,'offline')").run(n, `offline-${n}`);
  const plan = await syncPlan(db); assert.equal(plan.plans.length, 25); assert.equal(plan.nextAfter, 25); assert.equal(plan.enabled, false); assert.ok(plan.plans.every(p => !p.eligible));
});
test("one slice stays within strict budgets and releases reservations", async t => {
  const { connection, sqlite } = fixture(t); domain(sqlite); const budget = new InvocationBudget(); const db = new DatabaseManager(withBudgetD1(connection, budget)); dnsClient(db);
  assert.equal((await syncStep(db, 1, { manual: true })).status, "queued"); assert.ok(budget.snapshot().used.d1 <= 40); assert.equal(budget.snapshot().used.external, 0); assert.equal(budget.snapshot().reserved.d1, 0);
});

test("confirmed budget pause returns a resumable view using reserved read capacity and logs exact accounting", async t => {
  const { db, connection, sqlite } = fixture(t); dnsClient(db);
  const first = await syncStep(db, 1, { manual: true });
  const before = (await getSyncTask(connection, first.taskId))!;
  const budget = new InvocationBudget({ d1: 8 });
  const limited = new DatabaseManager(withBudgetD1(connection, budget));
  const client = dnsClient(limited);
  client.listSubdomains = async () => { budget.consume("d1"); assert.fail("budget must stop before upstream"); };
  const paused = await syncStep(limited, 1, { manual: true, taskId: first.taskId });
  assert.equal(paused.status, "paused"); assert.equal((paused as { budget_yield?: boolean }).budget_yield, true);
  assert.ok(paused.retry_after_ms > 0 && paused.retry_after_ms <= 1000);
  assert.equal(paused.last_completed_at, null);
  const saved = (await getSyncTask(connection, first.taskId))!;
  assert.equal(saved.cursor, before.cursor); assert.equal(saved.version, before.version + 2);
  const details = JSON.parse(String(sqlite.prepare("SELECT details FROM logs ORDER BY id DESC LIMIT 1").get()?.details));
  assert.equal(details.resource, "d1"); assert.equal(details.reason, "exhausted"); assert.equal(details.phase, "list");
  assert.equal(details.used, 5); assert.equal(details.reserved, 3); assert.equal(details.limit, 8);
  assert.equal((paused.failure?.details as {used: number}).used, 5);
  assert.ok(budget.snapshot().used.d1 <= 8); assert.equal(budget.snapshot().reserved.d1, 0);
  sqlite.prepare("UPDATE sync_tasks SET next_attempt_at=0 WHERE id=?").run(first.taskId);
  const fresh = new InvocationBudget(); const next = new DatabaseManager(withBudgetD1(connection, fresh)); dnsClient(next);
  assert.equal((await syncStep(next, 1, { manual: true, taskId: first.taskId })).status, "queued");
  assert.ok(fresh.snapshot().used.d1 <= 40);
});

for (const mode of ["unknown-request", "closed", "unknown-save", "failed-read", "lost-fence"]) {
  test(`budget ${mode} never returns automatic continuation`, async t => {
    const { db, connection, sqlite } = fixture(t); dnsClient(db);
    const first = await syncStep(db, 1, { manual: true });
    let saving = false;
    const fault = coordinationFault(connection, async (sql, method, execute) => {
      if (method === "batch" && saving) {
        if (mode === "lost-fence") sqlite.prepare("UPDATE sync_tasks SET version=version+1 WHERE id=?").run(first.taskId);
        const result = await execute();
        if (mode === "unknown-save") throw new Error("unknown paused batch outcome");
        return result;
      }
      if (mode === "failed-read" && saving && sql.startsWith("SELECT *,")) throw new Error("authoritative read failed");
      return execute();
    });
    const limited = new DatabaseManager(withBudgetD1(fault, new InvocationBudget()));
    const client = dnsClient(limited);
    client.listSubdomains = async () => { saving = true; throw new InvocationBudgetError("d1", mode === "closed" ? "closed" : "exhausted", mode === "unknown-request" ? "unknown" : false); };
    await assert.rejects(syncStep(limited, 1, { manual: true, taskId: first.taskId }), InvocationBudgetError);
    const saved = (await getSyncTask(connection, first.taskId))!;
    assert.equal(saved.last_completed_at, null);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM logs WHERE type='success'").get()?.n, 0);
  });
}
test("browser guard stops hidden tabs, logout and StrictMode cleanup; responses are checked", () => {
  assert.equal(canAdvanceSync("s", "s", true, false), true);
  assert.equal(canAdvanceSync("s", "s", false, false), false); assert.equal(canAdvanceSync(null, "s", true, false), false);
  assert.equal(canAdvanceSync("new", "s", true, false), false); assert.equal(canAdvanceSync("s", "s", true, true), false);
  assert.throws(() => validateSliceState({ accountId: 2, taskId: "t", status: "completed", continuation: false, retry_after_ms: 0 }, 1));
});

test("late SQL mutation is rejected by atomic DNS assertion, not just the pre-read", async t => {
  const { connection, sqlite } = fixture(t); domain(sqlite);
  sqlite.exec("INSERT INTO cache VALUES('api_cache:dns:1','[{\"id\":\"old\"}]',9999999999)");
  let armed = false;
  const wrapped = new Proxy(connection, { get(target, key) {
    if (key === "prepare") return (sql: string) => { if (sql.includes("INSERT INTO sync_commit_assertions")) armed = true; return target.prepare(sql); };
    if (key === "batch") return async (statements: D1PreparedStatement[]) => { if (armed) { armed = false; sqlite.exec("UPDATE domains_cache SET updated_at=updated_at"); } return target.batch(statements); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const db = new DatabaseManager(wrapped); dnsClient(db);
  const result = await finish(db);
  assert.equal(result.status, "blocked"); assert.equal(result.last_completed_at, null);
  assert.equal(sqlite.prepare("SELECT value FROM cache WHERE key='api_cache:dns:1'").get()?.value, '[{"id":"old"}]');
});

test("unknown committed slice is recovered by version; no replay or false completion", async t => {
  const { connection, sqlite } = fixture(t); domain(sqlite); let unknown = false;
  const wrapped = coordinationFault(connection, async (_sql, method, execute) => {
    const result = await execute(); if (method === "batch" && unknown) { unknown = false; throw new Error("unknown committed batch"); } return result;
  });
  const db = new DatabaseManager(wrapped); dnsClient(db);
  const first = await syncStep(db, 1, { manual: true });
  await syncStep(db, 1, { manual: true, taskId: first.taskId });
  unknown = true;
  const published = await syncStep(db, 1, { manual: true, taskId: first.taskId });
  assert.equal(published.phase, "dns"); assert.equal(published.status, "queued"); assert.equal(published.last_completed_at, null);
  const version = sqlite.prepare("SELECT version FROM domain_mutations WHERE domain_id=1").get()?.version;
  assert.equal((await finish(db, first.taskId)).status, "completed");
  assert.equal(Number(sqlite.prepare("SELECT version FROM domain_mutations WHERE domain_id=1").get()?.version), Number(version) + 1, "only DNS publication mutates again, list is not replayed");
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM logs WHERE message LIKE '%域名列表已完整保存%'").get()?.n, 1, "unknown committed response does not duplicate a phase log");
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM logs WHERE type='success' AND category='sync'").get()?.n, 1);
});

test("sync lifecycle logs and DNS progress commit atomically without claiming partial success", async t => {
  const { db, sqlite } = fixture(t); domain(sqlite); dnsClient(db);
  let state = await syncStep(db, 1, { manual: true });
  assert.match(String(sqlite.prepare("SELECT message FROM logs ORDER BY id LIMIT 1").get()?.message), /开始分片完整同步/);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM logs WHERE type='success'").get()?.n, 0);
  for (let i = 0; i < 3; i++) state = await syncStep(db, 1, { manual: true, taskId: state.taskId });
  assert.equal(state.domain_count, 1); assert.equal(state.dns_completed, 1);
  assert.equal((await finish(db, state.taskId)).status, "completed");
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM logs WHERE type='success'").get()?.n, 1);
});

test("sync plan and step retry use database clock despite application clock skew", async t => {
  const { db } = fixture(t); dnsClient(db);
  const first = await syncStep(db, 1, { manual: true });
  const actual = Date.now; t.after(() => { Date.now = actual; }); Date.now = () => actual() - 15 * 60000;
  assert.equal((await syncPlan(db, { manual: true })).plans[0].retry_after_ms, 0);
  assert.equal((await syncStep(db, 1, { manual: true, taskId: first.taskId })).retry_after_ms, 0);
  const task = (await getSyncTask(db.connection, first.taskId))!;
  assert.equal(syncView({ ...task, status: "paused", next_attempt_at: task.db_now! + 60 }).retry_after_ms, 60000);
});

test("credential revision changes during a late list response fence every business write", async t => {
  const { db, sqlite } = fixture(t); domain(sqlite); const client = dnsClient(db);
  client.listSubdomains = async () => { sqlite.exec("UPDATE accounts SET api_secret='changed'"); return { success: true, subdomains: [] }; };
  const result = await finish(db); assert.equal(result.status, "invalidated");
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM domains_cache").get()?.n, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sync_items WHERE kind='seen'").get()?.n, 0);
});

test("duplicate list pages are blocked before publishing or pruning any old row", async t => {
  const { db, sqlite } = fixture(t); domain(sqlite); const client = dnsClient(db);
  const subs = Array.from({ length: 100 }, (_, n) => ({ id: n + 10, full_domain: `d${n}.example.test`, subdomain: `d${n}`, rootdomain: "example.test", status: "active", expires_at: "" }));
  client.listSubdomains = async page => ({ success: true, subdomains: page === 1 ? subs : [subs[0]], pagination: { page, per_page: 100, total: 101, has_more: page === 1 } });
  const result = await finish(db); assert.equal(result.status, "blocked"); assert.equal(result.failure?.error_code, "incomplete_response");
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM domains_cache").get()?.n, 1);
});

test("DNS oversize/false completeness/cursor cycle keeps last-known-good and freshness unknown", async t => {
  for (const mode of ["size", "false", "cycle"]) {
    const { db, sqlite } = fixture(t); domain(sqlite); const client = dnsClient(db);
    sqlite.exec("INSERT INTO cache VALUES('api_cache:dns:1','[{\"id\":\"old\"}]',9999999999)");
    client.listDnsRecordsPage = async (_id, cursor) => ({ success: true, complete: mode === "false" ? false : undefined,
      records: [{ id: String(cursor), type: "TXT", content: mode === "size" ? "x".repeat(128 * 1024) : "x" }],
      pagination: mode === "cycle" ? { has_more: true, next_cursor: cursor === 0 ? "1" : "0" } : { has_more: false } });
    const result = await finish(db); assert.equal(result.status, "blocked"); assert.equal(result.last_completed_at, null);
    assert.equal(sqlite.prepare("SELECT value FROM cache WHERE key='api_cache:dns:1'").get()?.value, '[{"id":"old"}]');
  }
});

test("freshness uses last full success across later queued/cancelled generations", async t => {
  const { db, sqlite } = fixture(t); dnsClient(db);
  assert.equal((await finish(db)).status, "completed");
  const completed = (await syncPlan(db)).plans[0].last_completed_at;
  const next = await syncStep(db, 1, { manual: true });
  assert.equal(next.last_completed_at, completed);
  await cancelSyncTask(db.connection, (await getSyncTask(db.connection, next.taskId))!);
  assert.equal((await syncPlan(db)).plans[0].last_completed_at, completed);
  sqlite.exec("INSERT INTO settings VALUES('cfg_login_sync_enabled','true','')");
  assert.equal((await syncPlan(db)).plans[0].eligible, false);
});

test("GET verification 403 and non-JSON write outcomes never reopen POST intent", async t => {
  const { db, sqlite } = fixture(t); domain(sqlite); const client = dnsClient(db); let posts = 0;
  client.renewSubdomain = async () => { posts++; throw new ProviderApiError("dnshe", 200, "non_json_response", "truncated"); };
  await assert.rejects(renewCachedDomain(db, 1));
  sqlite.exec("UPDATE renewal_intents SET next_attempt_at=0");
  client.getSubdomain = async () => { throw new ProviderApiError("dnshe", 403, "denied", "verification forbidden"); };
  await assert.rejects(renewCachedDomain(db, 1));
  assert.equal(posts, 1); assert.equal(sqlite.prepare("SELECT status FROM renewal_intents").get()?.status, "verify");
});

test("renewal fence is rechecked after scheduler wait, before real dispatch", async t => {
  const { db, sqlite } = fixture(t); domain(sqlite);
  const client = new DNSHEClient("offline", "offline", undefined, { scheduler: {
    scope: "dnshe_key", acquire: async () => { sqlite.exec("UPDATE accounts SET api_secret='changed'"); return { assertReady: () => {}, release: async () => {} }; }, block: async () => {},
  } });
  db.getClientForAccount = async () => ({ client, alias: "offline", provider: "dnshe" });
  await assert.rejects(renewCachedDomain(db, 1), /发送前版本/);
  assert.equal(sqlite.prepare("SELECT expires_at FROM domains_cache").get()?.expires_at, "2026-11-02");
  assert.equal(sqlite.prepare("SELECT status FROM renewal_intents").get()?.status, "rejected");
});

test("batch binding preserves committed success when strict invocation budget runs out", async t => {
  const { connection, sqlite } = fixture(t);
  const budget = new InvocationBudget({ d1: 12 });
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ user: { id: "owner-budget", username: "offline" } });
  const { runHttpInvocation } = await import("../../src/index");
  const res = await runHttpInvocation(new Request("https://fixture.invalid/api/accounts/batch", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer offline" },
    body: JSON.stringify({ provider: "vercel", accounts: [{ api_token: "key1" }, { api_token: "key2" }] }) }), { DB: connection, ADMIN_TOKEN: "offline" }, {} as ExecutionContext, budget);
  assert.equal(res.status, 200);
  const body = await res.json() as { success_count: number; account_ids: number[]; results: { success: boolean }[] };
  assert.equal(body.success_count, 1); assert.equal(body.account_ids.length, 1); assert.equal(body.results[0].success, true); assert.equal(body.results[1].success, false);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM accounts").get()?.n, 2);
  assert.ok(budget.snapshot().used.d1 <= 12);
});

test("missing seen snapshot and cross-account ID collision cannot report full success", async t => {
  for (const mode of ["missing", "collision"]) {
    const { db, sqlite } = fixture(t); domain(sqlite); dnsClient(db);
    const first = await syncStep(db, 1, { manual: true });
    await syncStep(db, 1, { manual: true, taskId: first.taskId });
    if (mode === "missing") sqlite.exec("DELETE FROM sync_items WHERE kind='seen'");
    else sqlite.exec("INSERT INTO accounts(id,alias,api_key,api_secret) VALUES(2,'other','other','other'); UPDATE domains_cache SET account_id=2");
    const result = await finish(db, first.taskId);
    assert.equal(result.status, "blocked"); assert.equal(result.last_completed_at, null);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM domains_cache").get()?.n, 1);
  }
});

test("missing DNS fragment cannot publish a truncated complete snapshot", async t => {
  const { db, sqlite } = fixture(t); domain(sqlite); const client = dnsClient(db);
  sqlite.exec("INSERT INTO cache VALUES('api_cache:dns:1','[{\"id\":\"old\"}]',9999999999)");
  client.listDnsRecordsPage = async (_id, cursor) => ({ success: true, records: [{ id: String(cursor), type: "A", content: "192.0.2.1" }], pagination: cursor === 0 ? { has_more: true, next_cursor: "next" } : { has_more: false } });
  let state = await syncStep(db, 1, { manual: true });
  for (let n = 0; n < 3; n++) state = await syncStep(db, 1, { manual: true, taskId: state.taskId });
  sqlite.exec("DELETE FROM sync_fragments WHERE kind='dns'");
  const result = await finish(db, state.taskId);
  assert.equal(result.status, "blocked"); assert.equal(result.last_completed_at, null);
  assert.equal(sqlite.prepare("SELECT value FROM cache WHERE key='api_cache:dns:1'").get()?.value, '[{"id":"old"}]');
});

test("Cloudflare page metadata recognizes exact/empty terminal pages and rejects total drift", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const zones = Array.from({ length: 50 }, (_, n) => ({ id: n.toString(16).padStart(32, "0"), name: `z${n}.example.test`, status: "active", name_servers: [] }));
  let total = 50, empty = false;
  globalThis.fetch = async () => Response.json({ success: true, result: empty ? [] : zones, result_info: { page: 1, per_page: 50, count: empty ? 0 : 50, total_count: total, total_pages: 1 } });
  const client = new CloudflareClient("offline");
  assert.equal((await client.listZones({ maxPages: 1 })).hasMore, false);
  await assert.rejects(client.listZones({ maxPages: 1, expectedTotal: 51 }), /完整/);
  empty = true; total = 0;
  assert.deepEqual((await client.listZones({ maxPages: 1 })).zones, []);
});

test("Cron budget exit counts all unattempted candidates and warns about cached backlog", async t => {
  const { connection, sqlite } = fixture(t);
  for (let id = 1; id <= 4; id++) domain(sqlite, id);
  sqlite.exec("UPDATE domains_cache SET expires_at=date('now','+1 day'); INSERT INTO settings VALUES('cfg_dnshe_renew_window_days','3','')");
  const budget = new InvocationBudget({ d1: 20 });
  const result = await runReminderRenewal(new DatabaseManager(withBudgetD1(connection, budget)));
  assert.equal(result.deferred, 4); assert.equal(result.renewed, 0); assert.equal(budget.snapshot().used.external, 0);
  assert.match(String(sqlite.prepare("SELECT message FROM logs ORDER BY id DESC LIMIT 1").get()?.message), /窗口内缓存域名 4.*不保证到期前处理完/);
  assert.equal(budget.snapshot().reserved.d1, 0);
});

test("log HTTP cursor is bounded/authenticated/local-only and empty deltas preserve the cursor", async t => {
  const { connection, sqlite } = fixture(t);
  for (let id = 1; id <= 250; id++) sqlite.prepare("INSERT INTO logs(type,category,message) VALUES('info','operation',?)").run(`offline-${id}`);
  const { runHttpInvocation } = await import("../../src/index");
  const request = async (query: string, token = "offline") => {
    const budget = new InvocationBudget();
    const response = await runHttpInvocation(new Request(`https://fixture.invalid/api/logs${query}`, { headers: { Authorization: `Bearer ${token}` } }), { DB: connection, ADMIN_TOKEN: "offline" }, {} as ExecutionContext, budget);
    assert.equal(budget.snapshot().used.external, 0); assert.ok(budget.snapshot().used.d1 <= 40);
    return { response, body: await response.json() as { logs: {id: number}[]; nextCursor: number } };
  };
  const initial = await request(""); assert.equal(initial.response.status, 200); assert.equal(initial.body.logs.length, 100); assert.equal(initial.body.nextCursor, 250);
  const empty = await request("?after_id=250"); assert.deepEqual(empty.body.logs, []); assert.equal(empty.body.nextCursor, 250);
  sqlite.prepare("INSERT INTO logs(type,category,message) VALUES('info','sync','new-offline')").run();
  const delta = await request("?after_id=250"); assert.deepEqual(delta.body.logs.map(row => row.id), [251]);
  for (const query of ["?after_id=-1", "?after_id=1.5", "?after_id=NaN", "?after_id=9007199254740992"]) assert.equal((await request(query)).response.status, 400);
  assert.equal((await request("?after_id=0", "invalid")).response.status, 401);
});

test("Action endpoints expose real sliced running state and DNS counters", async t => {
  const { db, connection, sqlite } = fixture(t); dnsClient(db);
  const state = await syncStep(db, 1, { manual: true });
  sqlite.prepare("UPDATE sync_tasks SET status='running',owner='offline-owner',lease_until=CAST(strftime('%s','now') AS INTEGER)+120 WHERE id=?").run(state.taskId);
  const { runHttpInvocation } = await import("../../src/index");
  for (const path of ["/api/actions", `/api/actions/${state.taskId}`]) {
    const response = await runHttpInvocation(new Request(`https://fixture.invalid${path}`, { headers: { Authorization: "Bearer offline" } }), { DB: connection, ADMIN_TOKEN: "offline" }, {} as ExecutionContext);
    const body = await response.json() as { actions?: { status: string; sync_status: string; phase: string }[]; action?: {status: string; sync_status: string; phase: string} };
    const action = body.action ?? body.actions![0]; assert.equal(action.status, "running"); assert.equal(action.sync_status, "running"); assert.equal(action.phase, "list");
    assert.equal((action as {executing?: boolean}).executing, true);
  }
  sqlite.prepare("UPDATE sync_tasks SET lease_until=CAST(strftime('%s','now') AS INTEGER)-1 WHERE id=?").run(state.taskId);
  const task = await getSyncTask(connection, state.taskId!);
  assert.equal(syncView(task!).executing, false);
});
