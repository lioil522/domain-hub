import "../helpers/block-outbound";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createD1FromSqlite, type SqliteDatabase } from "../../server/d1-sqlite";
import { DatabaseManager } from "../../src/db";
import { LEGACY_TABLE_SCHEMA } from "../../src/db/legacy-schema";
import { SYNC_TASK_SCHEMA } from "../../src/db/sync-task-schema";
import { AUTOMATION_SCHEMA } from "../../src/db/automation-schema";
import { InvocationBudget } from "../../src/services/invocation-budget";
import { withBudgetD1 } from "../../src/db/budget-d1";
import { encryptText, decryptText, hashPassword } from "../../src/db/crypto";
import { runHttpInvocation } from "../../src/index";
import { deferred } from "../helpers/coordination-fault";

const schema = readFileSync("schema.sql", "utf8");
const legacy = schema.slice(0, schema.indexOf("-- 10."));
const aes = "schema-bootstrap-offline-test-aes-not-live";
const context = { waitUntil() { throw new Error("No bootstrap background work"); },
  passThroughOnException() { throw new Error("No fail-open bootstrap"); }, props: {} } as ExecutionContext;
const extraIndexes = new Set(["idx_domains_account", "idx_domains_expires", "idx_logs_created", "idx_cache_expires"]);
function definitions(sqlite: DatabaseSync) {
  return sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all()
    .filter(row => !extraIndexes.has(String(row.name)))
    .map(row => ({ ...row, sql: String(row.sql).replace(/--[^\r\n]*/g, "").replace(/\s+/g, "").replace(/;$/, "") }));
}
function state(sqlite: DatabaseSync) {
  const schemaRows = sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all();
  const rows = Object.fromEntries(schemaRows.filter(row => row.type === "table").map(row =>
    [String(row.name), JSON.stringify(sqlite.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all())]));
  const sequences = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()
    ? JSON.stringify(sqlite.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name").all()) : null;
  return { schema: JSON.stringify(schemaRows), rows, sequences };
}
function fixture(t: TestContext, initial = "") {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys=ON"); if (initial) sqlite.exec(initial);
  const batches: string[][] = [], calls: string[] = [];
  let active: string[] | undefined;
  const control: { failSql?: string; failBatch?: number; corrupt?: (results: D1Result<unknown>[]) => D1Result<unknown>[];
    loseWriteResponse?: boolean; gate?: ReturnType<typeof deferred>; entered?: ReturnType<typeof deferred> } = {};
  const adapter: SqliteDatabase = { exec: sql => sqlite.exec(sql), prepare: sql => {
    const statement = sqlite.prepare(sql);
    const record = <T>(operation: () => T): T => {
      calls.push(sql); active?.push(sql);
      if (control.failSql && sql.includes(control.failSql)) throw new Error("Injected offline SQL failure");
      return operation();
    };
    return { all: (...args) => record(() => statement.all(...args as SQLInputValue[])),
      get: (...args) => record(() => statement.get(...args as SQLInputValue[])),
      run: (...args) => record(() => statement.run(...args as SQLInputValue[])) };
  } };
  const raw = createD1FromSqlite(adapter);
  const db: D1Database = { prepare: sql => raw.prepare(sql), exec: sql => raw.exec(sql), dump: () => raw.dump(),
    withSession: constraint => raw.withSession(constraint),
    batch: async <T>(entries: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      const group: string[] = []; batches.push(group);
      control.entered?.resolve();
      if (control.gate) { const gate = control.gate; control.gate = undefined; await gate.promise; }
      if (control.failBatch === batches.length) throw new Error("Injected offline D1 failure");
      active = group;
      let results: D1Result<T>[];
      try { results = await raw.batch<T>(entries); } finally { active = undefined; }
      if (control.loseWriteResponse && group.some(sql => /^\s*(CREATE|ALTER|INSERT)/.test(sql))) {
        control.loseWriteResponse = false; throw new Error("Injected lost committed response");
      }
      return control.corrupt ? control.corrupt(results) as D1Result<T>[] : results;
    } };
  return { sqlite, db, batches, calls, control };
}
const manager = (db: D1Database, d1 = 40) => {
  const budget = new InvocationBudget({ d1 });
  return { manager: new DatabaseManager(withBudgetD1(db, budget), aes), budget };
};
const status = (db: D1Database, budget = new InvocationBudget(), key = aes) =>
  runHttpInvocation(new Request("https://fixture.invalid/api/auth/status"), { DB: db, AES_KEY: key }, context, budget);
function oldestSchema() {
  return legacy.replace(/\r\n/g, "\n").replace(/^[ \t]*(provider|website|dns_provider|provider_account_id|remote_id) TEXT[^\n]*\n/gm, "")
    .replace(/(CREATE TABLE IF NOT EXISTS custom_domains \([\s\S]*?)\s+registered_at TEXT,[^\r\n]*[\r\n]+/, "$1\n");
}
async function seed(sqlite: DatabaseSync, count = 80) {
  const encrypted = await encryptText("offline-api-secret", aes), twoFa = await encryptText("JBSWY3DPEHPK3PXP", aes);
  const passSalt = "00112233445566778899aabbccddeeff", passHash = await hashPassword("offline-bootstrap-password", passSalt);
  sqlite.exec("BEGIN");
  try {
    const account = sqlite.prepare("INSERT INTO accounts(id,alias,api_key,api_secret) VALUES(?,'offline',?,?)");
    const domain = sqlite.prepare("INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at) VALUES(?,?,?,'example.test',?,'active','2027-01-01')");
    for (let id = 1; id <= count; id++) {
      account.run(id, `offline-${id}`, encrypted);
      for (let n = 0; n < 7; n++) domain.run(id * 100 + n, id, `d${n}`, `a${id}-d${n}.example.test`);
    }
    sqlite.prepare("INSERT INTO settings(key,value) VALUES('auth_username','offline'),('auth_pass_hash',?),('auth_pass_salt',?),('auth_2fa_enabled','1'),('auth_2fa_secret',?),('auth_initialized','1')").run(passHash, passSalt, twoFa);
    sqlite.exec("INSERT INTO settings(key,value) VALUES('sess_offline','9999999999'),('login_fail:offline','1'); INSERT INTO cache VALUES('offline:checkpoint','retain',9999999999); INSERT INTO logs(type,category,message) VALUES('info','offline','retain'); INSERT INTO actions(id,type,status) VALUES('offline-action','sync','partial'); INSERT INTO scanner_jobs(id,status,cursor) VALUES('offline-job','paused','{}'); INSERT INTO audit_logs(actor,action,resource_type,result) VALUES('offline','test','offline','ok'); INSERT INTO domain_date_overrides(account_id,full_domain,source) VALUES(1,'offline.example.test','offline'); INSERT INTO custom_accounts(id,group_id,name) VALUES(1,1,'offline'); INSERT INTO custom_domains(group_id,account_id,full_domain,expires_at) VALUES(1,1,'custom.example.test','2027-01-01')");
    sqlite.exec("COMMIT");
  } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  return { encrypted, twoFa };
}

test("empty bootstrap matches independent schema.sql tables, indexes, triggers and constraints", async t => {
  const f = fixture(t), expected = fixture(t, schema);
  const m = manager(f.db);
  assert.equal(await m.manager.ensureTables(), true);
  assert.deepEqual(definitions(f.sqlite), definitions(expected.sqlite));
  assert.equal(Object.keys(state(f.sqlite).rows).length, 20);
  assert.deepEqual(f.batches.map(group => group.length), [4, 33]);
  assert.deepEqual(m.budget.snapshot().used, { d1: 2, external: 0 });
  assert.equal(f.calls.filter(sql => /ALTER TABLE/.test(sql)).length, 0);
  assert.equal(f.sqlite.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
  assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("80 x 7 legacy migration skips 11 no-op CREATEs and preserves every row, credential and sequence", async t => {
  const f = fixture(t, legacy), ciphertexts = await seed(f.sqlite), before = state(f.sqlite);
  const m = manager(f.db);
  assert.equal(await m.manager.ensureTables(), true);
  const after = state(f.sqlite);
  for (const [name, rows] of Object.entries(before.rows)) assert.equal(after.rows[name], rows, name);
  assert.equal(after.sequences, before.sequences);
  assert.deepEqual(f.batches.map(group => group.length), [4, 22]);
  assert.deepEqual(f.batches[1], [...SYNC_TASK_SCHEMA, ...AUTOMATION_SCHEMA]);
  assert.equal(await decryptText(ciphertexts.encrypted, aes), "offline-api-secret");
  assert.equal(await decryptText(ciphertexts.twoFa, aes), "JBSWY3DPEHPK3PXP");
  assert.equal((await m.manager.getAuthConfig()).twoFaSecret, "JBSWY3DPEHPK3PXP");
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM accounts").get()!.n, 80);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM domains_cache").get()!.n, 560);
  assert.equal(f.sqlite.prepare("SELECT version FROM domain_mutation_clock").get()!.version, 0);
  assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("six oldest-schema column additions are atomic and retain legacy values and AUTOINCREMENT", async t => {
  const f = fixture(t, oldestSchema()); await seed(f.sqlite, 2);
  const before = state(f.sqlite), account = f.sqlite.prepare("SELECT * FROM accounts ORDER BY id").all();
  const m = manager(f.db);
  assert.equal(await m.manager.ensureTables(), true);
  assert.deepEqual(f.batches.map(group => group.length), [4, 28]);
  assert.equal(f.calls.filter(sql => /^ALTER TABLE/.test(sql)).length, 6);
  for (const original of account) {
    const row = f.sqlite.prepare("SELECT * FROM accounts WHERE id=?").get(original.id as number)!;
    for (const key of Object.keys(original)) assert.equal(row[key], original[key]);
    assert.equal(row.provider, "dnshe"); assert.equal(row.website, null);
  }
  assert.equal(state(f.sqlite).sequences, before.sequences);
  for (const name of ["cache", "settings", "logs", "audit_logs", "actions", "scanner_jobs"]) assert.equal(state(f.sqlite).rows[name], before.rows[name]);
  assert.equal(f.sqlite.prepare("SELECT version FROM domain_mutation_clock").get()!.version, 0);
  assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("partially provisioned schemas create missing tables without ALTERing newly created columns", async t => {
  for (const names of [["accounts"], ["domains_cache"], ["custom_domains"], ["accounts", "custom_accounts", "settings"]]) {
    const initial = LEGACY_TABLE_SCHEMA.filter(table => names.includes(table.name)).map(table => table.sql).join("\n");
    const f = fixture(t, initial), m = manager(f.db);
    assert.equal(await m.manager.ensureTables(), true);
    assert.equal(Object.keys(state(f.sqlite).rows).length, 20);
    assert.equal(f.calls.filter(sql => /ALTER TABLE/.test(sql)).length, 0);
    assert.equal(f.batches[1].length, 33 - names.length);
  }
});

test("fully migrated schemas still run all additive definitions and preserve a nonzero mutation clock", async t => {
  const f = fixture(t, schema); await seed(f.sqlite, 1);
  const before = state(f.sqlite), m = manager(f.db);
  assert.equal(await m.manager.ensureTables(), true);
  assert.equal(await m.manager.ensureTables(), true);
  assert.deepEqual(state(f.sqlite), before);
  assert.deepEqual(f.batches.map(group => group.length), [4, 22, 4, 22]);
  assert.deepEqual(f.batches[1], [...SYNC_TASK_SCHEMA, ...AUTOMATION_SCHEMA]);
  assert.ok(Number(f.sqlite.prepare("SELECT version FROM domain_mutation_clock").get()!.version) > 0);
});

test("all missing additive objects and the clock initializer are repaired, not hidden by a ready marker", async t => {
  const f = fixture(t, schema);
  f.sqlite.exec("DROP TRIGGER domain_mutation_update; DROP INDEX idx_domains_expiry; DROP TABLE reminder_deliveries; DELETE FROM domain_mutation_clock; INSERT INTO settings(key,value) VALUES('schema_ready','1')");
  assert.equal(await manager(f.db).manager.ensureTables(), true);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('domain_mutation_update','idx_domains_expiry','reminder_deliveries')").get()!.n, 3);
  assert.equal(f.sqlite.prepare("SELECT version FROM domain_mutation_clock").get()!.version, 0);
  assert.equal(f.sqlite.prepare("SELECT value FROM settings WHERE key='schema_ready'").get()!.value, "1");
});

test("late SQL failure rolls back every CREATE/ALTER and clock write, then retry succeeds", async t => {
  t.mock.method(console, "error", () => {});
  for (const initial of ["", oldestSchema()]) {
    const f = fixture(t, initial); if (initial) await seed(f.sqlite, 1);
    const before = state(f.sqlite); f.control.failSql = "idx_domains_expiry";
    assert.equal(await manager(f.db).manager.ensureTables(), false);
    assert.deepEqual(state(f.sqlite), before);
    f.control.failSql = undefined;
    assert.equal(await manager(f.db).manager.ensureTables(), true);
    assert.equal(Object.keys(state(f.sqlite).rows).length, 20);
  }
});

test("inspection failure and malformed/truncated metadata never dispatch writes", async t => {
  t.mock.method(console, "error", () => {});
  const changes = [
    (results: D1Result<unknown>[]) => results.slice(0, 3),
    (results: D1Result<unknown>[]) => results.map((r, i) => i === 1 ? { ...r, success: false as true } : r),
    (results: D1Result<unknown>[]) => results.map((r, i) => i === 1 ? { ...r, results: undefined as unknown as unknown[] } : r),
    (results: D1Result<unknown>[]) => results.map((r, i) => i === 1 ? { ...r, results: [] } : r),
    (results: D1Result<unknown>[]) => results.map((r, i) => i === 1 ? { ...r, results: [{ name: 1 }] } : r),
    (results: D1Result<unknown>[]) => results.map((r, i) => i === 0 ? { ...r, results: [{ name: "accounts", type: "view" }] } : r),
    (results: D1Result<unknown>[]) => results.map((r, i) => i === 0 ? { ...r, results: [{ name: "unexpected", type: "table" }] } : r),
  ];
  for (const corrupt of changes) {
    const f = fixture(t, legacy), before = state(f.sqlite); f.control.corrupt = corrupt;
    assert.equal(await manager(f.db).manager.ensureTables(), false);
    assert.equal(f.batches.length, 1); assert.deepEqual(state(f.sqlite), before);
  }
  const f = fixture(t, legacy); f.control.failBatch = 1;
  assert.equal(await manager(f.db).manager.ensureTables(), false); assert.equal(f.calls.length, 0);
});

test("wrong-type base schema objects fail closed without replacing them", async t => {
  t.mock.method(console, "error", () => {});
  const f = fixture(t, "CREATE VIEW accounts AS SELECT 1 AS id"), before = state(f.sqlite);
  assert.equal(await manager(f.db).manager.ensureTables(), false);
  assert.deepEqual(state(f.sqlite), before); assert.equal(f.batches.length, 1);
});

test("SQLite case-insensitive table/column identifiers retain compatibility", async t => {
  const f = fixture(t, legacy.replace(/\baccounts\b/g, "ACCOUNTS").replace(/\bprovider\b/g, "PROVIDER"));
  assert.equal(await manager(f.db).manager.ensureTables(), true);
  assert.equal(f.calls.filter(sql => /ALTER TABLE/.test(sql)).length, 0);
});

test("0/1-call and closed budgets cannot write; two calls complete the migration", async t => {
  t.mock.method(console, "error", () => {});
  for (const limit of [0, 1]) {
    const f = fixture(t, legacy), before = state(f.sqlite), m = manager(f.db, limit);
    assert.equal(await m.manager.ensureTables(), false); assert.deepEqual(state(f.sqlite), before);
    assert.equal(m.budget.snapshot().used.d1, limit); assert.equal(f.batches.length, limit);
  }
  const f = fixture(t, legacy), closed = manager(f.db); closed.budget.close();
  assert.equal(await closed.manager.ensureTables(), false); assert.equal(f.batches.length, 0);
  const fresh = manager(f.db, 2); assert.equal(await fresh.manager.ensureTables(), true);
  assert.deepEqual(fresh.budget.snapshot().used, { d1: 2, external: 0 });
});

test("migration failure stays HTTP 503 before auth/business reads and can retry on the same identity", async t => {
  t.mock.method(console, "error", () => {});
  const f = fixture(t, legacy); f.control.failSql = "idx_domains_expiry";
  const failedBudget = new InvocationBudget(), failed = await status(f.db, failedBudget);
  assert.equal(failed.status, 503); assert.equal((await failed.json()).error_code, "storage_unavailable");
  assert.equal(f.calls.some(sql => /SELECT.*FROM settings/.test(sql)), false);
  f.control.failSql = undefined; const nextBudget = new InvocationBudget(), next = await status(f.db, nextBudget);
  assert.equal(next.status, 200); assert.deepEqual(nextBudget.snapshot().used, { d1: 3, external: 0 });
});

test("lost committed response or incomplete write metadata never caches readiness", async t => {
  t.mock.method(console, "error", () => {});
  for (const mode of ["lost", "truncated"]) {
    const f = fixture(t, legacy);
    if (mode === "lost") f.control.loseWriteResponse = true;
    else f.control.corrupt = results => f.batches.length === 2 ? results.slice(0, -1) : results;
    const response = await status(f.db); assert.equal(response.status, 503);
    assert.equal(f.calls.some(sql => /SELECT.*FROM settings/.test(sql)), false);
    assert.equal(Object.keys(state(f.sqlite).rows).length, 20, "commit may have completed, but readiness is unknown");
    const afterCommit = state(f.sqlite); f.control.corrupt = undefined;
    const retry = await status(f.db); assert.equal(retry.status, 200); assert.deepEqual(state(f.sqlite), afterCommit);
    assert.equal(f.batches.length, 4, "retry must inspect and execute full additive schema again");
  }
});

test("HTTP raw-identity cache deduplicates concurrent bootstrap without sharing budgets or databases", async t => {
  const f = fixture(t, legacy), gate = deferred(); f.control.gate = gate;
  const entered = deferred(); f.control.entered = entered; t.after(() => gate.resolve());
  const a = new InvocationBudget(), b = new InvocationBudget();
  const first = status(f.db, a), second = status(f.db, b);
  await entered.promise;
  assert.equal(f.batches.length, 1); gate.resolve();
  const responses = await Promise.all([first, second]); responses.forEach(r => assert.equal(r.status, 200));
  assert.equal(f.batches.length, 2); assert.deepEqual(a.snapshot().used, { d1: 3, external: 0 });
  assert.deepEqual(b.snapshot().used, { d1: 1, external: 0 });
  const warmBudget = new InvocationBudget(); assert.equal((await status(f.db, warmBudget)).status, 200);
  assert.deepEqual(warmBudget.snapshot().used, { d1: 1, external: 0 }); assert.equal(f.batches.length, 2);
  const other = fixture(t, legacy), otherBudget = new InvocationBudget();
  assert.equal((await status(other.db, otherBudget)).status, 200); assert.equal(other.batches.length, 2);
  assert.deepEqual(otherBudget.snapshot().used, { d1: 3, external: 0 });
});

test("HTTP status preserves 2FA fail-closed decryption and unauthorized routes remain protected", async t => {
  const f = fixture(t, legacy); await seed(f.sqlite, 1);
  const budget = new InvocationBudget(), result = await status(f.db, budget);
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { success: true, initialized: true, two_fa_enabled: true });
  assert.deepEqual(budget.snapshot().used, { d1: 3, external: 0 });
  const migrated = state(f.sqlite), wrong = await status(f.db, new InvocationBudget(), "offline-wrong-aes");
  assert.equal(wrong.status, 503); assert.equal((await wrong.json()).error_code, "auth_storage_unavailable");
  const unauthorizedBudget = new InvocationBudget(), unauthorized = await runHttpInvocation(
    new Request("https://fixture.invalid/api/accounts"), { DB: f.db, AES_KEY: aes }, context, unauthorizedBudget);
  assert.equal(unauthorized.status, 401); assert.equal(unauthorizedBudget.snapshot().used.external, 0);
  assert.deepEqual(state(f.sqlite), migrated);
  assert.equal(f.calls.some(sql => /SELECT.*FROM (accounts|domains_cache)/.test(sql)), false);
});
