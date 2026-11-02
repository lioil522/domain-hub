import "../helpers/block-outbound";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DNSHEClient } from "../../src/dnshe";
import { ProviderApiError } from "../../src/errors/provider-api-error";
import { fetchAllSubdomainsFromClient } from "../../src/cron/jobs/upstream-sync";
import { DatabaseSync } from "node:sqlite";
import { createD1FromSqlite } from "../../server/d1-sqlite";
import { DnsheRequestBudget } from "../../src/services/dnshe-request-budget";
import { coordinationFault, deferred } from "../helpers/coordination-fault";
import { sha256Hex } from "../../src/db/crypto";

const sub = (id: number) => ({ id, subdomain: `d${id}`, rootdomain: "example", full_domain: `d${id}.example`, status: "Registered" });

test("DNSHE offset pagination follows effective page size and nested metadata", async () => {
  const pages: number[] = [];
  const result = await fetchAllSubdomainsFromClient({ listSubdomains: async page => {
    pages.push(page);
    return { success: true, subdomains: page === 1 ? [sub(1), sub(2)] : [sub(3)],
      pagination: { page, per_page: 2, total: 3, has_more: page === 1, next_page: 2 } };
  } });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.length, 3);
});

test("repeated or contradictory offset pages fail instead of yielding a destructive snapshot", async () => {
  await assert.rejects(fetchAllSubdomainsFromClient({ listSubdomains: async page => ({ success: true,
    subdomains: [sub(1)], pagination: { page, has_more: true, next_page: page + 1 } }) }), ProviderApiError);
  await assert.rejects(fetchAllSubdomainsFromClient({ listSubdomains: async () => ({ success: true,
    subdomains: [], pagination: { has_more: false, total: 3 } }) }), ProviderApiError);
});

test("page-budget exhaustion cannot masquerade as complete", async () => {
  let calls = 0;
  await assert.rejects(fetchAllSubdomainsFromClient({ listSubdomains: async page => {
    calls++;
    return { success: true, subdomains: [sub(page)], pagination: { page, has_more: true, next_page: page + 1 } };
  } }), ProviderApiError);
  assert.equal(calls, 50);
});

test("DNS cursor pages are merged before returning success", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const cursors: string[] = [];
  globalThis.fetch = async input => {
    const cursor = new URL(String(input)).searchParams.get("cursor")!;
    cursors.push(cursor);
    return Response.json({ success: true, records: [{ id: cursor === "0" ? 1 : 2, type: "TXT", content: "test" }],
      pagination: { cursor, per_page: 1, has_more: cursor === "0", next_cursor: cursor === "0" ? "1" : null } });
  };
  const result = await new DNSHEClient("fixture", "fixture").listDnsRecords(1);
  assert.deepEqual(cursors, ["0", "1"]);
  assert.equal(result.records?.length, 2);
  assert.equal(result.complete, true);
});

test("repeated DNS cursor and failure on a later page never return partial success", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ success: true, records: [{ id: 1 }], pagination: { has_more: true, next_cursor: 0 } });
  await assert.rejects(new DNSHEClient("fixture", "fixture").listDnsRecords(1), ProviderApiError);
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? Response.json({ success: true, records: [{ id: 1 }], pagination: { has_more: true, next_cursor: 1 } })
    : Response.json({ success: false, message: "temporary error" }, { status: 503 });
  await assert.rejects(new DNSHEClient("fixture", "fixture").listDnsRecords(1), ProviderApiError);
  assert.equal(calls, 2);
});

test("HTML, business failures and renewal-window errors retain provider status; writes are not retried", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const client = new DNSHEClient("fixture", "fixture");
  globalThis.fetch = async () => new Response("<html>forbidden</html>", { status: 403 });
  await assert.rejects(client.getQuota(), e => e instanceof ProviderApiError && e.status === 403 && e.error_code === "non_json_response");
  globalThis.fetch = async () => Response.json({ success: false, message: "business error", error_code: "business_failure" });
  await assert.rejects(client.getQuota(), e => e instanceof ProviderApiError && e.error_code === "business_failure");
  let writes = 0;
  globalThis.fetch = async () => { writes++; return Response.json({ success: false, error_code: "renewal_not_yet_available", message: "尚未进入续期窗口" }, { status: 422 }); };
  await assert.rejects(client.renewSubdomain(1), e => e instanceof ProviderApiError && e.status === 422 && e.error_code === "renewal_not_yet_available");
  assert.equal(writes, 1);
});

test("per-key request budget is shared across client instances and cooldowns", async t => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER NOT NULL)");
  const d1 = createD1FromSqlite(sqlite);
  const waits: number[] = [];
  const make = (key: string) => new DnsheRequestBudget(d1, key, 2100, () => 1000, async ms => { waits.push(ms); });
  const one = make("same-key");
  const two = make("same-key");
  await one.reserve();
  await two.reserve();
  assert.deepEqual(waits, [2100]);
  await assert.rejects(one.reserve(), e => e instanceof ProviderApiError && e.status === 429);
  await make("other-key").reserve();
  await one.block(60_000);
  await assert.rejects(two.reserve(), e => e instanceof ProviderApiError && e.retryAfterMs === 60_000);
  assert.equal((await d1.prepare("SELECT key FROM cache").all()).results.some(row => String(row.key).includes("same-key")), false);
});

for (const phase of ["reservation", "pending", "check"] as const) {
  test(`DNSHE ${phase} DB deadline: typed failure, no upstream and no continuation after late SQL`, async t => {
    const sqlite = new DatabaseSync(":memory:");
    t.after(() => sqlite.close());
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    sqlite.exec("CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER NOT NULL)");
    const db = createD1FromSqlite(sqlite);
    const key = `dnshe_budget:${await sha256Hex("fixture-key")}`;
    if (phase === "pending") sqlite.prepare("INSERT INTO cache VALUES(?, '10000', 3600)").run(key);
    if (phase === "check") sqlite.prepare("INSERT INTO cache VALUES(?, '3100', 3600)").run(key);
    const gate = deferred();
    let reads = 0;
    let waits = 0;
    const slow = coordinationFault(db, (sql, _method, execute) => {
      const target = phase === "reservation" ? sql.startsWith("INSERT") : sql.startsWith("SELECT");
      if (sql.startsWith("SELECT")) reads++;
      return target ? gate.promise.then(() => execute()) : execute();
    });
    const budget = new DnsheRequestBudget(slow, "fixture-key", 2100, () => 1000, async () => { waits++; }, 30);
    globalThis.fetch = async () => { assert.fail("failed budget coordination must not send"); };
    await assert.rejects(new DNSHEClient("fixture-key", "fixture-secret", budget).registerSubdomain("demo", "example"), error => {
      assert.ok(error instanceof ProviderApiError);
      assert.equal(error.error_code, "budget_timeout");
      const details = error.details as { details: { scope: string; request_sent: boolean; coordination_operation: string } };
      assert.equal(details.details.scope, "dnshe_key");
      assert.equal(details.details.request_sent, false);
      assert.equal(details.details.coordination_operation, phase === "check" ? "check" : "reserve");
      return true;
    });
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(reads, phase === "reservation" ? 0 : 1);
    assert.equal(waits, phase === "check" ? 1 : 0);
  });
}

test("DNSHE hung/late cooldown batch and verification reads share bounded coordination, preserve primary unread error", async t => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  sqlite.exec("CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER NOT NULL)");
  const db = createD1FromSqlite(sqlite);
  for (const phase of ["batch", "verify", "unread"]) {
    const gate = deferred();
    let reads = 0;
    const slow = coordinationFault(db, (sql, method, execute) => {
      if (phase === "verify" && sql.startsWith("SELECT") && ++reads > 1) return gate.promise.then(() => execute());
      if (phase !== "verify" && method === "batch") return gate.promise.then(() => execute());
      return execute();
    });
    let now = 1000;
    const budget = new DnsheRequestBudget(slow, "fixture-key", 2100, () => now, async () => {}, 30);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return phase === "unread" ? new Response("<html>rate limit</html>", { status: 429 })
      : Response.json({ success: false, error_code: "rate_limit_exceeded" }); };
    await assert.rejects(new DNSHEClient("fixture-key", "secret", budget).registerSubdomain("demo", "example"), error => {
      assert.ok(error instanceof ProviderApiError);
      assert.equal(error.error_code, phase === "unread" ? "non_json_response" : "budget_timeout");
      if (phase !== "unread") {
        const details = error.details as { details: { request_sent: string; cooldown_persisted: string } };
        assert.equal(details.details.request_sent, "unknown");
        assert.equal(details.details.cooldown_persisted, "unknown");
      }
      return true;
    });
    assert.equal(calls, 1);
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    now = 100_000;
    await budget.reserve(); // Late block cannot turn the old failure into success; eventual budget remains usable.
    sqlite.exec("DELETE FROM cache");
  }
});

test("DNSHE corrupt coordination and rejected/unsuccessful DB operations fail closed without SQL/Key leakage", async t => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER NOT NULL)");
  const db = createD1FromSqlite(sqlite);
  const key = `dnshe_budget:${await sha256Hex("secret-key")}`;
  const budget = new DnsheRequestBudget(db, "secret-key", 2100, () => 1000, async () => {});
  for (const value of ["", "bad", "1e4", "-1", "9007199254740992", "3100.1", "3100.00", ".0", "3100.0.0"]) {
    sqlite.prepare("INSERT OR REPLACE INTO cache VALUES(?, ?, 3600)").run(key, value);
    for (const operation of [() => budget.reserve(), () => budget.block(3000)]) await assert.rejects(operation(), error => {
      assert.ok(error instanceof ProviderApiError);
      assert.equal(error.error_code, "budget_unavailable");
      assert.equal(String(error).includes("secret-key"), false);
      return true;
    });
    assert.equal(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key)?.value, value);
  }
  sqlite.exec("DELETE FROM cache");
  sqlite.prepare("INSERT INTO cache VALUES(?, 'bad', 3600)").run(`${key}:blocked`);
  await assert.rejects(budget.reserve(), error => error instanceof ProviderApiError && error.error_code === "budget_unavailable");
  const rejected = coordinationFault(db, async () => { throw new Error("secret-sql-key"); });
  await assert.rejects(new DnsheRequestBudget(rejected, "secret-key").reserve(), error => {
    assert.ok(error instanceof ProviderApiError);
    assert.equal(error.error_code, "budget_unavailable");
    assert.equal(String(error).includes("secret-sql-key"), false);
    return true;
  });
  for (const delay of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(budget.block(delay), error => error instanceof ProviderApiError && error.error_code === "budget_unavailable");
  }
  const unsuccessful = coordinationFault(db, async (_sql, method, execute) => method === "batch" ? [{ success: false }, { success: true }] : execute());
  await assert.rejects(new DnsheRequestBudget(unsuccessful, "secret-key").block(3000), error => error instanceof ProviderApiError && error.error_code === "budget_unavailable");
});

test("DNSHE legacy SQLite integer .0 budgets stay usable and new reservations write canonical integers", async t => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER NOT NULL)");
  const db = createD1FromSqlite(sqlite);
  const key = `dnshe_budget:${await sha256Hex("legacy-key")}`;
  sqlite.prepare("INSERT INTO cache VALUES(?, '3100.0', 3600)").run(key);
  const waits: number[] = [];
  const budget = new DnsheRequestBudget(db, "legacy-key", 2100, () => 1000, async ms => { waits.push(ms); });
  await budget.reserve();
  assert.deepEqual(waits, [2100]);
  assert.equal(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key)?.value, "5200");
  sqlite.prepare("INSERT INTO cache VALUES(?, '61000.0', 3600)").run(`${key}:blocked`);
  await budget.block(3000);
  assert.equal(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(`${key}:blocked`)?.value, "61000");
  await assert.rejects(budget.reserve(), error => error instanceof ProviderApiError && error.status === 429);
});
