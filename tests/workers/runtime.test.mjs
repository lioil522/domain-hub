import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const { outputFiles } = await build({ entryPoints: ["tests/workers/runtime-fixture.ts"], bundle: true,
  platform: "neutral", target: "es2022", format: "esm", write: false });
const compatibilityDate = readFileSync("wrangler.toml", "utf8").match(/^compatibility_date\s*=\s*"([\d-]+)"/m)?.[1];
assert.ok(compatibilityDate, "runtime tests must use the actual production compatibility date");

const { outputFiles: [syncFixtures] } = await build({ stdin: {
  contents: 'export { dnsheSyncResponse } from "./tests/helpers/dnshe-sync-fixture";',
  resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", target: "node22", format: "esm", write: false });
const { dnsheSyncResponse } = await import(`data:text/javascript;base64,${Buffer.from(syncFixtures.text).toString("base64")}`);

async function fixture(t, outboundService = () => { throw new Error("external requests are forbidden in runtime tests"); }) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: outputFiles[0].text,
    compatibilityDate, cf: false, host: "127.0.0.1", port: 0,
    d1Databases: ["DB"], bindings: { AES_KEY: "offline-test-key", ADMIN_TOKEN: "offline-admin" },
    // Any accidental outbound provider call fails locally instead of accessing real services.
    outboundService,
  }));
  t.after(() => mf.dispose());
  await mf.dispatchFetch("http://localhost/api/auth/status");
  const d1 = await mf.getD1Database("DB");
  return { mf, d1, request: path => mf.dispatchFetch(`http://localhost${path}`) };
}

test("workerd/D1: concurrent public setup has one winner and real PBKDF2 credentials", async t => {
  const { mf, request } = await fixture(t);
  const setup = name => mf.dispatchFetch("http://localhost/api/auth/setup", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: `admin-${name}`, password: `password-${name}` }) });
  const responses = await Promise.all([setup("one"), setup("two")]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 403]);
  const winner = responses[0].status === 200 ? "one" : "two";
  const credentials = await (await request("/fixture/password")).json();
  assert.equal(credentials.username, `admin-${winner}`);
  assert.equal(credentials[winner], true);
  assert.equal(credentials[winner === "one" ? "two" : "one"], false);
});

test("workerd/D1: failed initialization transaction rolls back claim and password", async t => {
  const { mf, d1, request } = await fixture(t);
  await d1.exec("CREATE TRIGGER fail_salt BEFORE INSERT ON settings WHEN NEW.key = 'auth_pass_salt' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  const response = await mf.dispatchFetch("http://localhost/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin-one", password: "password-one" }) });
  assert.equal(response.status, 503);
  assert.equal((await (await request("/api/auth/status")).json()).initialized, false);
  assert.equal(await d1.prepare("SELECT key FROM settings WHERE key = 'auth_initialized'").first(), null);
});

test("workerd/D1: cross-run 151-zone snapshot preserves early pages and new local rows", async t => {
  const { d1, request } = await fixture(t);
  await d1.exec("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'fixture','fixture-key','fixture-secret','cloudflare')");
  const insert = id => d1.prepare("INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at,updated_at) VALUES(?,1,'','example',?,'未解析','','original')").bind(id, `local${id}.example`).run();
  await insert(999);
  const first = await (await request("/fixture/sync")).json();
  assert.equal(first.completed, false);
  assert.equal(first.nextPage, 4);
  await insert(777);
  const second = await (await request("/fixture/sync")).json();
  assert.equal(second.completed, true);
  const rows = (await d1.prepare("SELECT full_domain FROM domains_cache").all()).results;
  assert.equal(rows.length, 152);
  assert.equal(rows.some(r => r.full_domain === "zone1.example"), true);
  assert.equal(rows.some(r => r.full_domain === "local777.example"), true);
  assert.equal(rows.some(r => r.full_domain === "local999.example"), false);
});

test("workerd/D1: failed cursor commit rolls back page, expired lease cannot resurrect", async t => {
  const { d1, request } = await fixture(t);
  await d1.exec("CREATE TRIGGER fail_cursor BEFORE INSERT ON cache WHEN NEW.key = 'fixture-cursor' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  assert.equal((await request("/fixture/commit")).status, 503);
  assert.equal(await d1.prepare("SELECT id FROM domains_cache").first(), null);
  await d1.exec("DROP TRIGGER fail_cursor");
  assert.equal((await request("/fixture/expired-lease")).status, 409);
  assert.equal(await d1.prepare("SELECT id FROM domains_cache").first(), null);
  assert.equal(await d1.prepare("SELECT value FROM cache WHERE key = 'fixture-cursor'").first(), null);
});

test("workerd/D1: per-key RETURNING budget and cross-client cooldown semantics", async t => {
  const { request } = await fixture(t);
  assert.deepEqual(await (await request("/fixture/budget")).json(), { waits: [2100], capped: true, cooldown: true });
});

test("workerd/D1: 40 credential lanes in separate invocations do not share a fixed provider semaphore", async t => {
  const { d1, request } = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 40 }, (_, i) => request(`/fixture/dnshe-lane?key=runtime-${i}`)));
  assert.ok(responses.every(response => response.status === 200));
  const rows = (await d1.prepare("SELECT value FROM cache WHERE key LIKE 'dnshe_queue:%'").all()).results;
  assert.equal(rows.length, 40);
  assert.ok(rows.every(row => JSON.parse(row.value).events.length === 1));
  assert.equal((await d1.prepare("SELECT count(*) AS n FROM cache WHERE key LIKE 'provider_scheduler:%'").first()).n, 0);
});

test("workerd/D1: credential rolling window crosses minute boundaries without resetting or exceeding 30", async t => {
  const { request } = await fixture(t);
  const { starts } = await (await request("/fixture/dnshe-window")).json();
  assert.equal(starts.length, 31);
  assert.ok(starts[30] > starts[0] + 60_000);
  for (const at of starts) assert.ok(starts.filter(n => n >= at - 60_000 && n <= at).length <= 30);
});

test("workerd/D1: official credential cooldown leaves other credentials available", async t => {
  const { request } = await fixture(t);
  assert.deepEqual(await (await request("/fixture/dnshe-isolation")).json(), { code: "scheduler_cooldown", independent: true });
});

test("workerd/D1: integral REAL lease recovery preserves history and the full rolling window", async t => {
  const { d1, request } = await fixture(t);
  const key = `dnshe_queue:v1:${createHash('sha256').update('runtime-recover').digest('hex')}`;
  for (const count of [29, 30]) {
    const events = Array(count).fill(5000);
    await d1.prepare("INSERT OR REPLACE INTO cache VALUES(?,?,?)").bind(key, `{"owner":"abandoned","leaseUntil":0.0,"events":${JSON.stringify(events)}}`, 9999999999).run();
    await d1.prepare("INSERT OR REPLACE INTO cache VALUES(?,?,?)").bind(`${key}:blocked`, "999.0", 9999999999).run();
    assert.equal(await d1.prepare("SELECT json_type(value,'$.leaseUntil') AS type FROM cache WHERE key=?").bind(key).first("type"), "real");
    const response = await request("/fixture/dnshe-lease-state");
    assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.claimType, "integer");
    assert.equal(body.now, count === 30 ? 5000 : 1000);
    assert.deepEqual(body.waits, count === 30 ? [1000,1000,1000,1000] : []);
    const saved = JSON.parse(await d1.prepare("SELECT value FROM cache WHERE key=?").bind(key).first("value"));
    assert.deepEqual(saved.events.slice(0, -1), count === 30 ? [] : events);
    assert.equal(saved.owner, ""); assert.equal(saved.leaseUntil, 0);
    assert.equal(await d1.prepare("SELECT value FROM cache WHERE key=?").bind(`${key}:blocked`).first("value"), "999.0");
  }
});

test("workerd/D1: failed claim cleanup writes INTEGER and lease expiry permits a later invocation", async t => {
  const { d1, request } = await fixture(t);
  const key = `dnshe_queue:v1:${createHash('sha256').update('runtime-recover').digest('hex')}`;
  const events = [60000];
  await d1.prepare("INSERT INTO cache VALUES(?,?,?)").bind(key, JSON.stringify({owner:"",leaseUntil:0,events}), 9999999999).run();
  const failed = await request("/fixture/dnshe-lease-state?mode=fail-cleanup");
  assert.equal(failed.status, 502); assert.equal((await failed.json()).claimType, "integer");
  assert.equal(await d1.prepare("SELECT json_type(value,'$.leaseUntil') AS type FROM cache WHERE key=?").bind(key).first("type"), "integer");
  const stranded = JSON.parse(await d1.prepare("SELECT value FROM cache WHERE key=?").bind(key).first("value"));
  assert.ok(stranded.owner); assert.deepEqual(stranded.events, events);
  const response = await request(`/fixture/dnshe-lease-state?now=${stranded.leaseUntil + 1}`);
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).waits, []);
});

test("workerd/D1: active REAL lease, cooldown and corrupt states still deny admission without rewriting", async t => {
  const { d1, request } = await fixture(t);
  const key = `dnshe_queue:v1:${createHash('sha256').update('runtime-recover').digest('hex')}`;
  const active = '{"owner":"active","leaseUntil":9007199254740991.0,"events":[40000]}';
  const seed = value => d1.prepare("INSERT OR REPLACE INTO cache VALUES(?,?,?)").bind(key,value,9999999999).run();
  const saved = () => d1.prepare("SELECT value FROM cache WHERE key=?").bind(key).first("value");
  await seed(active);
  const cancelled = await request("/fixture/dnshe-lease-state?mode=cancel");
  assert.equal((await cancelled.json()).code, "request_cancelled"); assert.equal(await saved(), active);
  const expired = '{"owner":"old","leaseUntil":0.0,"events":[]}'; await seed(expired);
  await d1.prepare("INSERT INTO cache VALUES(?,?,?)").bind(`${key}:blocked`, "99999", 9999999999).run();
  const blocked = await request("/fixture/dnshe-lease-state"); assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).code, "scheduler_cooldown"); assert.equal(await saved(), expired);
  await d1.prepare("DELETE FROM cache WHERE key=?").bind(`${key}:blocked`).run();
  for (const value of ["bad", ...['0.5','-1.0','9007199254740992.0','"0"','null','true','1e100'].map(lease => `{"owner":"","leaseUntil":${lease},"events":[]}`),
    '{"owner":"","leaseUntil":0.0,"events":[1.5]}', JSON.stringify({owner:"",leaseUntil:0,events:Array(31).fill(1)})]) {
    await seed(value);
    const rejected = await request("/fixture/dnshe-lease-state"); assert.equal(rejected.status, 502);
    assert.equal((await rejected.json()).code, "scheduler_unavailable"); assert.equal(await saved(), value);
  }
});

for (const mode of ["deep", "auto", "cron-cache", "cron-always"]) {
  test(`workerd/D1: DNSHE ${mode} serializes real shared-budget quota/offset/cursor requests`, async t => {
    const calls = [];
    const { d1, request } = await fixture(t, request => {
      assert.equal(request.method, "GET", "no provider writes in this regression");
      const url = new URL(request.url);
      calls.push(url);
      return dnsheSyncResponse(url);
    });
    await d1.exec("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'fixture','sync-fixture-key','offline-secret','dnshe')");
    const response = await request(`/fixture/dnshe-serial-sync?mode=${mode}`);
    assert.equal(response.status, 200);
    const { result, maxPending, waits } = await response.json();
    assert.equal(result.status, "completed");
    if (mode === "cron-cache" || mode === "cron-always") {
      assert.equal(calls.length, 1, "only the fixture's prior quota read; Cron makes zero upstream requests");
      assert.equal((await d1.prepare("SELECT count(*) AS n FROM domains_cache").first()).n, 0);
      assert.deepEqual(waits, []);
      return;
    }
    assert.equal(maxPending, 1);
    assert.ok(waits.length > 0 && waits.every(ms => ms === 2100));
    assert.deepEqual(calls.filter(url => url.searchParams.get("endpoint") === "dns_records").map(url =>
      [url.searchParams.get("subdomain_id"), url.searchParams.get("cursor")]),
    [101, 102, 103, 104].flatMap(id => [[String(id), "0"], [String(id), "1"]]));
    assert.equal(calls.filter(url => url.searchParams.get("endpoint") === "quota").length, mode === "auto" ? 2 : 1);
    const domains = (await d1.prepare("SELECT status FROM domains_cache").all()).results;
    assert.equal(domains.length, 4);
    assert.ok(domains.every(row => row.status === "已解析"));
    const cached = (await d1.prepare("SELECT value FROM cache WHERE key LIKE 'api_cache:dns:%'").all()).results;
    assert.equal(cached.length, 4);
    assert.ok(cached.every(row => JSON.parse(row.value).length === 2));
  });
}

test("workerd/D1: concurrent independent requests have exactly two deployment permits", async t => {
  const { d1, request } = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 12 }, () => request("/fixture/scheduler-claim")));
  assert.equal(responses.filter(r => r.status === 200).length, 2);
  assert.equal(responses.filter(r => r.status === 429).length, 10);
  for (const response of responses) if (response.status === 429) assert.equal((await response.json()).code, "scheduler_busy");
  assert.equal((await d1.prepare("SELECT count(*) AS n FROM cache WHERE key LIKE 'provider_scheduler:%'").first()).n, 2);
});

test("workerd/D1: monotonic cooldown blocks new requests and bad values fail closed", async t => {
  const { d1, request } = await fixture(t);
  await request("/fixture/scheduler-block?ms=60000");
  await request("/fixture/scheduler-block?ms=1000");
  const denied = await request("/fixture/scheduler-claim");
  assert.equal(denied.status, 429);
  const body = await denied.json();
  assert.equal(body.code, "scheduler_cooldown");
  assert.ok(body.retryAfterMs > 50000);
  await d1.prepare("UPDATE cache SET value='bad' WHERE key='provider_scheduler:v1:cloudflare:blocked'").run();
  assert.equal((await request("/fixture/scheduler-claim")).status, 502);
  assert.equal((await request("/fixture/scheduler-block?ms=1000")).status, 502);
  assert.equal((await d1.prepare("SELECT value FROM cache WHERE key='provider_scheduler:v1:cloudflare:blocked'").first()).value, "bad");
});

test("workerd/D1: failed cooldown write is not reported as persisted", async t => {
  const { d1, request } = await fixture(t);
  await d1.prepare(`CREATE TRIGGER deny_scheduler_block BEFORE INSERT ON cache WHEN NEW.key LIKE '%:blocked'
    BEGIN SELECT RAISE(ABORT, 'fixture'); END`).run();
  const response = await request("/fixture/scheduler-block?ms=60000");
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "scheduler_unavailable");
  assert.equal(await d1.prepare("SELECT value FROM cache WHERE key='provider_scheduler:v1:cloudflare:blocked'").first(), null);
  assert.equal((await request("/fixture/scheduler-claim")).status, 200);
});

test("workerd/D1: stale request cleanup cannot release a replacement permit", async t => {
  const { request } = await fixture(t);
  assert.deepEqual(await (await request("/fixture/scheduler-stale-release")).json(), { retained: true });
});

test("workerd/D1: real Action PATCH is field-local and terminal/cancelled results are immutable", async t => {
  const { mf } = await fixture(t);
  const call = (path, method, body) => mf.dispatchFetch(`http://localhost${path}`, { method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer offline-admin" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const { action } = await (await call("/api/actions", "POST", { type: "sync", metadata: { label: "fixture" } })).json();
  const path = `/api/actions/${action.id}`;
  await Promise.all([call(path, "PATCH", { progress: 25 }), call(path, "PATCH", { error: "preserve" })]);
  const running = (await (await call(path, "GET")).json()).action;
  assert.equal(running.status, "running");
  assert.equal(running.progress, 25);
  assert.equal(running.error, "preserve");
  assert.deepEqual(running.metadata, { label: "fixture" });
  assert.equal((await call(path, "PATCH", { progress: null })).status, 400);
  const unsupported = await call(`${path}/cancel`, "POST");
  assert.equal(unsupported.status, 409); assert.equal((await unsupported.json()).error_code, "cancel_not_supported");
  // A client-owned terminal marker remains supported, but is not a promise that
  // an already-sent provider request was cancelled or rolled back.
  const cancelled = (await (await call(path, "PATCH", { status: "cancelled" })).json()).action;
  await call(`${path}/complete`, "POST");
  await call(path, "PATCH", { status: "running", metadata: null });
  assert.deepEqual((await (await call(path, "GET")).json()).action, cancelled);
  const second = (await (await call("/api/actions", "POST", { type: "sync" })).json()).action;
  const partial = (await (await call(`/api/actions/${second.id}`, "PATCH", { status: "partial", error: "DNS incomplete" })).json()).action;
  assert.equal(partial.status, "partial");
  assert.ok(partial.finished_at);
});
