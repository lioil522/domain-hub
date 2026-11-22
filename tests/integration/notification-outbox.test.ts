import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DatabaseManager } from "../../src/db";
import { NotificationOutbox, NOTIFICATION_LEASE_MS, NOTIFICATION_MAX_ATTEMPTS, type NotificationTarget } from "../../src/db/dao/notification-dao";
import { testDatabase, TEST_AES_KEY, failDatabaseOperation } from "../helpers/database";
import { runOneNotificationDelivery } from "../../src/services/notification-service";
import { runExpiryReminderSlice, EXPIRY_SCAN_BATCH } from "../../src/cron/jobs/expiry-check";
import { runOneSyncSlice } from "../../src/services/sync-work-runner";
import { SyncWorkQueue } from "../../src/db/dao/sync-work-dao";
import { runDailySyncAndRenewal } from "../../src/cron/jobs/daily-sync";
import { DNSHEClient } from "../../src/dnshe";
import worker from "../../src/index";
import { ensureDatabaseSchema, verifyDatabaseSchema } from "../../src/db/schema-migrations";
import { MIGRATION_NAMES, MIGRATION_TABLE, SCHEMA_TABLES, SCHEMA_INDEXES } from "../../src/db/schema-definition";
import { RDAP_CACHE_PREFIX } from "../../src/db/types";
import { runBackgroundMaintenance } from "../../src/services/background-maintenance";

const webhook: NotificationTarget = { channel: "webhook", url: "https://example.test/private-hook-key", type: "custom" };
const telegram: NotificationTarget = { channel: "telegram", token: "secret-bot-token", chatId: "private-chat" };
const event = { key: "event-one", message: "private notification body" };
async function fixture(t: TestContext) {
  const data = await testDatabase(t);
  let now = Date.now();
  const outbox = new NotificationOutbox(data.d1, TEST_AES_KEY, () => now);
  return { ...data, outbox, now: () => now, advance: (ms: number) => { now += ms; } };
}
test("concurrent enqueue deduplicates per event and per channel without plaintext snapshots", async t => {
  const { outbox, manager } = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, () => outbox.enqueue([event], [webhook, telegram])));
  const rows = await manager.allRaw<{ payload_cipher: string }>("SELECT payload_cipher FROM notification_outbox");
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => !JSON.stringify(row).includes(webhook.url) && !row.payload_cipher.includes(event.message)));
  const publicRows = JSON.stringify(await outbox.list());
  assert.ok(!publicRows.includes("secret-bot-token") && !publicRows.includes("payload_cipher"));
});
test("new encrypted snapshots require AES_KEY; failed atomic enqueue rolls back business writes", async t => {
  const { outbox, d1, manager } = await fixture(t);
  await assert.rejects(() => new NotificationOutbox(d1).enqueue([event], [webhook]), /AES_KEY/);
  await assert.rejects(() => outbox.enqueue([event], [webhook], [
    outbox.statement("INSERT INTO settings(key,value) VALUES('atomic-probe','keep')"),
    outbox.statement("SELECT * FROM missing_notification_table"),
  ]), /missing_notification_table/);
  assert.equal(await manager.getSetting("atomic-probe"), null);
  assert.equal((await outbox.list()).length, 0);
});
test("20 concurrent claimers obtain a delivery exactly once", async t => {
  const { outbox } = await fixture(t);
  await outbox.enqueue([event], [webhook]);
  assert.equal((await Promise.all(Array.from({ length: 20 }, () => outbox.claim()))).filter(Boolean).length, 1);
});
test("expired sender cannot overwrite a recovered lease or falsely mark sent", async t => {
  const { outbox, advance, manager } = await fixture(t);
  await outbox.enqueue([event], [webhook]);
  const old = (await outbox.claim())!;
  advance(NOTIFICATION_LEASE_MS + 1); await outbox.recover(); advance(60001);
  const replacement = (await outbox.claim())!;
  assert.notEqual(replacement.lease_token, old.lease_token);
  assert.equal(await outbox.finish(old, { ok: true }), false);
  assert.equal((await manager.firstRaw<{ lease_token: string }>("SELECT lease_token FROM notification_outbox"))?.lease_token, replacement.lease_token);
  assert.equal((await outbox.list())[0].uncertain, 1);
});
test("retry respects backoff and reaches dead letter after a bounded attempt count", async t => {
  const { outbox, advance } = await fixture(t);
  await outbox.enqueue([event], [webhook]);
  for (let attempt = 1; attempt <= NOTIFICATION_MAX_ATTEMPTS; attempt++) {
    const work = (await outbox.claim())!;
    assert.equal(work.attempts, attempt);
    await outbox.finish(work, { ok: false, retryable: true, code: "http_503", uncertain: true });
    assert.equal(await outbox.claim(), null);
    advance(3600000);
  }
  assert.equal((await outbox.list())[0].status, "dead");
});
test("deadline exhaustion is terminal without starting another request", async t => {
  const { outbox, advance } = await fixture(t);
  await outbox.enqueue([{ ...event, deadlineAt: Date.now() + 1000 }], [webhook]);
  advance(2000); await outbox.recover();
  assert.equal(await outbox.claim(), null);
  assert.equal((await outbox.list())[0].status, "dead");
});
test("channels fail independently and confirmed success is not retried", async t => {
  const { outbox, manager } = await fixture(t);
  t.mock.method(globalThis, "fetch", async (url: string) => String(url).includes("telegram")
    ? Response.json({ ok: false, error_code: 403 }, { status: 403 }) : new Response("OK"));
  await outbox.enqueue([event], [webhook, telegram]);
  await runOneNotificationDelivery(manager, { outbox }); await runOneNotificationDelivery(manager, { outbox });
  const rows = await outbox.list();
  assert.equal(rows.find(row => row.channel === "webhook")?.status, "sent");
  assert.equal(rows.find(row => row.channel === "telegram")?.status, "dead");
  assert.equal(await runOneNotificationDelivery(manager, { outbox }), null);
});
test("body/transport failure remains pending rather than becoming sent", async t => {
  const { outbox, manager } = await fixture(t);
  t.mock.method(globalThis, "fetch", async () => new Response("proxy OK"));
  await outbox.enqueue([event], [telegram]);
  await runOneNotificationDelivery(manager, { outbox });
  const row = (await outbox.list())[0];
  assert.equal(row.status, "queued");
  assert.equal(row.uncertain, 1);
  assert.equal(row.sent_at, null);
});
test("wrong encryption key fails closed and can be explicitly redriven after restoring it", async t => {
  const { outbox, d1, manager } = await fixture(t);
  let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("OK"); });
  await outbox.enqueue([event], [webhook]);
  const wrong = new NotificationOutbox(d1, "wrong-key");
  await runOneNotificationDelivery(manager, { outbox: wrong });
  assert.equal(calls, 0);
  const row = (await outbox.list())[0];
  assert.equal(row.status, "dead");
  await outbox.control(String(row.id), "retry");
  await runOneNotificationDelivery(manager, { outbox });
  assert.equal(calls, 1);
});
test("ambiguous dead letters need explicit duplicate-risk acknowledgement; sent messages cannot be redriven", async t => {
  const { outbox, advance } = await fixture(t);
  await outbox.enqueue([event], [webhook]);
  const work = (await outbox.claim())!;
  await outbox.finish(work, { ok: false, uncertain: true, retryable: false });
  await assert.rejects(() => outbox.control(work.id, "retry"), /重复/);
  await outbox.control(work.id, "retry", true);
  advance(1);
  await outbox.finish((await outbox.claim())!, { ok: true });
  await assert.rejects(() => outbox.control(work.id, "retry", true), /仅死信|重复/);
});
test("cancellation fences an in-flight sender but does not pretend to recall the network request", async t => {
  const { outbox, manager } = await fixture(t);
  let release!: (value: Response) => void, started!: () => void;
  const begin = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, "fetch", async () => { started(); return new Promise<Response>(resolve => { release = resolve; }); });
  await outbox.enqueue([event], [webhook]);
  const running = runOneNotificationDelivery(manager, { outbox });
  await begin;
  const row = (await outbox.list())[0];
  await outbox.control(String(row.id), "cancel");
  release(new Response("OK")); await running;
  assert.equal((await outbox.list())[0].status, "cancelled");
  assert.equal((await outbox.list())[0].uncertain, 1);
});
test("oversized unicode messages split into stable byte-bounded parts", async t => {
  const { outbox } = await fixture(t);
  await outbox.enqueue([{ ...event, message: "🧪汉".repeat(1000) }], [webhook]);
  let parts = 0, reconstructed = "";
  while (true) {
    const work = await outbox.claim(); if (!work) break;
    const { message } = await outbox.decode(work);
    assert.ok(new TextEncoder().encode(message).byteLength <= 1600);
    reconstructed += message.replace(/^\(\d+\/\d+\)\n/, "");
    parts++; await outbox.finish(work, { ok: true });
  }
  assert.ok(parts > 1);
  // Claim order is ID-based, not part order; every original code point is intact.
  assert.equal([...reconstructed].filter(character => character === "🧪").length, 1000);
});
async function expiryData(t: TestContext, count = 1) {
  const data = await fixture(t);
  await data.manager.setAppSetting("webhook_url", webhook.url);
  for (const [id, provider] of [[1, "cloudflare"], [2, "digitalplat"], [3, "custom"]] as const) {
    await data.manager.executeRaw("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(?,?,?,'legacy',?)", [id, provider, `key-${id}`, provider]);
  }
  const expiry = new Date(data.now() + 86400000).toISOString();
  for (let index = 1; index <= count; index++) {
    for (const accountId of [1, 2]) await data.manager.upsertDomain(accountId, { id: accountId * 100000 + index, subdomain: "", rootdomain: "",
      full_domain: `d${index}.com`, status: "active", expires_at: expiry });
    await data.manager.executeRaw("INSERT INTO custom_domains(group_id,full_domain,expires_at) VALUES(3,?,?)", [`c${index}.example.com`, expiry]);
    await data.manager.setCache(`${RDAP_CACHE_PREFIX}d${index}.com`, JSON.stringify({ found: true, expires_at: expiry }));
  }
  return data;
}
test("daily scanner rotates through every provider beyond the old head-only budget", async t => {
  const data = await expiryData(t, EXPIRY_SCAN_BATCH + 3);
  let scanned = 0;
  for (let index = 0; index < 10; index++) scanned += await runExpiryReminderSlice(data.manager, { outbox: data.outbox, now: data.now });
  assert.equal(scanned, (EXPIRY_SCAN_BATCH + 3) * 3);
  assert.equal((await data.manager.firstRaw<{ n: number }>("SELECT COUNT(*) n FROM notification_outbox"))?.n, scanned);
  assert.equal(await data.manager.getCache("expiry_reminder_sent"), null);
});
test("concurrent daily collectors commit one cursor and one set of events", async t => {
  const data = await expiryData(t);
  const results = await Promise.all(Array.from({ length: 10 }, () => runExpiryReminderSlice(data.manager, { outbox: data.outbox, now: data.now })));
  assert.equal(results.filter(value => value > 0).length, 1);
  assert.equal((await data.outbox.list()).length, 3);
});
test("scan checkpoint failure leaves no outbox rows and the same page is safely retried", async t => {
  const data = await expiryData(t);
  const failing = new Proxy(data.d1, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => target.prepare(sql.startsWith("UPDATE notification_scans SET last_kind") ? "SELECT * FROM injected_scan_failure" : sql);
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await assert.rejects(() => runExpiryReminderSlice(data.manager, { outbox: new NotificationOutbox(failing, TEST_AES_KEY, data.now), now: data.now }), /injected_scan_failure/);
  assert.equal((await data.outbox.list()).length, 0);
  assert.equal((await data.manager.firstRaw<{ last_id: number }>("SELECT last_id FROM notification_scans"))?.last_id, 0);
  assert.equal(await runExpiryReminderSlice(data.manager, { outbox: data.outbox, now: data.now }), 3);
});
test("config read/decryption failure cannot mark the day complete or overwrite settings", async t => {
  const data = await expiryData(t);
  const failing = new DatabaseManager(failDatabaseOperation(data.d1, sql => sql.includes("WHERE key LIKE 'cfg_%'"), "all"), TEST_AES_KEY);
  await assert.rejects(() => runExpiryReminderSlice(failing), /Injected/);
  await assert.rejects(() => runExpiryReminderSlice(new DatabaseManager(data.d1, "wrong-key")));
  assert.equal(await data.manager.firstRaw("SELECT * FROM notification_scans"), null);
});
test("new UTC day and a changed destination rescan without re-sending to already-enqueued targets", async t => {
  const data = await expiryData(t);
  await runExpiryReminderSlice(data.manager, { outbox: data.outbox, now: data.now });
  await data.manager.setAppSetting("tg_token", telegram.token); await data.manager.setAppSetting("tg_chat_id", telegram.chatId);
  await runExpiryReminderSlice(data.manager, { outbox: data.outbox, now: data.now });
  assert.equal((await data.outbox.list()).length, 6);
  data.advance(86400000);
  await runExpiryReminderSlice(data.manager, { outbox: data.outbox, now: data.now });
  assert.equal((await data.outbox.list()).length, 12);
});
test("notification operations are authenticated and expose only safe delivery metadata", async t => {
  const { manager, outbox, d1 } = await fixture(t);
  await outbox.enqueue([event], [webhook, telegram]);
  const env = { DB: d1, AES_KEY: TEST_AES_KEY }, ctx = { waitUntil() {}, props: {} } as unknown as ExecutionContext;
  assert.equal((await worker.fetch(new Request("http://localhost/api/notifications"), env, ctx)).status, 401);
  const token = await manager.createSession(), headers = { Authorization: `Bearer ${token}` };
  const response = await worker.fetch(new Request("http://localhost/api/notifications?limit=10", { headers }), env, ctx);
  assert.equal(response.status, 200);
  const text = await response.text();
  for (const secret of [webhook.url, telegram.token, telegram.chatId, "payload_cipher", event.message]) assert.ok(!text.includes(secret));
  assert.equal((await worker.fetch(new Request("http://localhost/api/notifications?limit=999", { headers }), env, ctx)).status, 400);
});
test("v4 upgrades append notification tables/indexes and later migrations while preserving old data/history", async t => {
  const { sqlite, d1 } = await testDatabase(t);
  sqlite.exec("DROP TABLE notification_scans; DROP TABLE notification_outbox; DROP INDEX idx_custom_domains_unassigned_unique");
  sqlite.exec(`DELETE FROM ${MIGRATION_TABLE} WHERE version>=5; INSERT INTO settings(key,value) VALUES('preserve','original')`);
  const before = sqlite.prepare(`SELECT * FROM ${MIGRATION_TABLE}`).all();
  await ensureDatabaseSchema(d1); await verifyDatabaseSchema(d1);
  assert.deepEqual(sqlite.prepare(`SELECT * FROM ${MIGRATION_TABLE} WHERE version<5`).all(), before);
  assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key='preserve'").get()?.value, "original");
  assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM ${MIGRATION_TABLE}`).get()?.n, MIGRATION_NAMES.length);
});
test("failed v5 migration rolls back tables and cannot stamp the version", async t => {
  const { sqlite, d1 } = await testDatabase(t);
  sqlite.exec("DROP TABLE notification_scans; DROP TABLE notification_outbox; DROP INDEX idx_custom_domains_unassigned_unique");
  sqlite.exec(`DELETE FROM ${MIGRATION_TABLE} WHERE version>=5`);
  const failing = new Proxy(d1, { get(target, property) {
    if (property === "prepare") return (sql: string) => target.prepare(sql.includes("CREATE INDEX IF NOT EXISTS idx_notification_due") ? "SELECT * FROM broken_migration" : sql);
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(() => ensureDatabaseSchema(failing), /broken_migration/);
  assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='notification_outbox'").get(), undefined);
  assert.equal(sqlite.prepare(`SELECT MAX(version) version FROM ${MIGRATION_TABLE}`).get()?.version, 4);
  await ensureDatabaseSchema(d1);
  assert.equal(SCHEMA_TABLES.filter(table => table.name.startsWith("notification_")).length, 2);
  assert.equal(SCHEMA_INDEXES.filter(index => index.name.startsWith("idx_notification_")).length, 2);
});
test("cancellation during snapshot decoding prevents a new network attempt", async t => {
  const { outbox, manager } = await fixture(t);
  let decoding!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { decoding = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
  const decode = outbox.decode.bind(outbox);
  outbox.decode = async work => { decoding(); await hold; return decode(work); };
  let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("OK"); });
  await outbox.enqueue([event], [webhook]);
  const sending = runOneNotificationDelivery(manager, { outbox }); await started;
  await outbox.control(String((await outbox.list())[0].id), "cancel");
  release(); await sending;
  assert.equal(calls, 0);
});
test("terminal delivery tombstones are retained for dedupe and pruned only after retention", async t => {
  const { outbox, advance } = await fixture(t);
  await outbox.enqueue([event], [webhook]);
  await outbox.finish((await outbox.claim())!, { ok: true });
  await outbox.enqueue([event], [webhook]);
  assert.equal((await outbox.list()).length, 1);
  advance(31 * 86400000); await outbox.recover();
  assert.equal((await outbox.list()).length, 0);
});
async function renewingData(t: TestContext) {
  const data = await fixture(t);
  await data.manager.setAppSetting("webhook_url", webhook.url);
  await data.manager.executeRaw("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'DNSHE','fake-key','legacy','dnshe')");
  const expiry = new Date(Date.now() + 86400000).toISOString(), nextExpiry = new Date(Date.now() + 365 * 86400000).toISOString();
  const domain = { id: 1, subdomain: "test", rootdomain: "us.ci", full_domain: "test.us.ci", expires_at: expiry, status: "active" };
  const client = new DNSHEClient("fake", "fake");
  client.listSubdomains = async () => ({ success: true, subdomains: [domain], total: 1 });
  client.listDnsRecords = async () => ({ success: true, records: [] });
  client.getSubdomain = async () => ({ success: true, subdomain: { ...domain, expires_at: nextExpiry } });
  let posts = 0;
  client.renewSubdomain = async () => { posts++; return { success: true, new_expires_at: nextExpiry }; };
  data.manager.getClientForAccount = async () => ({ client, alias: "DNSHE", provider: "dnshe" });
  t.mock.method(globalThis, "fetch", async () => assert.fail("A business producer must not directly send notifications"));
  return { ...data, client, domain, expiry, nextExpiry, posts: () => posts };
}
test("daily renewal success commits its cache/journal and outbox together, including read-only reconciliation", async t => {
  const data = await renewingData(t);
  await runDailySyncAndRenewal(data.manager);
  assert.equal((await data.manager.getDomainById(1))?.expires_at, data.nextExpiry);
  assert.equal((await data.manager.firstRaw<{ status: string }>("SELECT status FROM sync_renew_journal"))?.status, "confirmed");
  assert.equal((await data.outbox.list()).length, 1);
  await runDailySyncAndRenewal(data.manager);
  assert.equal(data.posts(), 1);
  assert.equal((await data.outbox.list()).length, 1);
});
test("notification commit outage after an upstream renewal preserves attempting state for GET-only recovery", async t => {
  const data = await renewingData(t);
  const broken = new Proxy(data.d1, { get(target, property) {
    if (property === "prepare") return (sql: string) => target.prepare(sql.includes("INSERT INTO notification_outbox") ? "SELECT * FROM outbox_commit_outage" : sql);
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  const manager = new DatabaseManager(broken, TEST_AES_KEY);
  manager.getClientForAccount = data.manager.getClientForAccount;
  await runDailySyncAndRenewal(manager);
  assert.equal(data.posts(), 1);
  assert.equal((await data.manager.firstRaw<{ status: string }>("SELECT status FROM sync_renew_journal"))?.status, "attempting");
  assert.equal((await data.outbox.list()).length, 0);
  await runDailySyncAndRenewal(data.manager);
  assert.equal(data.posts(), 1);
  assert.equal((await data.outbox.list()).length, 1);
});
test("durable sync notify phase atomically enqueues before advancing its checkpoint", async t => {
  const data = await renewingData(t);
  const queue = data.manager.syncQueue(), action = await queue.enqueue({ label: "notify", accountIds: [1], renew: true });
  const work = (await queue.jobs(action))[0];
  await data.manager.executeRaw("UPDATE sync_work SET cursor=? WHERE id=?", [JSON.stringify({ phase: "notify", total: 1 }), work.id]);
  await data.manager.executeRaw("INSERT INTO sync_rows(job_id,domain_id,payload,renew_state) VALUES(?,1,?,'done')", [work.id, JSON.stringify(data.domain)]);
  await runOneSyncSlice(data.manager, { queue });
  assert.equal(JSON.parse((await queue.jobs(action))[0].cursor).phase, "done");
  assert.equal((await data.outbox.list()).length, 1);
});
test("a cancelled sync notify phase cannot enqueue even after config decryption completes", async t => {
  const data = await renewingData(t);
  const queue = data.manager.syncQueue(), action = await queue.enqueue({ label: "cancel-notify", accountIds: [1], renew: true });
  const work = (await queue.jobs(action))[0], config = await data.manager.getAllAppSettings();
  await data.manager.executeRaw("UPDATE sync_work SET cursor=? WHERE id=?", [JSON.stringify({ phase: "notify", total: 1 }), work.id]);
  await data.manager.executeRaw("INSERT INTO sync_rows(job_id,domain_id,payload,renew_state) VALUES(?,1,?,'done')", [work.id, JSON.stringify(data.domain)]);
  let release!: (config: Record<string, string>) => void, started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  data.manager.getAllAppSettings = async () => { started(); return new Promise(resolve => { release = resolve; }); };
  const running = runOneSyncSlice(data.manager, { queue }); await start;
  await queue.control(action, "cancel"); release(config); await running;
  assert.equal((await data.outbox.list()).length, 0);
  assert.equal((await queue.jobs(action))[0].status, "cancelled");
});
test("minute Worker maintenance resumes a persisted outbox independently of business sync", async t => {
  const data = await fixture(t);
  await data.outbox.enqueue([event], [webhook]);
  t.mock.method(globalThis, "fetch", async () => new Response("OK"));
  const pending: Promise<unknown>[] = [];
  await worker.scheduled({ cron: "* * * * *" } as ScheduledEvent, { DB: data.d1, AES_KEY: TEST_AES_KEY },
    { waitUntil(job: Promise<unknown>) { pending.push(job); }, props: {} } as unknown as ExecutionContext);
  await Promise.all(pending);
  assert.equal((await data.outbox.list())[0].status, "sent");
});
test("shared maintenance keeps an expiry slice and one delivery within the bounded SQL budget", async t => {
  const data = await expiryData(t, EXPIRY_SCAN_BATCH + 2);
  await data.manager.setAppSetting("tg_token", telegram.token); await data.manager.setAppSetting("tg_chat_id", telegram.chatId);
  await data.outbox.enqueue([event], [webhook]);
  await data.manager.executeRaw("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(4,'budget','budget-key','legacy','dnshe')");
  const queue = new SyncWorkQueue(data.d1), action = await queue.enqueue({ label: "busy-dns", accountIds: [4] });
  const work = (await queue.claim())!;
  await queue.stage(work, [1, 2, 3, 4].map(id => ({ id: 500000 + id, subdomain: `b${id}`, rootdomain: "us.ci",
    full_domain: `b${id}.us.ci`, status: "active", expires_at: "2035-01-01" })), { phase: "dns", total: 4 }, false);
  await queue.finish(work, "queued", null, 0);
  let upstream = 0;
  t.mock.method(globalThis, "fetch", async () => { upstream++; return new Response("OK"); });
  let queries = 0;
  const observed = new Proxy(data.d1, { get(target, property) {
    if (property === "prepare") return (sql: string) => { queries++; return target.prepare(sql); };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  const manager = new DatabaseManager(observed, TEST_AES_KEY), client = new DNSHEClient("fake", "fake");
  client.listDnsRecords = async () => { upstream++; return { success: true, records: [] }; };
  manager.getClientForAccount = async () => ({ client, alias: "budget", provider: "dnshe" });
  await runBackgroundMaintenance(manager);
  assert.equal(upstream, 5);
  assert.ok(queries + upstream + 1 <= 50, `Maintenance needs ${queries} SQL + ${upstream} upstream + one schema read`);
  assert.equal(JSON.parse((await queue.jobs(action))[0].cursor).checked, 4);
});
