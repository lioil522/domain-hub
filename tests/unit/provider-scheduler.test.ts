import "../helpers/block-outbound";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createD1FromSqlite, type SqliteStatement } from "../../server/d1-sqlite";
import { SharedProviderRequestScheduler } from "../../src/services/provider-request-scheduler";
import { ProviderApiError } from "../../src/errors/provider-api-error";
import { requestProviderText } from "../../src/providers/provider-request";
import { transportProviders, transportFixture, transportEmptyDomains, transportErrorBody, businessRateLimits } from "../helpers/provider-transport";
import { DNSHEClient } from "../../src/dnshe";
import { HuaweiCloudClient, HuaweiApiError } from "../../src/huaweicloud";
import { recognizeProviderRateLimit } from "../../src/providers/provider-rate-limit";
import { coordinationFault, deferred } from "../helpers/coordination-fault";
import { CoordinationDeadline, COORDINATION_TIMEOUT_MS } from "../../src/services/coordination-deadline";

const baseline = globalThis.fetch;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const typed = (code: string) => (error: unknown) => {
  assert.ok(error instanceof ProviderApiError);
  assert.equal(error.error_code, code);
  return true;
};
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE cache(key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  t.after(() => { sqlite.close(); globalThis.fetch = baseline; });
  const db = createD1FromSqlite(sqlite);
  return { sqlite, db };
}

test("coordination phases validate limits, share one deadline and stop starting SQL after expiry", async t => {
  const { db } = fixture(t);
  assert.equal(COORDINATION_TIMEOUT_MS, 2000);
  for (const timeout of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
    assert.throws(() => new SharedProviderRequestScheduler(db, "vercel", Date.now, timeout));
  }
  const failure = new Error("bounded phase");
  const deadline = new CoordinationDeadline(100, () => failure);
  await deadline.run(async () => { await new Promise(resolve => setTimeout(resolve, 65)); });
  await assert.rejects(deadline.run(async () => { await new Promise(resolve => setTimeout(resolve, 65)); }), error => error === failure);
  let called = false;
  await assert.rejects(deadline.run(async () => { called = true; }), error => error === failure);
  assert.equal(called, false);
});

for (const phase of ["before", "after", "reject"] as const) {
  test(`claim ${phase} deadline: no upstream/second slot; late SQL is cleaned up or rejection consumed`, async t => {
    const { db, sqlite } = fixture(t);
    const gate = deferred();
    const cleaned = deferred();
    let claims = 0;
    const slow = coordinationFault(db, async (sql, method, execute) => {
      if (sql.startsWith("INSERT")) {
        claims++;
        const result = phase === "after" ? await execute() : undefined;
        await gate.promise;
        return phase === "after" ? result : execute();
      }
      const result = await execute();
      if (method === "run") cleaned.resolve();
      return result;
    });
    globalThis.fetch = async () => { assert.fail("timed-out admission must not send"); };
    await assert.rejects(requestProviderText("vercel", "https://fixture.invalid", { method: "POST" }, {
      scheduler: new SharedProviderRequestScheduler(slow, "vercel", () => 1000, 30),
    }), error => {
      typed("scheduler_timeout")(error);
      const details = (error as ProviderApiError).details as { details: { request_sent: boolean; coordination_operation: string } };
      assert.equal(details.details.request_sent, false);
      assert.equal(details.details.coordination_operation, "acquire");
      return true;
    });
    assert.equal(claims, 1);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cache").get()?.n, phase === "after" ? 1 : 0);
    if (phase === "reject") { gate.reject(new Error("secret-late-sql")); await tick(); }
    else { gate.resolve(); await cleaned.promise; }
    assert.equal(claims, 1);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cache").get()?.n, 0);
  });
}

test("second slot and cooldown diagnostic query are independently bounded within acquisition phase", async t => {
  const { db } = fixture(t);
  const full = new SharedProviderRequestScheduler(db, "vercel", () => 1000);
  const one = await full.acquire(1000);
  const two = await full.acquire(1000);
  for (const target of ["second-slot", "diagnostic"]) {
    let claims = 0;
    let reads = 0;
    const gate = deferred();
    const slow = coordinationFault(db, (sql, _method, execute) => {
      if (sql.startsWith("INSERT")) {
        claims++;
        if (target === "second-slot" && claims === 2) return gate.promise.then(() => execute());
      } else { reads++; return gate.promise.then(() => execute()); }
      return execute();
    });
    await assert.rejects(new SharedProviderRequestScheduler(slow, "vercel", () => 1000, 30).acquire(1000), typed("scheduler_timeout"));
    assert.equal(claims, 2);
    assert.equal(reads, target === "diagnostic" ? 1 : 0);
    gate.resolve();
    await tick();
    assert.equal(claims, 2);
  }
  await one.release();
  await two.release();
});

test("late claim plus failed cleanup leaves only an expiring permit, never deletes a replacement", async t => {
  const { db, sqlite } = fixture(t);
  const gate = deferred();
  const cleanup = deferred();
  let now = 1000;
  const slow = coordinationFault(db, async (sql, method, execute) => {
    if (sql.startsWith("INSERT")) { const row = await execute(); await gate.promise; return row; }
    if (method === "run") { cleanup.resolve(); throw new Error("cleanup unavailable"); }
    return execute();
  });
  await assert.rejects(new SharedProviderRequestScheduler(slow, "vercel", () => now, 30).acquire(1000), typed("scheduler_timeout"));
  now = 7000;
  const replacement = await new SharedProviderRequestScheduler(db, "vercel", () => now).acquire(1000);
  const owner = sqlite.prepare("SELECT value FROM cache").get()?.value;
  gate.resolve();
  await cleanup.promise;
  await tick();
  assert.equal(sqlite.prepare("SELECT value FROM cache").get()?.value, owner);
  await replacement.release();
});

test("release deadline preserves primary errors; successful write becomes uncertain and stale delete is owner-guarded", async t => {
  const { db, sqlite } = fixture(t);
  const gates = [deferred(), deferred()];
  let releases = 0;
  let now = 1000;
  const slow = coordinationFault(db, (sql, method, execute) => method === "run" && sql.startsWith("DELETE")
    ? gates[releases++].promise.then(() => execute()) : execute());
  const scheduler = new SharedProviderRequestScheduler(slow, "vercel", () => now, 30);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("{}"); };
  await assert.rejects(requestProviderText("vercel", "https://fixture.invalid", { method: "POST" }, { scheduler, timeoutMs: 1000 }), error => {
    typed("scheduler_timeout")(error);
    assert.match(String(error), /可能已发送/);
    const details = (error as ProviderApiError).details as { details: { coordination_operation: string; request_sent: string } };
    assert.equal(details.details.coordination_operation, "release");
    assert.equal(details.details.request_sent, "unknown");
    return true;
  });
  globalThis.fetch = async () => { calls++; throw new Error("secret-network"); };
  await assert.rejects(requestProviderText("vercel", "https://fixture.invalid", { method: "POST" }, { scheduler, timeoutMs: 1000 }), typed("transport_error"));
  await assert.rejects(scheduler.acquire(1000), typed("scheduler_busy"));
  assert.equal(calls, 2);
  now = 7000;
  const current = await new SharedProviderRequestScheduler(db, "vercel", () => now).acquire(1000);
  const owner = sqlite.prepare("SELECT value FROM cache WHERE key LIKE '%:slot:0'").get()?.value;
  gates.forEach(gate => gate.resolve());
  await tick();
  assert.equal(sqlite.prepare("SELECT value FROM cache WHERE key LIKE '%:slot:0'").get()?.value, owner);
  await current.release();
});

for (const mode of ["headers", "business", "reject"] as const) {
  test(`${mode}: cooldown deadline cancels body, reports unknown persistence and consumes late DB outcome`, async t => {
    const { db, sqlite } = fixture(t);
    const gate = deferred();
    let cancelled = 0;
    let calls = 0;
    const slow = coordinationFault(db, (sql, _method, execute) => sql.includes("MAX(CAST(cache.value")
      ? gate.promise.then(() => execute()) : execute());
    const scheduler = new SharedProviderRequestScheduler(slow, "vercel", () => 1000, 30);
    globalThis.fetch = async () => {
      calls++;
      return mode === "business" ? Response.json({ error: { code: "rate_limited" } })
        : new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { status: 429 });
    };
    await assert.rejects(transportFixture("vercel", { scheduler }).write(), error => {
      typed("scheduler_timeout")(error);
      const details = (error as ProviderApiError).details as { details: { cooldown_persisted: string; coordination_operation: string } };
      assert.equal(details.details.cooldown_persisted, "unknown");
      assert.equal(details.details.coordination_operation, "block");
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(cancelled, mode === "business" ? 0 : 1);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cache").get()?.n, 0);
    if (mode === "reject") gate.reject(new Error("secret-late-block"));
    else gate.resolve();
    await tick();
    if (mode !== "reject") await assert.rejects(scheduler.acquire(1000), typed("scheduler_cooldown"));
    else { const lease = await scheduler.acquire(1000); await lease.release(); }
  });
}

test("transport deadline remains primary when shorter than a hung real cooldown DB call", async t => {
  const { db } = fixture(t);
  const gate = deferred();
  const slow = coordinationFault(db, (sql, _method, execute) => sql.includes("MAX(CAST(cache.value")
    ? gate.promise.then(() => execute()) : execute());
  globalThis.fetch = async () => new Response("too many requests", { status: 429 });
  await assert.rejects(requestProviderText("vercel", "https://fixture.invalid", {}, {
    scheduler: new SharedProviderRequestScheduler(slow, "vercel", Date.now, 100), timeoutMs: 25,
  }), typed("request_timeout"));
  gate.reject(new Error("late rejected SQL"));
  await tick();
});

test("shared DB admission: 40 independent instances claim exactly two permits without a queue", async t => {
  const { db, sqlite } = fixture(t);
  const instances = Array.from({ length: 40 }, () => new SharedProviderRequestScheduler(db, "cloudflare", () => 1000));
  const attempts = await Promise.allSettled(instances.map(s => s.acquire(20_000)));
  const admitted = attempts.filter(a => a.status === "fulfilled");
  assert.equal(admitted.length, 2);
  for (const result of attempts) if (result.status === "rejected") typed("scheduler_busy")(result.reason);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cache").get()?.n, 2);
  for (const result of admitted) if (result.status === "fulfilled") await result.value.release();
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cache").get()?.n, 0);
});

test("abandoned permits expire; stale/double releases cannot delete a replacement owner", async t => {
  const { db, sqlite } = fixture(t);
  let now = 1000;
  const make = () => new SharedProviderRequestScheduler(db, "vercel", () => now);
  const old = await make().acquire(1000);
  await make().acquire(1000);
  await assert.rejects(make().acquire(1000), typed("scheduler_busy"));
  now = 7000;
  const current = await make().acquire(1000);
  await old.release();
  await old.release();
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cache WHERE expires_at > 7").get()?.n, 1);
  await current.release();
});

test("cooldown is monotonic, shared across credentials, isolated between providers and survives recreation", async t => {
  const { db, sqlite } = fixture(t);
  let now = 1000;
  const make = () => new SharedProviderRequestScheduler(db, "alidns", () => now);
  await Promise.all([make().block(90_000), make().block(3000), make().block(0)]);
  await assert.rejects(make().acquire(1000), error => {
    typed("scheduler_cooldown")(error);
    assert.equal((error as ProviderApiError).retryAfterMs, 90_000);
    return true;
  });
  const other = await new SharedProviderRequestScheduler(db, "dnspod", () => now).acquire(1000);
  await other.release();
  assert.equal(sqlite.prepare("SELECT value FROM cache").get()?.value, "91000");
  now = 91_000;
  const resumed = await make().acquire(1000);
  await resumed.release();
});

test("separate SQLite connections and reopen share permits/cooldown without process-local state", async t => {
  const local = process.env.LOCALAPPDATA;
  const base = local ? join(local, "Temp", "opencode") : tmpdir();
  const directory = mkdtempSync(join(base, "provider-scheduler-"));
  const file = join(directory, "coordination.sqlite");
  const open = new Set<DatabaseSync>();
  const connect = () => { const db = new DatabaseSync(file); open.add(db); return db; };
  const close = (db: DatabaseSync) => { db.close(); open.delete(db); };
  t.after(() => { for (const db of open) db.close(); unlinkSync(file); rmdirSync(directory); });
  const a = connect();
  a.exec("CREATE TABLE cache(key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  const b = connect();
  let now = 1000;
  const make = (db: DatabaseSync) => new SharedProviderRequestScheduler(createD1FromSqlite(db), "vercel", () => now);
  await make(a).acquire(1000);
  await make(b).acquire(1000);
  await assert.rejects(make(b).acquire(1000), typed("scheduler_busy"));
  close(a);
  close(b);
  const c = connect();
  await assert.rejects(make(c).acquire(1000), typed("scheduler_busy"));
  await make(c).block(60_000);
  close(c);
  const d = connect();
  now = 7000; // permits expire, but persisted cooldown still wins after reopening.
  await assert.rejects(make(d).acquire(1000), typed("scheduler_cooldown"));
  now = 61_000;
  const lease = await make(d).acquire(1000);
  await lease.release();
});

test("a slow SQLite claim before or after execution is released without sending a request", async t => {
  const { sqlite } = fixture(t);
  globalThis.fetch = async () => { assert.fail("a claim whose lease is too short must never send"); };
  for (const phase of ["before", "after"]) {
    let now = 1000;
    const db = createD1FromSqlite({ exec: sql => sqlite.exec(sql), prepare: sql => {
      const statement: SqliteStatement = sqlite.prepare(sql);
      return { run: (...args) => statement.run(...args), all: (...args) => statement.all(...args), get: (...args) => {
        const claim = sql.startsWith("INSERT INTO cache");
        if (claim && phase === "before") now += 6000;
        const row = statement.get(...args);
        if (claim && phase === "after") now += 6000;
        return row;
      } };
    } });
    await assert.rejects(requestProviderText("vercel", "https://fixture.invalid", {}, {
      timeoutMs: 1000, scheduler: new SharedProviderRequestScheduler(db, "vercel", () => now),
    }), typed("scheduler_unavailable"));
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cache").get()?.n, 0);
  }
});

test("malformed cooldown, failed DB claims and invalid delay all fail closed without leaking SQL", async t => {
  const { db, sqlite } = fixture(t);
  const scheduler = new SharedProviderRequestScheduler(db, "digitalplat", () => 1000);
  for (const value of ["", "garbage", "1e4", "-1", "9007199254740992"]) {
    sqlite.prepare("INSERT OR REPLACE INTO cache VALUES(?, ?, 0)").run("provider_scheduler:v1:digitalplat:blocked", value);
    await assert.rejects(scheduler.acquire(1000), typed("scheduler_unavailable"));
    await assert.rejects(scheduler.block(3000), typed("scheduler_unavailable"));
    assert.equal(sqlite.prepare("SELECT value FROM cache").get()?.value, value);
  }
  sqlite.exec("DELETE FROM cache");
  for (const delay of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(scheduler.block(delay), typed("scheduler_unavailable"));
  }
  sqlite.exec("CREATE TRIGGER deny_claim BEFORE INSERT ON cache BEGIN SELECT RAISE(ABORT, 'secret-sql-text'); END");
  globalThis.fetch = async () => { assert.fail("failed coordination must not send a request"); };
  await assert.rejects(requestProviderText("digitalplat", "https://fixture.invalid", {}, { scheduler }), error => {
    typed("scheduler_unavailable")(error);
    assert.equal(String(error).includes("secret-sql-text"), false);
    return true;
  });
});

test("failed atomic cooldown write propagates uncertainty, cancels body and does not claim persistence", async t => {
  const { db, sqlite } = fixture(t);
  sqlite.exec(`CREATE TRIGGER deny_block BEFORE INSERT ON cache WHEN NEW.key LIKE '%:blocked'
    BEGIN SELECT RAISE(ABORT, 'secret-coordination-text'); END`);
  let cancelled = 0;
  let sent = 0;
  globalThis.fetch = async () => {
    sent++;
    return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { status: 429 });
  };
  const scheduler = new SharedProviderRequestScheduler(db, "digitalplat");
  await assert.rejects(requestProviderText("digitalplat", "https://fixture.invalid", { method: "POST" }, { scheduler }), error => {
    typed("scheduler_unavailable")(error);
    assert.equal(String(error).includes("secret-coordination-text"), false);
    assert.equal((error as ProviderApiError).status, 502);
    assert.match(String(error), /可能已发送/);
    return true;
  });
  assert.equal(sent, 1);
  assert.equal(cancelled, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cache").get()?.n, 0);
  // Persistence failed: a future claim is not falsely reported as cooled down.
  const lease = await scheduler.acquire(1000);
  await lease.release();
});

test("429 without valid Retry-After defaults to 60 seconds; zero/date clamps to at least one second", async t => {
  const { db, sqlite } = fixture(t);
  globalThis.fetch = async () => { assert.fail("fixture headers must be installed"); };
  for (const value of [null, "bad", "-1", "0", new Date(Date.now() - 60_000).toUTCString()]) {
    const headers = value === null ? undefined : { "Retry-After": value };
    globalThis.fetch = async () => new Response("rate limited", { status: 429, headers });
    await requestProviderText("cloudflare", "https://fixture.invalid", {}, {
      scheduler: new SharedProviderRequestScheduler(db, "cloudflare", () => 1000),
    });
    assert.equal(sqlite.prepare("SELECT value FROM cache").get()?.value, value === "0" || value?.endsWith("GMT") ? "2000" : "61000");
    sqlite.exec("DELETE FROM cache");
  }
});

test("release failure retains permit; successful writes become uncertain, primary transport errors remain intact", async t => {
  const { db, sqlite } = fixture(t);
  const scheduler = new SharedProviderRequestScheduler(db, "cloudflare");
  sqlite.exec("CREATE TRIGGER deny_release BEFORE DELETE ON cache BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  let sent = 0;
  globalThis.fetch = async () => { sent++; return new Response("{}"); };
  await assert.rejects(requestProviderText("cloudflare", "https://fixture.invalid", { method: "POST" }, { scheduler }), typed("scheduler_unavailable"));
  assert.equal(sent, 1);
  globalThis.fetch = async () => { sent++; throw new Error("secret-network-text"); };
  await assert.rejects(requestProviderText("cloudflare", "https://fixture.invalid", { method: "POST" }, { scheduler }), typed("transport_error"));
  assert.equal(sent, 2);
  await assert.rejects(requestProviderText("cloudflare", "https://fixture.invalid", { method: "POST" }, { scheduler }), typed("scheduler_busy"));
  assert.equal(sent, 2);
});

test("caller cancellation before/during admission does not send and returns the acquired permit", async t => {
  const { db, sqlite } = fixture(t);
  const real = new SharedProviderRequestScheduler(db, "vercel");
  const controller = new AbortController();
  let claims = 0;
  const scheduler = { block: (ms: number) => real.block(ms), acquire: async (ms: number) => {
    claims++;
    const lease = await real.acquire(ms);
    controller.abort();
    return lease;
  } };
  globalThis.fetch = async () => { assert.fail("cancelled request must not be sent"); };
  await assert.rejects(requestProviderText("vercel", "https://fixture.invalid", { signal: controller.signal }, { scheduler }), typed("request_cancelled"));
  assert.equal(claims, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cache").get()?.n, 0);
  await assert.rejects(requestProviderText("vercel", "https://fixture.invalid", { signal: controller.signal }, { scheduler }), typed("request_cancelled"));
  assert.equal(claims, 1);
});

test("429 header persists cooldown before slow body settles; block failure cancels unread response", async t => {
  const { db } = fixture(t);
  const real = new SharedProviderRequestScheduler(db, "digitalplat");
  let blocked!: () => void;
  const entered = new Promise<void>(resolve => { blocked = resolve; });
  const scheduler = { acquire: (ms: number) => real.acquire(ms), block: async (ms: number) => { await real.block(ms); blocked(); } };
  let calls = 0;
  let cancelled = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Uint8Array.of(123)); }, cancel() { cancelled++; } }),
      { status: 429, headers: { "Retry-After": "3" } });
  };
  const first = requestProviderText("digitalplat", "https://fixture.invalid", {}, { scheduler, timeoutMs: 100 });
  const checked = assert.rejects(first, typed("request_timeout"));
  await entered;
  await assert.rejects(requestProviderText("digitalplat", "https://fixture.invalid", {}, { scheduler }), typed("scheduler_cooldown"));
  assert.equal(calls, 1);
  await checked;
  assert.equal(cancelled, 1);
  const failure = new ProviderApiError("digitalplat", 502, "scheduler_unavailable", "fixture");
  await assert.rejects(requestProviderText("digitalplat", "https://fixture.invalid", {}, {
    scheduler: { acquire: async () => ({ release: async () => {} }), block: async () => { throw failure; } },
  }), error => error === failure);
  assert.equal(cancelled, 2);
});

for (const provider of transportProviders) {
  test(`${provider}: real client shares permits, preserves empty response and releases on success`, async t => {
    const { db, sqlite } = fixture(t);
    const scheduler = new SharedProviderRequestScheduler(db, provider);
    const a = await scheduler.acquire(1000);
    const b = await new SharedProviderRequestScheduler(db, provider).acquire(1000);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json(transportEmptyDomains(provider)); };
    const client = () => transportFixture(provider, { scheduler: new SharedProviderRequestScheduler(db, provider) });
    await assert.rejects(client().read(), typed("scheduler_busy"));
    await assert.rejects(client().write(), typed("scheduler_busy"));
    assert.equal(calls, 0);
    await a.release();
    await b.release();
    await client().read();
    assert.equal(calls, 1);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cache").get()?.n, 0);
  });

  test(`${provider}: HTML/oversized/slow 429 bodies all block subsequent real clients before DNS write`, async t => {
    const { db, sqlite } = fixture(t);
    let calls = 0;
    let mode = "html";
    globalThis.fetch = async () => {
      calls++;
      const body = mode === "slow" ? new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Uint8Array.of(123)); } })
        : mode === "large" ? "x".repeat(301) : "<html>rate limited</html>";
      return new Response(body, { status: 429, headers: { "Retry-After": "3" } });
    };
    for (mode of ["html", "large", "slow"]) {
      const client = () => transportFixture(provider, { timeoutMs: 35, maxResponseBytes: 300,
        scheduler: new SharedProviderRequestScheduler(db, provider) });
      await assert.rejects(client().read(), error => error instanceof ProviderApiError && error.status === 429);
      const before = calls;
      await assert.rejects(client().write(), typed("scheduler_cooldown"));
      assert.equal(calls, before);
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cache WHERE key LIKE '%:slot:%'").get()?.n, 0);
      sqlite.exec("DELETE FROM cache");
    }
    assert.equal(calls, 3);
  });
}

test("DNSHE reset_at extends deployment cooldown and local saturation does not poison per-key cooldown", async t => {
  const { db } = fixture(t);
  const scheduler = new SharedProviderRequestScheduler(db, "dnshe");
  const blocks: number[] = [];
  const budget = { reserve: async () => {}, block: async (ms: number) => { blocks.push(ms); } };
  const a = await scheduler.acquire(1000);
  const b = await scheduler.acquire(1000);
  const client = new DNSHEClient("key", "secret", budget, { scheduler });
  await assert.rejects(client.getQuota(), typed("scheduler_busy"));
  assert.deepEqual(blocks, []);
  await a.release();
  await b.release();
  const reset = new Date(Date.now() + 120_000 + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
  globalThis.fetch = async () => Response.json({ success: false, error_code: "rate_limited", details: { reset_at: reset } },
    { status: 429, headers: { "Retry-After": "3" } });
  await assert.rejects(client.getQuota(), typed("rate_limited"));
  await assert.rejects(new SharedProviderRequestScheduler(db, "dnshe").acquire(1000), error => {
    typed("scheduler_cooldown")(error);
    assert.ok((error as ProviderApiError).retryAfterMs! > 115_000);
    return true;
  });
});

test("DNSHE invalid reset_at preserves upstream 429 and valid header cooldown", async t => {
  const { db, sqlite } = fixture(t);
  for (const reset_at of ["bad", "2026-99-99 00:00:00", "2027-02-31 00:00:00", "2027-01-01 24:00:00"]) {
    const blocks: number[] = [];
    const budget = { reserve: async () => {}, block: async (ms: number) => { blocks.push(ms); } };
    const scheduler = new SharedProviderRequestScheduler(db, "dnshe", () => 1000);
    globalThis.fetch = async () => Response.json({ success: false, error_code: "rate_limited", details: { reset_at } },
      { status: 429, headers: { "Retry-After": "3" } });
    await assert.rejects(new DNSHEClient("key", "secret", budget, { scheduler }).getQuota(), typed("rate_limited"));
    assert.deepEqual(blocks, [3000]);
    assert.equal(sqlite.prepare("SELECT value FROM cache").get()?.value, "4000");
    sqlite.exec("DELETE FROM cache");
  }
});

for (const { provider, code } of businessRateLimits) {
  test(`${provider}/${code}: real read/write retain upstream HTTP/code and share business cooldown before next credential`, async t => {
    const { db, sqlite } = fixture(t);
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json(transportErrorBody(provider, code, "fixture conflict; record set exists; quota; not authorized"), { headers: { "Retry-After": "3" } });
    };
    for (const write of [false, true]) {
      const client = () => transportFixture(provider, { scheduler: new SharedProviderRequestScheduler(db, provider, () => 1000) });
      const before = calls;
      await assert.rejects(write ? client().write() : client().read(), error => {
        typed(code)(error);
        const upstream = error as ProviderApiError;
        assert.equal(upstream.status, 200);
        assert.equal(upstream.statusCode, 429);
        assert.equal(upstream.rateLimited, true);
        assert.equal(upstream.retryAfterMs, 3000);
        if (provider !== "dnshe") assert.match(upstream.message, /被限流/);
        const details = upstream.details as { upstream_status: number; upstream_code: string; rate_limited: boolean };
        assert.equal(details.upstream_status, 200);
        assert.equal(details.upstream_code, code);
        assert.equal(details.rate_limited, true);
        if (provider === "huaweicloud") assert.ok(error instanceof HuaweiApiError);
        return true;
      });
      assert.equal(calls, before + 1, "neither DNS writes nor node probes may retry a business rate limit");
      assert.equal(sqlite.prepare("SELECT value FROM cache WHERE key LIKE '%:blocked'").get()?.value, "4000");
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cache WHERE key LIKE '%:slot:%'").get()?.n, 0);
      await assert.rejects(client().write(), typed("scheduler_cooldown"));
      assert.equal(calls, before + 1);
      sqlite.exec("DELETE FROM cache");
    }
    // Non-429 errors (e.g. Alidns 400) have the same panel semantics, not a forged upstream status.
    globalThis.fetch = async () => Response.json(transportErrorBody(provider, code), { status: 400 });
    await assert.rejects(transportFixture(provider).read(), error => {
      typed(code)(error);
      assert.equal((error as ProviderApiError).status, 400);
      assert.equal((error as ProviderApiError).statusCode, 429);
      assert.equal((error as ProviderApiError).retryAfterMs, 60_000);
      return true;
    });
  });
}

test("business recognition rejects quotas, locks, approximate codes, messages, arrays and malformed failure shells", async t => {
  fixture(t);
  const bodies: [string, unknown][] = [
    ["dnshe", { success: true, error_code: "rate_limit_exceeded" }],
    ["dnshe", { success: "false", error_code: "rate_limit_exceeded" }],
    ["dnshe", { error_code: "rate_limit_exceeded" }],
    ["dnshe", { success: false, error_code: "quota_exceeded" }],
    ["dnshe", { success: false, error_code: "rate_limited" }],
    ["dnshe", { success: false, error_code: "rate_limit_exceeded", message: [] }],
    ["dnspod", { Response: { Error: [{ Code: "RequestLimitExceeded" }] } }],
    ["dnspod", { Response: { Error: { Code: "RequestLimitExceeded.Unknown" } } }],
    ["dnspod", { Response: { Error: { Code: "LimitExceeded.DomainCountLimit" } } }],
    ["alidns", { Code: "Throttling.API", Message: "rate limited" }],
    ["alidns", { Code: "throttling" }],
    ["alidns", { Code: "QuotaExceeded" }],
    ["huaweicloud", { error_code: "DNS.0021", error_msg: "too many requests" }],
    ["huaweicloud", { error_code: "DNS.0403" }],
    ["huaweicloud", { error_code: "APIGW.0501" }],
    ["huaweicloud", { error_code: "APIGW.03080" }],
    ["vercel", { error: { code: "too_many_requests" } }],
    ["vercel", { error: [{ code: "rate_limited" }] }],
    ["vercel", { success: true, error: { code: "rate_limited" } }],
    ["cloudflare", { success: false, errors: [{ code: 1015 }] }],
    ["digitalplat", { success: false, error: { code: "rate_limited" } }],
  ];
  for (const { provider } of businessRateLimits) {
    bodies.push([provider, transportErrorBody(provider, "forbidden", "rate limit; too many requests; Throttling")]);
  }
  let blocks = 0;
  for (const [provider, body] of bodies) {
    const text = JSON.stringify(body);
    assert.equal(recognizeProviderRateLimit(provider, text), undefined, `${provider} ${text}`);
    globalThis.fetch = async () => new Response(text);
    const response = await requestProviderText(provider, "https://fixture.invalid", {}, {
      scheduler: { acquire: async () => ({ release: async () => {} }), block: async () => { blocks++; } },
    });
    assert.equal(response.rateLimited, false);
  }
  for (const text of ["<html>Throttling</html>", "{\"Code\":\"Throttling\"", "[]", "null",
    "<Error><Code>Throttling</Code>", "<Error><Code>Throttling</Code><Code>Throttling.User</Code></Error>",
    "<!DOCTYPE Error><Error><Code>Throttling</Code></Error>",
    "<DescribeDomainsResponse><Code>Throttling</Code></DescribeDomainsResponse>",
    "<Response><Code>Throttling</Code></Response>"]) {
    assert.equal(recognizeProviderRateLimit("alidns", text), undefined, text);
  }
  assert.equal(blocks, 0);
});

test("Alidns documented throttling XML retains code/status and enters shared cooldown", async t => {
  const { db, sqlite } = fixture(t);
  for (const code of ["Throttling", "Throttling.User"]) {
    globalThis.fetch = async () => new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>try later &amp; wait</Message></Error>`, { status: 400 });
    await assert.rejects(transportFixture("alidns", { scheduler: new SharedProviderRequestScheduler(db, "alidns", () => 1000) }).read(), error => {
      typed(code)(error);
      assert.equal((error as ProviderApiError).status, 400);
      assert.equal((error as ProviderApiError).statusCode, 429);
      return true;
    });
    assert.equal(sqlite.prepare("SELECT value FROM cache").get()?.value, "61000");
    sqlite.exec("DELETE FROM cache");
  }
});

test("Vercel legal reset/resetMs extend header/default cooldown; malformed resets cannot poison state", async t => {
  const { db, sqlite } = fixture(t);
  const now = Date.now();
  const resets = [
    { resetMs: now + 120_000 }, { reset: Math.ceil((now + 120_000) / 1000) },
    { resetMs: now + 120_000, reset: Math.ceil((now + 180_000) / 1000) },
    { resetMs: "9999999999999", reset: -1 }, { resetMs: 1.5, reset: Number.MAX_SAFE_INTEGER },
    { resetMs: now - 1000 },
  ];
  for (const [index, limit] of resets.entries()) {
    globalThis.fetch = async () => Response.json({ error: { code: "rate_limited", limit } }, { headers: { "Retry-After": "3" } });
    await assert.rejects(transportFixture("vercel", { scheduler: new SharedProviderRequestScheduler(db, "vercel") }).read(), error => {
      typed("rate_limited")(error);
      const delay = (error as ProviderApiError).retryAfterMs!;
      if (index < 3) assert.ok(delay > (index === 2 ? 175_000 : 115_000));
      else assert.equal(delay, 3000);
      return true;
    });
    assert.ok(Number.isSafeInteger(Number(sqlite.prepare("SELECT value FROM cache").get()?.value)));
    sqlite.exec("DELETE FROM cache");
  }
  for (const header of [undefined, "bad", "0"]) {
    globalThis.fetch = async () => Response.json({ error: { code: "rate_limited" } }, { headers: header ? { "Retry-After": header } : undefined });
    await assert.rejects(transportFixture("vercel").read(), error => {
      assert.equal((error as ProviderApiError).retryAfterMs, header === "0" ? 1000 : 60_000);
      return true;
    });
  }
});

test("DNSHE business reset cools the Key and deployment; quotas at HTTP 200 do neither", async t => {
  const { db, sqlite } = fixture(t);
  const blocks: number[] = [];
  const budget = { reserve: async () => {}, block: async (ms: number) => { blocks.push(ms); } };
  const reset = new Date(Date.now() + 120_000 + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
  globalThis.fetch = async () => Response.json({ success: false, error_code: "rate_limit_exceeded", details: { reset_at: reset } }, { headers: { "Retry-After": "3" } });
  await assert.rejects(new DNSHEClient("key", "secret", budget, { scheduler: new SharedProviderRequestScheduler(db, "dnshe") }).getQuota(), typed("rate_limit_exceeded"));
  assert.ok(blocks[0] > 115_000);
  await assert.rejects(new SharedProviderRequestScheduler(db, "dnshe").acquire(1000), typed("scheduler_cooldown"));
  sqlite.exec("DELETE FROM cache");
  blocks.length = 0;
  globalThis.fetch = async () => Response.json({ success: false, error_code: "quota_exceeded", details: { reset_at: reset } });
  await assert.rejects(new DNSHEClient("key", "secret", budget, { scheduler: new SharedProviderRequestScheduler(db, "dnshe") }).getQuota(), error => {
    typed("quota_exceeded")(error);
    assert.equal((error as ProviderApiError).statusCode, 502);
    assert.equal((error as ProviderApiError).rateLimited, false);
    return true;
  });
  assert.deepEqual(blocks, []);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cache").get()?.n, 0);
});

test("business cooldown is written before permit release; a slow/failed block respects transport deadline and uncertainty", async t => {
  fixture(t);
  const order: string[] = [];
  globalThis.fetch = async () => Response.json({ error: { code: "rate_limited" } });
  await assert.rejects(transportFixture("vercel", { scheduler: {
    acquire: async () => ({ release: async () => { order.push("release"); } }),
    block: async () => { order.push("block"); },
  } }).write(), typed("rate_limited"));
  assert.deepEqual(order, ["block", "release"]);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  await assert.rejects(transportFixture("vercel", { timeoutMs: 25, scheduler: {
    acquire: async () => ({ release: async () => {} }), block: () => pending,
  } }).write(), error => {
    typed("request_timeout")(error);
    assert.equal((error as ProviderApiError).status, 200);
    assert.equal((error as ProviderApiError).statusCode, 429);
    assert.match(String(error), /写入结果可能尚未确认/);
    return true;
  });
  finish(); // Settling the DB write cannot turn the already-rejected request into success.
});

test("business cooldown DB write failure preserves scheduler uncertainty, never a false successful cooldown", async t => {
  const { db, sqlite } = fixture(t);
  sqlite.exec(`CREATE TRIGGER deny_business_block BEFORE INSERT ON cache WHEN NEW.key LIKE '%:blocked'
    BEGIN SELECT RAISE(ABORT, 'secret-business-sql'); END`);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: { code: "rate_limited" } }); };
  await assert.rejects(transportFixture("vercel", { scheduler: new SharedProviderRequestScheduler(db, "vercel") }).write(), error => {
    typed("scheduler_unavailable")(error);
    assert.equal((error as ProviderApiError).statusCode, 502);
    assert.match(String(error), /可能已发送/);
    assert.equal(String(error).includes("secret-business-sql"), false);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cache").get()?.n, 0);
});

test("Huawei detail fallback and automatic node probing do not swallow confirmed business throttling", async t => {
  fixture(t);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error_code: "APIGW.0308", error_msg: "The API does not exist or has not been published in the environment." });
  };
  const client = new HuaweiCloudClient("business-fixture", "secret");
  await assert.rejects(client.listDomains(), typed("APIGW.0308"));
  assert.equal(calls, 1);
  await assert.rejects(client.getRecordSetById("zone-1", "rr-1"), typed("APIGW.0308"));
  assert.equal(calls, 2);
});

test("unread, truncated, oversized or bad UTF-8 business bodies cannot trigger cooldown by their prefix", async t => {
  fixture(t);
  let blocks = 0;
  const scheduler = { acquire: async () => ({ release: async () => {} }), block: async () => { blocks++; } };
  const prefix = '{"error":{"code":"rate_limited"';
  const cases = [
    { code: "request_timeout", reply: () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(prefix)); } })) },
    { code: "non_json_response", reply: () => new Response(prefix) },
    { code: "response_too_large", reply: () => new Response(prefix + "x".repeat(300)) },
    { code: "invalid_response", reply: () => new Response(new Uint8Array([...new TextEncoder().encode(prefix), 0xff])) },
  ];
  for (const { code, reply } of cases) {
    globalThis.fetch = async () => reply();
    await assert.rejects(transportFixture("vercel", { timeoutMs: 25, maxResponseBytes: 300, scheduler }).write(), error => {
      typed(code)(error);
      assert.equal((error as ProviderApiError).rateLimited, false);
      assert.equal((error as ProviderApiError).statusCode, 502);
      return true;
    });
  }
  assert.equal(blocks, 0);
});

test("DNSHE malformed business reset_at uses only legal Retry-After and never NaN", async t => {
  const { db, sqlite } = fixture(t);
  for (const reset_at of ["bad", "2026-99-99 00:00:00", "2027-02-31 00:00:00", "2027-01-01 24:00:00", 123]) {
    const blocks: number[] = [];
    const budget = { reserve: async () => {}, block: async (ms: number) => { blocks.push(ms); } };
    globalThis.fetch = async () => Response.json({ success: false, error_code: "rate_limit_exceeded", details: { reset_at } }, { headers: { "Retry-After": "3" } });
    await assert.rejects(new DNSHEClient("key", "secret", budget, { scheduler: new SharedProviderRequestScheduler(db, "dnshe", () => 1000) }).getQuota(), error => {
      typed("rate_limit_exceeded")(error);
      assert.equal((error as ProviderApiError).status, 200);
      assert.equal((error as ProviderApiError).retryAfterMs, 3000);
      return true;
    });
    assert.deepEqual(blocks, [3000]);
    assert.equal(sqlite.prepare("SELECT value FROM cache").get()?.value, "4000");
    sqlite.exec("DELETE FROM cache");
  }
});
