import "../helpers/block-outbound";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createD1FromSqlite } from "../../server/d1-sqlite";
import { DnsheAccountRequestScheduler } from "../../src/services/dnshe-account-scheduler";
import { SharedProviderRequestScheduler } from "../../src/services/provider-request-scheduler";
import { ProviderApiError } from "../../src/errors/provider-api-error";
import { DNSHEClient } from "../../src/dnshe";
import { requestProviderText } from "../../src/providers/provider-request";
import { coordinationFault, deferred } from "../helpers/coordination-fault";
import { sha256Hex } from "../../src/db/crypto";
import { InvocationBudget } from "../../src/services/invocation-budget";
import { withBudgetD1 } from "../../src/db/budget-d1";

const baseline = globalThis.fetch;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const typed = (code: string) => (error: unknown) => {
  assert.ok(error instanceof ProviderApiError);
  assert.equal(error.error_code, code);
  return true;
};
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER NOT NULL)");
  t.after(() => { sqlite.close(); globalThis.fetch = baseline; });
  const db = createD1FromSqlite(sqlite);
  let now = 1000;
  const waits: number[] = [];
  const sleep = async (ms: number) => { waits.push(ms); now += ms; };
  return { db, sqlite, waits, get now() { return now; }, set now(n: number) { now = n; },
    make: (key = "fixture-key", database = db) => new DnsheAccountRequestScheduler(database, key, () => now, sleep) };
}
const keyFor = async (key = "fixture-key") => `dnshe_queue:v1:${await sha256Hex(key)}`;

test("1000 independent credentials have 1000 lanes, without provider slots or credential diagnostics", async t => {
  const f = fixture(t);
  const lanes = Array.from({ length: 1000 }, (_, i) => f.make(`secret-fixture-${i}`));
  const leases = await Promise.all(lanes.map(lane => lane.acquire(1000)));
  for (const lease of leases) lease.assertReady!();
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM cache WHERE key LIKE 'dnshe_queue:%'").get()?.n, 1000);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM cache WHERE key LIKE 'provider_scheduler:%'").get()?.n, 0);
  await Promise.all(leases.map(lease => lease.release()));
  assert.equal(f.waits.length, 0);
  for (const row of f.sqlite.prepare("SELECT key,value FROM cache").all()) {
    assert.equal(JSON.stringify(row).includes("secret-fixture"), false);
    assert.equal(JSON.parse(String(row.value)).events.length, 1);
  }
});

test("rolling 30/60s spans instances, counts failures/cancellation, and does not reset at minute boundaries", async t => {
  const f = fixture(t);
  const starts: number[] = [];
  globalThis.fetch = async () => { starts.push(f.now); return Response.json({ success: true }); };
  const send = () => requestProviderText("dnshe", "https://fixture.invalid", {}, { scheduler: f.make() });
  f.now = 59_990;
  for (let i = 0; i < 30; i++) await send();
  f.now = 60_001;
  await send();
  assert.equal(starts.length, 31);
  assert.ok(starts[30] > starts[0] + 60_000);
  assert.ok(f.waits.reduce((a, b) => a + b, 0) > 60_000 - 20);
  for (const at of starts) assert.ok(starts.filter(n => n >= at - 60_000 && n <= at).length <= 30);
  const state = JSON.parse(String(f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(await keyFor())?.value));
  assert.equal(state.events.length, 1);
});

test("slow lane does not block any other key and same-key contenders wait without future reservations", async t => {
  const f = fixture(t);
  const one = await f.make().acquire(1000);
  one.assertReady!();
  const gate = deferred();
  const sleeping = deferred();
  const contender = new DnsheAccountRequestScheduler(f.db, "fixture-key", () => f.now, async () => { sleeping.resolve(); await gate.promise; });
  const queued = contender.acquire(1000);
  await sleeping.promise;
  const other = await f.make("other-key").acquire(1000);
  other.assertReady!();
  assert.equal(JSON.parse(String(f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(await keyFor())?.value)).events.length, 1);
  await other.release();
  await one.release();
  gate.resolve();
  const two = await queued;
  two.assertReady!();
  await two.release();
  assert.equal(JSON.parse(String(f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(await keyFor())?.value)).events.length, 2);
});

test("official 429 persists only credential cooldown, monotonic blocks and unrelated key stays usable", async t => {
  const f = fixture(t);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ success: false, error_code: "rate_limit_exceeded" }, { status: 429, headers: { "Retry-After": "12" } }); };
  await assert.rejects(new DNSHEClient("fixture-key", "secret", undefined, { scheduler: f.make() }).whois("demo.example"), typed("rate_limit_exceeded"));
  await f.make().block(1000);
  await assert.rejects(f.make().acquire(1000), typed("scheduler_cooldown"));
  assert.equal(calls, 1);
  const other = await f.make("other-key").acquire(1000);
  await other.release();
  assert.equal(f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(`${await keyFor()}:blocked`)?.value, "14000");
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM cache WHERE key LIKE 'provider_scheduler:%'").get()?.n, 0);
});

test("inherited global cooldown and legacy integer .0 budget survive upgrade without being erased", async t => {
  const f = fixture(t);
  await new SharedProviderRequestScheduler(f.db, "dnshe", () => f.now).block(10_000);
  await assert.rejects(f.make("other-key").acquire(1000), error => {
    typed("scheduler_cooldown")(error);
    assert.equal((error as ProviderApiError).details.details.scope, "deployment_provider");
    return true;
  });
  f.now = 11_001;
  const legacy = `dnshe_budget:${await sha256Hex("fixture-key")}`;
  f.sqlite.prepare("INSERT INTO cache VALUES(?,?,?)").run(legacy, "11000.0", 999999);
  const lease = await f.make().acquire(1000);
  lease.assertReady!();
  assert.equal(f.now, 71_001);
  await lease.release();
  assert.equal(f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(legacy)?.value, "11000.0");
});

test("cancellation while queued sends nothing and bounded same-key waiting consumes no tokens", async t => {
  const f = fixture(t);
  const lease = await f.make().acquire(1000);
  const controller = new AbortController();
  const cancelled = new DnsheAccountRequestScheduler(f.db, "fixture-key", () => f.now, async () => controller.abort());
  globalThis.fetch = async () => { assert.fail("cancelled queue must not send"); };
  await assert.rejects(requestProviderText("dnshe", "https://fixture.invalid", { signal: controller.signal }, { scheduler: cancelled }), typed("request_cancelled"));
  const bounded = new DnsheAccountRequestScheduler(f.db, "fixture-key", () => f.now, async ms => { f.now += ms; }, 2000, 2000);
  await assert.rejects(bounded.acquire(1000), typed("rate_limited"));
  assert.equal(JSON.parse(String(f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(await keyFor())?.value)).events.length, 1);
  await lease.release();
});

test("expired/late dispatch authorization is counted but never sent; stale cleanup preserves replacement", async t => {
  const f = fixture(t);
  const old = await f.make().acquire(1000);
  f.now += 4000;
  assert.throws(() => old.assertReady!(), typed("scheduler_unavailable"));
  f.now = 100_000;
  const fresh = await f.make().acquire(1000);
  await old.release();
  const state = JSON.parse(String(f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(await keyFor())?.value));
  assert.notEqual(state.owner, "");
  fresh.assertReady!();
  await fresh.release();
});

for (const expiredEvents of [false, true]) {
  test(`expired integral REAL lease recovers without dropping rolling history (expiredEvents=${expiredEvents})`, async t => {
    const f = fixture(t); f.now = 1793550000000;
    const key = await keyFor();
    const events = Array(expiredEvents ? 30 : 29).fill(f.now + (expiredEvents ? -1000 : 40000));
    const value = `{"owner":"abandoned","leaseUntil":1793547434000.0,"events":${JSON.stringify(events)}}`;
    f.sqlite.prepare("INSERT INTO cache VALUES(?,?,?)").run(key, value, 9999999999);
    assert.equal(f.sqlite.prepare("SELECT json_type(value,'$.leaseUntil') AS type FROM cache WHERE key=?").get(key)?.type, "real");
    const inspect = coordinationFault(f.db, async (sql, _method, execute) => {
      if (sql === "SELECT value FROM cache WHERE key=?") {
        const row = f.sqlite.prepare("SELECT value,json_type(value,'$.leaseUntil') AS type FROM cache WHERE key=?").get(key)!;
        assert.equal(row.type, "integer", "claim must normalize only the lease before any dispatch write");
        assert.deepEqual(JSON.parse(String(row.value)).events, events, "claim must retain even expired history until normal dispatch pruning");
      }
      return execute();
    });
    const lease = await f.make("fixture-key", inspect).acquire(1000);
    lease.assertReady!(); await lease.release();
    const saved = JSON.parse(String(f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(key)?.value));
    assert.equal(saved.owner, ""); assert.equal(saved.leaseUntil, 0);
    assert.deepEqual(saved.events.slice(0, -1), expiredEvents ? [] : events);
    assert.equal(saved.events.length, expiredEvents ? 1 : 30); assert.deepEqual(f.waits, []);
  });
}

test("recovering REAL lease retains the full 30-token window and existing cooldown rows", async t => {
  const f = fixture(t); const key = await keyFor(); const events = Array(30).fill(5000);
  f.sqlite.prepare("INSERT INTO cache VALUES(?,?,?)").run(key, `{"owner":"abandoned","leaseUntil":0.0,"events":${JSON.stringify(events)}}`, 999999);
  f.sqlite.prepare("INSERT INTO cache VALUES(?,?,?)").run(`${key}:blocked`, "999.0", 999999);
  const lane = new DnsheAccountRequestScheduler(f.db, "fixture-key", () => f.now, async ms => {
    assert.deepEqual(JSON.parse(String(f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(key)?.value)).events, events);
    f.waits.push(ms); f.now += ms;
  });
  const lease = await lane.acquire(1000); lease.assertReady!(); await lease.release();
  assert.equal(f.now, 5000); assert.deepEqual(f.waits, [1000,1000,1000,1000]);
  assert.equal(JSON.parse(String(f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(key)?.value)).events.length, 1);
  assert.equal(f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(`${key}:blocked`)?.value, "999.0");
});

test("active integral REAL lease is not stolen, cancelled waiting preserves it and unrelated keys work", async t => {
  const f = fixture(t); const key = await keyFor();
  const value = '{"owner":"active","leaseUntil":9007199254740991.0,"events":[40000]}';
  f.sqlite.prepare("INSERT INTO cache VALUES(?,?,?)").run(key, value, 9999999999);
  const controller = new AbortController();
  const lane = new DnsheAccountRequestScheduler(f.db, "fixture-key", () => f.now, async () => controller.abort());
  await assert.rejects(lane.acquire(1000, controller.signal), typed("request_cancelled"));
  assert.equal(f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(key)?.value, value);
  const other = await f.make("unrelated").acquire(1000); other.assertReady!(); await other.release();
});

test("failed post-claim work and failed cleanup leave an INTEGER lease that expires normally", async t => {
  const f = fixture(t); const key = await keyFor(); const events = [60000];
  f.sqlite.prepare("INSERT INTO cache VALUES(?,?,?)").run(key, JSON.stringify({owner:"",leaseUntil:0,events}), 999999);
  const fault = coordinationFault(f.db, (sql, method, execute) => {
    if (sql === "SELECT value FROM cache WHERE key=?" || method === "run") throw new Error("offline failed boundary");
    return execute();
  });
  await assert.rejects(f.make("fixture-key", fault).acquire(1000), typed("scheduler_unavailable"));
  const row = f.sqlite.prepare("SELECT value,json_type(value,'$.leaseUntil') AS type FROM cache WHERE key=?").get(key)!;
  assert.equal(row.type, "integer");
  const stranded = JSON.parse(String(row.value)); assert.ok(stranded.owner); assert.deepEqual(stranded.events, events);
  f.now = stranded.leaseUntil + 1;
  const next = await f.make().acquire(1000); next.assertReady!(); await next.release();
  assert.deepEqual(f.waits, []);
});

for (const value of ["bad", '{"owner":"","leaseUntil":0,"events":["bad"]}', '{"owner":"","leaseUntil":0,"events":null}',
  ...["0.5", "-1", "-1.0", "9007199254740992", "9007199254740992.0", "1e100", '"0"', "null", "true", "[]", "{}"].map(lease => `{"owner":"","leaseUntil":${lease},"events":[]}`),
  '{"owner":null,"leaseUntil":0.0,"events":[]}', '{"owner":"","leaseUntil":0.0,"events":[1.5]}',
  JSON.stringify({owner:"",leaseUntil:0,events:Array(31).fill(1)}),
]) {
  test(`corrupt bounded state fails closed (${value.slice(0, 12)})`, async t => {
    const f = fixture(t);
    const key = await keyFor();
    f.sqlite.prepare("INSERT INTO cache VALUES(?,?,?)").run(key, value, 99999);
    await assert.rejects(f.make().acquire(1000), typed("scheduler_unavailable"));
    assert.equal(f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(key)?.value, value);
  });
}

for (const phase of ["claim", "dispatch", "block", "release"]) {
  test(`${phase} coordination timeout has no retries; late SQL cannot remove rolling history`, async t => {
    const f = fixture(t);
    if (phase === "dispatch") {
      const previous = await f.make().acquire(1000);
      previous.assertReady!();
      await previous.release();
    }
    const gate = deferred();
    const settled = deferred();
    let calls = 0;
    const slow = coordinationFault(f.db, async (sql, method, execute) => {
      const target = phase === "claim" ? sql.startsWith("INSERT") : phase === "dispatch" ? sql.startsWith("UPDATE cache SET value=?")
        : phase === "block" ? sql.includes("MAX(CAST(cache.value") : method === "run";
      if (!target) return execute();
      calls++;
      await gate.promise;
      try { return await execute(); } finally { settled.resolve(); }
    });
    const lane = new DnsheAccountRequestScheduler(slow, "fixture-key", () => f.now, async () => {}, 25);
    globalThis.fetch = async () => { assert.fail("timed-out pre-send SQL must not fetch"); };
    if (phase === "block") await assert.rejects(lane.block(60_000), typed("scheduler_timeout"));
    else if (phase === "release") {
      const lease = await lane.acquire(1000);
      lease.assertReady!();
      await assert.rejects(lease.release(), typed("scheduler_timeout"));
    } else await assert.rejects(requestProviderText("dnshe", "https://fixture.invalid", { method: "POST" }, { scheduler: lane }), typed("scheduler_timeout"));
    assert.equal(calls, 1);
    gate.resolve();
    await settled.promise;
    await tick();
    const row = f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(await keyFor());
    if (phase === "dispatch" || phase === "release") assert.equal(JSON.parse(String(row?.value)).events.length, 1);
  });
}

test("cooldown racing the final dispatch write denies admission before fetch", async t => {
  const f = fixture(t);
  const fault = coordinationFault(f.db, async (sql, _method, execute) => {
    if (sql.startsWith("UPDATE cache SET value=?")) await f.make().block(60_000);
    return execute();
  });
  globalThis.fetch = async () => { assert.fail("cooldown must be checked atomically at commit"); };
  await assert.rejects(requestProviderText("dnshe", "https://fixture.invalid", {}, { scheduler: f.make("fixture-key", fault) }), typed("scheduler_cooldown"));
  assert.equal(JSON.parse(String(f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(await keyFor())?.value)).events.length, 0);
});

test("unknown mutation outcome is not overwritten by release failure or automatically retried", async t => {
  const f = fixture(t);
  const fault = coordinationFault(f.db, (sql, method, execute) => method === "run" ? Promise.reject(new Error("private-release")) : execute());
  let sends = 0;
  globalThis.fetch = async () => { sends++; throw new Error("private-write-network"); };
  await assert.rejects(new DNSHEClient("fixture-key", "secret", undefined, { scheduler: f.make("fixture-key", fault) })
    .createDnsRecord({ subdomain_id: 101, type: "TXT", content: "fixture" }), typed("transport_error"));
  assert.equal(sends, 1);
});

test("production mode uses SQLite authoritative clock instead of client host time", async t => {
  const f = fixture(t);
  const before = Date.now();
  const lane = new DnsheAccountRequestScheduler(f.db, "fixture-key");
  const lease = await lane.acquire(1000);
  lease.assertReady!();
  await lease.release();
  const state = JSON.parse(String(f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(await keyFor())?.value));
  assert.ok(state.events[0] >= before + 60_000);
  assert.ok(state.events[0] < Date.now() + 64_001);
});

test("whole-second DB clock does not spin at the one-ms rolling-window boundary", async t => {
  const f = fixture(t);
  let virtualNow = Math.floor(Date.now() / 1000) * 1000;
  const start = virtualNow;
  f.sqlite.prepare("INSERT INTO cache VALUES(?,?,?)").run(await keyFor(), JSON.stringify({ owner: "", leaseUntil: 0, events: Array(30).fill(start + 1) }), Math.floor(start / 1000) + 3600);
  const coarse = coordinationFault(f.db, (sql, _method, execute) => sql.includes("SELECT CAST(strftime('%s','now') AS INTEGER)*1000 AS now")
    ? Promise.resolve({ now: Math.floor(virtualNow / 1000) * 1000 }) : execute());
  const budget = new InvocationBudget(); budget.consume("d1", 9);
  const tail = budget.reserve({ d1: 3 }); t.after(() => tail.release());
  const sleeps: number[] = [];
  const lane = new DnsheAccountRequestScheduler(withBudgetD1(coarse, budget), "fixture-key", undefined, async ms => { sleeps.push(ms); virtualNow += ms; });
  const lease = await lane.acquire(1000); await lease.release();
  assert.deepEqual(sleeps, [1000]);
  assert.equal(virtualNow - start, 1000);
  assert.ok(budget.snapshot().used.d1 <= 24);
  assert.equal(budget.snapshot().used.external, 0);
  assert.equal(JSON.parse(String(f.sqlite.prepare("SELECT value FROM cache WHERE key=?").get(await keyFor())?.value)).events.length, 1);
});

test("two real SQLite connections coordinate one credential, while unrelated credentials remain independent", async t => {
  const base = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Temp", "opencode") : tmpdir();
  const dir = mkdtempSync(join(base, "dnshe-lanes-"));
  const path = join(dir, "fixture.db");
  const a = new DatabaseSync(path);
  const b = new DatabaseSync(path);
  t.after(() => { a.close(); b.close(); unlinkSync(path); rmdirSync(dir); });
  a.exec("CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER NOT NULL)");
  const first = new DnsheAccountRequestScheduler(createD1FromSqlite(a), "shared-key", () => 1000);
  const lease = await first.acquire(1000);
  lease.assertReady!();
  const controller = new AbortController();
  const second = new DnsheAccountRequestScheduler(createD1FromSqlite(b), "shared-key", () => 1000, async () => controller.abort());
  await assert.rejects(second.acquire(1000, controller.signal), typed("request_cancelled"));
  await lease.release();
  const fresh = await second.acquire(1000);
  fresh.assertReady!();
  await fresh.release();
  const key = await keyFor("shared-key");
  assert.equal(JSON.parse(String(b.prepare("SELECT value FROM cache WHERE key=?").get(key)?.value)).events.length, 2);
});

test("failed sends and cancelled dispatch authorizations consume budget rather than being refunded", async t => {
  const f = fixture(t);
  const cancelled = await f.make().acquire(1000);
  await cancelled.release(); // Reserved dispatch was abandoned; still counted.
  let sends = 0;
  globalThis.fetch = async () => { sends++; throw new Error("private-network"); };
  for (let i = 0; i < 29; i++) await assert.rejects(requestProviderText("dnshe", "https://fixture.invalid", {}, { scheduler: f.make() }), typed("transport_error"));
  assert.equal(sends, 29);
  assert.equal(f.waits.length, 0);
  const next = await f.make().acquire(1000);
  assert.ok(f.now > 61_000);
  next.assertReady!();
  await next.release();
});
