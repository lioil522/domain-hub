import "../helpers/block-outbound";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createD1FromSqlite } from "../../server/d1-sqlite";
import { databaseBudget, databaseIdentity, withBudgetD1 } from "../../src/db/budget-d1";
import { InvocationBudget, InvocationBudgetError } from "../../src/services/invocation-budget";
import { invocationFetch } from "../../src/services/invocation-fetch";
import { requestProviderText } from "../../src/providers/provider-request";
import { DnsheAccountRequestScheduler } from "../../src/services/dnshe-account-scheduler";
import { ProviderApiError } from "../../src/errors/provider-api-error";
import { runHttpInvocation, runScheduledInvocation } from "../../src/index";
import { deferred } from "../helpers/coordination-fault";

const blocked = globalThis.fetch;
const context = { waitUntil: () => { throw new Error("Unexpected background task"); }, passThroughOnException() {}, props: {} } as ExecutionContext;

test("budgets are independent, bounded and validate configuration", () => {
  for (const value of [-1, NaN, Infinity, 1.1]) assert.throws(() => new InvocationBudget({ d1: value }));
  const budget = new InvocationBudget({ d1: 2, external: 1 });
  budget.consume("external");
  assert.throws(() => budget.consume("external"), InvocationBudgetError);
  budget.consume("d1", 2);
  assert.throws(() => budget.consume("d1"), InvocationBudgetError);
  assert.deepEqual(budget.snapshot().used, { d1: 2, external: 1 });
  assert.deepEqual(new InvocationBudget().snapshot().used, { d1: 0, external: 0 });
});

test("budget errors retain immutable resource accounting through request outcome annotation", () => {
  const budget = new InvocationBudget({ d1: 5 });
  budget.consume("d1", 2);
  const tail = budget.reserve({ d1: 3 });
  let failure: InvocationBudgetError | undefined;
  try { budget.consume("d1"); } catch (error) { assert.ok(error instanceof InvocationBudgetError); failure = error; }
  assert.ok(failure);
  tail.consume("d1"); tail.release();
  assert.deepEqual(failure.withRequestOutcome(false).details, {
    resource: "d1", reason: "exhausted", used: 2, reserved: 3, limit: 5, remaining: 0, requested: 1, request_sent: false,
  });
  assert.equal(budget.snapshot().used.d1, 3);
});

test("reservation exhaustion is distinguished from the parent invocation's remaining capacity", () => {
  const budget = new InvocationBudget({ d1: 5 }); const work = budget.reserve({ d1: 1 });
  assert.throws(() => work.consume("d1", 2), (error: unknown) => {
    assert.ok(error instanceof InvocationBudgetError);
    assert.deepEqual(error.details, { resource: "d1", reason: "exhausted", used: 0, reserved: 1, limit: 5, remaining: 4, requested: 2, reservation_remaining: 1 });
    return true;
  });
  assert.equal(budget.snapshot().used.d1, 0); work.release();
});

test("closed invocation diagnostics retain the requested operation cost", () => {
  const budget = new InvocationBudget({ d1: 5 }); budget.consume("d1"); budget.close();
  assert.throws(() => budget.consume("d1", 2), (error: unknown) => {
    assert.ok(error instanceof InvocationBudgetError);
    assert.deepEqual(error.details, { resource: "d1", reason: "closed", used: 1, reserved: 0, limit: 5, remaining: 4, requested: 2 });
    return true;
  });
});

test("prepaid slices cannot spend the reserved tail; releasing never refunds calls", () => {
  const budget = new InvocationBudget({ d1: 5, external: 1 });
  const tail = budget.reserve({ d1: 2 });
  const work = budget.reserve({ d1: 2, external: 1 });
  budget.consume("d1");
  assert.throws(() => budget.consume("d1"), InvocationBudgetError);
  work.consume("d1");
  work.consume("external");
  work.release();
  work.release();
  assert.throws(() => work.consume("d1"), InvocationBudgetError);
  budget.consume("d1");
  tail.consume("d1", 2);
  tail.release();
  assert.deepEqual(budget.snapshot().used, { d1: 5, external: 1 });
  assert.deepEqual(budget.snapshot().reserved, { d1: 0, external: 0 });
});

test("failed reservations are atomic; closed counters reject late dispatches", () => {
  const budget = new InvocationBudget({ d1: 2, external: 0 });
  assert.throws(() => budget.reserve({ d1: 2, external: 1 }), InvocationBudgetError);
  assert.deepEqual(budget.snapshot().reserved, { d1: 0, external: 0 });
  const slot = budget.reserve({ d1: 1 });
  budget.close();
  assert.throws(() => budget.consume("d1"), InvocationBudgetError);
  assert.throws(() => slot.consume("d1"), InvocationBudgetError);
  slot.release();
  assert.equal(budget.snapshot().used.d1, 0);
});

test("D1 counts execution only, retains overloads, immutable bind and single batch", async t => {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const raw = createD1FromSqlite(sqlite);
  const budget = new InvocationBudget({ d1: 20 });
  const db = withBudgetD1(raw, budget);
  const template = db.prepare("SELECT ? AS value");
  const one = template.bind(1), two = template.bind(2);
  assert.equal(budget.snapshot().used.d1, 0);
  assert.equal(await one.first<number>("value"), 1);
  assert.equal((await two.first<{ value: number }>())?.value, 2);
  assert.deepEqual(await one.raw({ columnNames: true }), [["value"], [1]]);
  assert.deepEqual(await two.raw(), [[2]]);
  assert.equal((await one.all()).results.length, 1);
  await db.exec("CREATE TABLE fixture(id INTEGER)");
  const result = await db.batch([db.prepare("INSERT INTO fixture VALUES(1)"), db.prepare("INSERT INTO fixture VALUES(2)")]);
  assert.equal(result.length, 2);
  assert.equal(budget.snapshot().used.d1, 7);
  assert.equal(databaseIdentity(db), raw);
  assert.equal(databaseBudget(db), budget);
  const fresh = new InvocationBudget();
  await withBudgetD1(db, fresh).prepare("SELECT 1").first();
  assert.equal(fresh.snapshot().used.d1, 1);
  assert.equal(budget.snapshot().used.d1, 7, "re-wrapping does not double count");
});

test("sessions share the invocation; mixed database/budget/raw batches fail before dispatch", async t => {
  const a = new DatabaseSync(":memory:"), b = new DatabaseSync(":memory:");
  t.after(() => { a.close(); b.close(); });
  const raw = createD1FromSqlite(a), budget = new InvocationBudget();
  const db = withBudgetD1(raw, budget), other = withBudgetD1(createD1FromSqlite(b), budget);
  const session = db.withSession("first-primary");
  assert.equal(session.getBookmark(), null);
  assert.equal(await session.prepare("SELECT 3 AS n").first<number>("n"), 3);
  await session.batch([session.prepare("SELECT 1"), db.prepare("SELECT 2")]);
  assert.equal(budget.snapshot().used.d1, 2);
  for (const stmt of [other.prepare("SELECT 1"), withBudgetD1(raw, new InvocationBudget()).prepare("SELECT 1"), raw.prepare("SELECT 1")]) {
    await assert.rejects(db.batch([stmt]), /Cross-database or cross-invocation/);
  }
  assert.equal(budget.snapshot().used.d1, 2);
});

test("D1 failures/unknown completions count once and exhaustion cannot execute SQL", async t => {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const raw = createD1FromSqlite(sqlite), budget = new InvocationBudget({ d1: 2 });
  const db = withBudgetD1(raw, budget);
  await assert.rejects(db.prepare("SELECT * FROM missing_table").first());
  await db.exec("CREATE TABLE safe(n INTEGER)");
  await assert.rejects(db.prepare("INSERT INTO safe VALUES(1)").run(), InvocationBudgetError);
  assert.equal((await raw.prepare("SELECT COUNT(*) AS n FROM safe").first<{ n: number }>())?.n, 0);
  assert.equal(budget.snapshot().used.d1, 2);
});

test("late SQL remains charged after caller scope closes; no new SQL can dispatch", async t => {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const raw = createD1FromSqlite(sqlite);
  const gate = deferred();
  const delayed: D1Database = { prepare: query => raw.prepare(query), batch: entries => raw.batch(entries),
    withSession: constraint => raw.withSession(constraint), dump: () => raw.dump(),
    exec: async query => { await gate.promise; return raw.exec(query); } };
  const budget = new InvocationBudget(), db = withBudgetD1(delayed, budget);
  const pending = db.exec("CREATE TABLE late_fixture(n INTEGER)");
  assert.equal(budget.snapshot().used.d1, 1);
  budget.close();
  await assert.rejects(db.prepare("SELECT 1").first(), InvocationBudgetError);
  gate.resolve();
  await pending;
  assert.equal(budget.snapshot().used.d1, 1);
  assert.ok(await raw.prepare("SELECT name FROM sqlite_master WHERE name='late_fixture'").first());
});

test("external attempts are charged on failure, not refunded, and cancelled-before-send uses none", async t => {
  t.after(() => { globalThis.fetch = blocked; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("offline failure"); };
  const budget = new InvocationBudget({ external: 1 });
  await assert.rejects(invocationFetch("https://fixture.invalid", {}, budget));
  await assert.rejects(invocationFetch("https://fixture.invalid", {}, budget), InvocationBudgetError);
  assert.equal(calls, 1);
  assert.equal(budget.snapshot().used.external, 1);
  const empty = new InvocationBudget();
  await assert.rejects(invocationFetch("https://fixture.invalid", { signal: AbortSignal.abort() }, empty));
  assert.equal(empty.snapshot().used.external, 0);
});

test("strict redirect hops count separately; cross-origin credentials are removed", async t => {
  t.after(() => { globalThis.fetch = blocked; });
  const calls: { url: string; headers: Headers }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { Location: "https://other.invalid/result" } }) : Response.json({ ok: true });
  };
  const budget = new InvocationBudget();
  await invocationFetch("https://first.invalid/start", { headers: { Authorization: "test-only", "X-API-Key": "test-key", Cookie: "test", Accept: "application/json" } }, budget);
  assert.equal(calls.length, 2);
  assert.equal(budget.snapshot().used.external, 2);
  assert.equal(calls[1].headers.get("authorization"), null);
  assert.equal(calls[1].headers.get("x-api-key"), null);
  assert.equal(calls[1].headers.get("cookie"), null);
  assert.equal(calls[1].headers.get("accept"), "application/json");
});

test("mutations never follow redirects; exhausted redirect chain cannot dispatch another hop", async t => {
  t.after(() => { globalThis.fetch = blocked; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 307, headers: { Location: "/next" } }); };
  const write = new InvocationBudget();
  await assert.rejects(invocationFetch("https://fixture.invalid", { method: "POST", body: "test" }, write), /写操作不会重复发送/);
  assert.equal(calls, 1);
  const read = new InvocationBudget({ external: 1 });
  await assert.rejects(invocationFetch("https://fixture.invalid", {}, read), InvocationBudgetError);
  assert.equal(calls, 2);
});

test("legacy observation is non-enforcing and explicitly not exact for hidden redirects", async t => {
  t.after(() => { globalThis.fetch = blocked; });
  globalThis.fetch = async () => Response.json({ ok: true });
  const budget = new InvocationBudget({ d1: 0, external: 0 }, false);
  budget.consume("d1", 50);
  await invocationFetch("https://fixture.invalid", {}, budget);
  assert.equal(budget.snapshot().strict, false);
  assert.equal(budget.snapshot().externalExact, false);
  assert.deepEqual(budget.snapshot().used, { d1: 50, external: 1 });
});

test("provider preserves budget errors and primary unknown write error on release failure", async t => {
  t.after(() => { globalThis.fetch = blocked; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unknown write outcome"); };
  await assert.rejects(requestProviderText("dnshe", "https://fixture.invalid", { method: "POST" }, { budget: new InvocationBudget({ external: 0 }) }), InvocationBudgetError);
  assert.equal(calls, 0);
  await assert.rejects(requestProviderText("dnshe", "https://fixture.invalid", { method: "POST" }, {
    budget: new InvocationBudget(), scheduler: {
      acquire: async () => ({ release: async () => { throw new InvocationBudgetError("d1"); } }), block: async () => {},
    },
  }), (error: unknown) => error instanceof ProviderApiError && error.error_code === "transport_error");
  assert.equal(calls, 1);
});

test("D1 exhaustion after dispatch must not claim that an upstream write was never sent", async t => {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  t.after(() => { globalThis.fetch = blocked; });
  sqlite.exec("CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER NOT NULL)");
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ success: true }); };
  const raw = createD1FromSqlite(sqlite), budget = new InvocationBudget({ d1: 8 });
  const scheduler = new DnsheAccountRequestScheduler(withBudgetD1(raw, budget), "offline-key");
  await assert.rejects(requestProviderText("dnshe", "https://fixture.invalid", { method: "POST" }, { budget, scheduler }),
    (error: unknown) => error instanceof InvocationBudgetError && (error.details as { request_sent: unknown }).request_sent === "unknown");
  assert.equal(calls, 1);
  assert.equal(budget.snapshot().used.d1, 8);
  assert.equal(budget.snapshot().used.external, 1);
});

test("DNSHE coordination exhaustion propagates without sending or clearing rolling history", async t => {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  sqlite.exec("CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER NOT NULL)");
  const raw = createD1FromSqlite(sqlite), budget = new InvocationBudget({ d1: 1 });
  await assert.rejects(new DnsheAccountRequestScheduler(withBudgetD1(raw, budget), "offline-key").acquire(100), InvocationBudgetError);
  assert.equal(budget.snapshot().used.d1, 1);
  assert.equal((await raw.prepare("SELECT COUNT(*) AS n FROM cache").first<{ n: number }>())?.n, 0);
});

test("production HTTP counts cold schema before auth and caches readiness by raw DB identity", async t => {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const raw = createD1FromSqlite(sqlite);
  const cold = new InvocationBudget();
  const response = await runHttpInvocation(new Request("https://fixture.invalid/api/accounts"), { DB: raw }, context, cold);
  assert.equal(response.status, 401);
  assert.equal(cold.snapshot().used.d1, 2, "schema inspection batch + atomic migration batch");
  const warm = new InvocationBudget();
  assert.equal((await runHttpInvocation(new Request("https://fixture.invalid/api/accounts"), { DB: raw }, context, warm)).status, 401);
  assert.equal(warm.snapshot().used.d1, 0, "a request wrapper must not re-run migrations");
  const sessionBudget = new InvocationBudget();
  const expired = await runHttpInvocation(new Request("https://fixture.invalid/api/accounts", { headers: { Authorization: "Bearer sess_offline-missing" } }), { DB: raw }, context, sessionBudget);
  assert.equal(expired.status, 401);
  assert.ok(sessionBudget.snapshot().used.d1 > 0, "authentication is not outside accounting");
});

test("production HTTP schema exhaustion fails closed and a new invocation retries readiness", async t => {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const raw = createD1FromSqlite(sqlite), budget = new InvocationBudget({ d1: 1 });
  assert.equal((await runHttpInvocation(new Request("https://fixture.invalid/api/accounts"), { DB: raw }, context, budget)).status, 503);
  assert.equal(budget.snapshot().used.d1, 1);
  const retry = new InvocationBudget();
  assert.equal((await runHttpInvocation(new Request("https://fixture.invalid/api/accounts"), { DB: raw }, context, retry)).status, 401);
  assert.equal(retry.snapshot().used.d1, 2);
});

test("production scheduled/Node shared pipeline accounts bootstrap, settings, candidates and logs", async t => {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const budget = new InvocationBudget();
  const result = await runScheduledInvocation({ DB: createD1FromSqlite(sqlite) }, budget);
  assert.equal(result.status, "completed");
  assert.ok(budget.snapshot().used.d1 > 5, "Cron accounting includes more than the schema");
  assert.equal(budget.snapshot().used.external, 0);
});
