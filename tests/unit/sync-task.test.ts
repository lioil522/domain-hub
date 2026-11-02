import "../helpers/block-outbound";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync, unlinkSync, rmdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createD1FromSqlite } from "../../server/d1-sqlite";
import { DatabaseManager } from "../../src/db";
import { SYNC_TASK_SCHEMA } from "../../src/db/sync-task-schema";
import { AUTOMATION_SCHEMA } from "../../src/db/automation-schema";
import { InvocationBudget, InvocationBudgetError } from "../../src/services/invocation-budget";
import { withBudgetD1 } from "../../src/db/budget-d1";
import { createSyncTask, getSyncTask, readSyncScope, claimSyncTask, commitSyncSlice, syncFence, cancelSyncTask, parseSyncTask, purgeSyncHistory } from "../../src/db/dao/sync-task-dao";
import { AppError } from "../../src/errors";
import { deferred, coordinationFault } from "../helpers/coordination-fault";
import { maintainSyncHistory, SYNC_HISTORY_CONFIRMATION } from "../../src/services/sync-history-service";
import { sqlProbe } from "../helpers/sync-scale";

const schema = readFileSync("schema.sql", "utf8");
const fragment = { kind: "list" as const, shard: "zones", page: 1, payload: '[{"id":"a"}]' };
const items = [{ kind: "seen" as const, domain_id: "a" }, { kind: "candidate" as const, domain_id: "b", baseline: '{"updated_at":"original"}' }];
const code = (value: string) => (error: unknown) => error instanceof AppError && error.code === value;
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  sqlite.exec(schema);
  sqlite.exec("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'offline','offline-key','offline-secret','cloudflare')");
  return { sqlite, db: createD1FromSqlite(sqlite) };
}
async function task(db: D1Database, id = "task-a", generation = "generation-a") {
  assert.equal(await createSyncTask(db, { id, generation, accountId: 1, provider: "cloudflare", revision: 1, mode: "full" }), true);
  const row = await getSyncTask(db, id); assert.ok(row);
  return row;
}
async function held(db: D1Database) {
  const claim = await claimSyncTask(db, await task(db), "owner-a"); assert.ok(claim);
  return claim;
}

test("schema.sql and runtime migration definitions are equivalent and additive", async t => {
  const a = new DatabaseSync(":memory:"), b = new DatabaseSync(":memory:"); t.after(() => { a.close(); b.close(); });
  a.exec(schema);
  b.exec(schema.slice(0, schema.indexOf("-- 10.")));
  for (const sql of SYNC_TASK_SCHEMA) b.exec(sql);
  for (const sql of AUTOMATION_SCHEMA) b.exec(sql);
  const definitions = (db: DatabaseSync) => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'sync_%' OR name LIKE 'idx_sync_%' OR name LIKE 'account_sync_%' ORDER BY name").all()
    .map(row => ({ ...row, sql: String(row.sql).replace(/\s+/g, " ").replace(/;$/, "").trim() }));
  assert.deepEqual(definitions(a), definitions(b));
});

test("ensureTables is idempotent and preserves legacy rows, credentials and checkpoints", async t => {
  const { db, sqlite } = fixture(t);
  sqlite.exec("INSERT INTO cache VALUES('scanner:original','checkpoint',9999999999); INSERT INTO actions(id,type,status) VALUES('original','sync','partial')");
  const before = ["accounts", "cache", "actions"].map(table => JSON.stringify(sqlite.prepare(`SELECT * FROM ${table}`).all()));
  const manager = new DatabaseManager(db, "offline-aes");
  assert.equal(await manager.ensureTables(), true);
  assert.equal(await manager.ensureTables(), true);
  const after = ["accounts", "cache", "actions"].map(table => JSON.stringify(sqlite.prepare(`SELECT * FROM ${table}`).all()));
  assert.deepEqual(after, before);
  assert.equal((await readSyncScope(db, 1))?.revision, 1);
});

test("one active task per account/mode; duplicate starts do not overwrite a generation", async t => {
  const { db } = fixture(t);
  const original = await task(db);
  assert.equal(await createSyncTask(db, { id: "task-b", generation: "generation-b", accountId: 1, provider: "cloudflare", revision: 1, mode: "full" }), false);
  assert.deepEqual(await getSyncTask(db, original.id), original);
  assert.equal(await createSyncTask(db, { id: "task-list", generation: "list", accountId: 1, provider: "cloudflare", revision: 1, mode: "list" }), true);
  assert.equal(await createSyncTask(db, { id: "missing", generation: "missing", accountId: 2, provider: "cloudflare", revision: 1, mode: "full" }), false);
});

test("claim uses DB time and version fencing, never a supplied host clock", async t => {
  const { db, sqlite } = fixture(t);
  const row = await task(db), claim = await claimSyncTask(db, row, "owner-a"); assert.ok(claim);
  const dbNow = (sqlite.prepare("SELECT CAST(strftime('%s','now') AS INTEGER) AS n").get() as { n: number }).n;
  assert.equal(claim.lease_until, dbNow + 120);
  assert.equal(claim.version, row.version + 1);
  assert.equal(await claimSyncTask(db, row, "owner-b"), null);
  assert.equal(await claimSyncTask(db, claim, "owner-b"), null);
});

test("slice stores bounded fragments/seen/candidates atomically with cursor and releases owner", async t => {
  const { db, sqlite } = fixture(t);
  const claim = await held(db), budget = new InvocationBudget({ d1: 1 });
  await commitSyncSlice(withBudgetD1(db, budget), syncFence(claim), { phase: "list", cursor: '{"page":2}' }, [fragment], items);
  const saved = await getSyncTask(db, claim.id); assert.ok(saved);
  assert.equal(saved.cursor, '{"page":2}'); assert.equal(saved.version, claim.version + 1);
  assert.equal(saved.status, "queued"); assert.equal(saved.owner, null); assert.equal(saved.lease_until, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sync_fragments").get()?.n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sync_items").get()?.n, 2);
  assert.equal(budget.snapshot().used.d1, 1, "one physical D1 batch despite several statements");
  await assert.rejects(commitSyncSlice(db, syncFence(claim), { phase: "list", cursor: '{"page":3}' }, [{ ...fragment, payload: "[]" }]), code("sync_fence_lost"));
  assert.equal(sqlite.prepare("SELECT payload FROM sync_fragments").get()?.payload, fragment.payload);
});

test("old owner/generation/scope cannot store fragments or advance a cursor", async t => {
  const { db, sqlite } = fixture(t);
  const claim = await held(db);
  for (const patch of [{ owner: "other" }, { generation: "other" }, { scope_revision: 2 }, { version: claim.version + 1 }]) {
    await assert.rejects(commitSyncSlice(db, { ...syncFence(claim), ...patch }, { phase: "list", cursor: '{"page":2}' }, [fragment], items), code("sync_fence_lost"));
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sync_fragments").get()?.n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sync_items").get()?.n, 0);
  assert.equal((await getSyncTask(db, claim.id))?.cursor, "{}");
});

test("expired owner cannot commit even before a new runner claims", async t => {
  const { db, sqlite } = fixture(t), claim = await held(db);
  sqlite.exec("UPDATE sync_tasks SET lease_until=1");
  await assert.rejects(commitSyncSlice(db, syncFence(claim), { phase: "list", cursor: "{}" }, [fragment]), code("sync_fence_lost"));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sync_fragments").get()?.n, 0);
});

test("batch SQL failure rolls back fragments, items and cursor together", async t => {
  const { db, sqlite } = fixture(t), claim = await held(db);
  sqlite.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON sync_items BEGIN SELECT RAISE(ABORT,'offline failure'); END");
  await assert.rejects(commitSyncSlice(db, syncFence(claim), { phase: "list", cursor: '{"page":2}' }, [fragment], items), /offline failure/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sync_fragments").get()?.n, 0);
  assert.equal((await getSyncTask(db, claim.id))?.cursor, "{}");
});

test("unknown successful commit is not retried; authoritative state disambiguates next invocation", async t => {
  const { db, sqlite } = fixture(t), claim = await held(db);
  let calls = 0;
  const unknown: D1Database = { prepare: q => db.prepare(q), exec: q => db.exec(q), dump: () => db.dump(), withSession: c => db.withSession(c),
    batch: async entries => { calls++; await db.batch(entries); throw new Error("unknown commit"); } };
  await assert.rejects(commitSyncSlice(unknown, syncFence(claim), { phase: "list", cursor: '{"page":2}' }, [fragment]), /unknown commit/);
  assert.equal(calls, 1);
  assert.equal((await getSyncTask(db, claim.id))?.cursor, '{"page":2}');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sync_fragments").get()?.n, 1);
});

test("budget exhaustion before batch preserves the old cursor and storage", async t => {
  const { db, sqlite } = fixture(t), claim = await held(db);
  await assert.rejects(commitSyncSlice(withBudgetD1(db, new InvocationBudget({ d1: 0 })), syncFence(claim), { phase: "list", cursor: '{"page":2}' }, [fragment]), InvocationBudgetError);
  assert.equal((await getSyncTask(db, claim.id))?.cursor, "{}");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sync_fragments").get()?.n, 0);
});

test("credential writes invalidate tasks atomically; aliases and same-value writes do not", async t => {
  const { db, sqlite } = fixture(t), claim = await held(db);
  sqlite.exec("UPDATE accounts SET alias='renamed',api_secret=api_secret WHERE id=1");
  assert.equal((await readSyncScope(db, 1))?.revision, 1);
  assert.equal((await getSyncTask(db, claim.id))?.status, "running");
  sqlite.exec("UPDATE accounts SET api_secret='changed' WHERE id=1");
  assert.equal((await readSyncScope(db, 1))?.revision, 2);
  assert.equal((await getSyncTask(db, claim.id))?.status, "invalidated");
  await assert.rejects(commitSyncSlice(db, syncFence(claim), { phase: "list", cursor: "{}" }, [fragment]), code("sync_fence_lost"));
  assert.equal(await createSyncTask(db, { id: "stale", generation: "stale", accountId: 1, provider: "cloudflare", revision: 1, mode: "full" }), false);
  assert.equal(await createSyncTask(db, { id: "fresh", generation: "fresh", accountId: 1, provider: "cloudflare", revision: 2, mode: "full" }), true);
});

test("phase progression disallows premature completion; completed freshness is server time", async t => {
  const { db } = fixture(t), claim = await held(db);
  await assert.rejects(commitSyncSlice(db, syncFence(claim), { phase: "done", cursor: "{}", status: "completed" }), code("sync_state_invalid"));
  await commitSyncSlice(db, syncFence(claim), { phase: "cleanup", cursor: "{}" });
  const row = await getSyncTask(db, claim.id); assert.ok(row);
  const cleanup = await claimSyncTask(db, row, "cleanup-owner"); assert.ok(cleanup);
  await assert.rejects(commitSyncSlice(db, syncFence(cleanup), { phase: "list", cursor: "{}" }), code("sync_state_invalid"));
  await commitSyncSlice(db, syncFence(cleanup), { phase: "done", cursor: "{}", status: "completed" });
  const complete = await getSyncTask(db, claim.id); assert.ok(complete);
  assert.equal(complete.status, "completed"); assert.ok(complete.last_completed_at);
  assert.equal(await claimSyncTask(db, complete, "again"), null);
});

test("paused retry, blocked and explicit cancellation do not silently resume", async t => {
  const { db } = fixture(t), claim = await held(db);
  await commitSyncSlice(db, syncFence(claim), { phase: "list", cursor: "{}", status: "paused", retryAfterSeconds: 60, error: "offline cooldown" });
  const paused = await getSyncTask(db, claim.id); assert.ok(paused);
  assert.equal(await claimSyncTask(db, paused, "again"), null);
  assert.equal(await cancelSyncTask(db, paused), true);
  const cancelled = await getSyncTask(db, claim.id); assert.ok(cancelled);
  assert.equal(await claimSyncTask(db, cancelled, "again"), null);
  assert.equal(await cancelSyncTask(db, paused), false);
});

test("corrupt cursor/owner and oversized slices fail closed without dispatch", async t => {
  const { db, sqlite } = fixture(t), claim = await held(db);
  for (const patch of [{ cursor: "broken" }, { cursor: "[]" }, { version: NaN }, { owner: null }]) assert.throws(() => parseSyncTask({ ...claim, ...patch }), code("sync_state_invalid"));
  await assert.rejects(commitSyncSlice(db, syncFence(claim), { phase: "list", cursor: "{}" }, Array.from({ length: 101 }, () => fragment)), code("sync_state_invalid"));
  await assert.rejects(commitSyncSlice(db, syncFence(claim), { phase: "list", cursor: "{}" }, [{ ...fragment, payload: JSON.stringify("汉".repeat(12000)) }]), code("sync_state_invalid"));
  sqlite.exec("PRAGMA ignore_check_constraints=ON; UPDATE sync_tasks SET cursor='broken'");
  await assert.rejects(getSyncTask(db, claim.id), code("sync_state_invalid"));
  await assert.rejects(commitSyncSlice(db, syncFence(claim), { phase: "list", cursor: "{}" }, [fragment]), code("sync_fence_lost"));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sync_fragments").get()?.n, 0);
});

test("account deletion cascades only its new coordination data", async t => {
  const { db, sqlite } = fixture(t), claim = await held(db);
  await commitSyncSlice(db, syncFence(claim), { phase: "list", cursor: "{}" }, [fragment], items);
  sqlite.exec("DELETE FROM accounts WHERE id=1");
  for (const table of ["account_sync_versions", "sync_tasks", "sync_fragments", "sync_items"]) assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0);
});

test("two SQLite connections fence late owners after lease takeover", async t => {
  const base = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Temp", "opencode") : tmpdir();
  const directory = mkdtempSync(join(base, "sync-task-"));
  const file = join(directory, "fixture.db");
  const a = new DatabaseSync(file), b = new DatabaseSync(file);
  t.after(() => {
    a.close(); b.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) if (existsSync(file + suffix)) unlinkSync(file + suffix);
    rmdirSync(directory);
  });
  a.exec(schema); a.exec("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'offline','key','secret','cloudflare')");
  const first = createD1FromSqlite(a), second = createD1FromSqlite(b), old = await held(first);
  b.exec("UPDATE sync_tasks SET lease_until=1");
  const state = await getSyncTask(second, old.id); assert.ok(state);
  const next = await claimSyncTask(second, state, "new-owner"); assert.ok(next);
  await assert.rejects(commitSyncSlice(first, syncFence(old), { phase: "list", cursor: '{"old":true}' }, [fragment]), code("sync_fence_lost"));
  await commitSyncSlice(second, syncFence(next), { phase: "list", cursor: '{"page":2}' }, [fragment]);
  assert.equal((await getSyncTask(first, old.id))?.cursor, '{"page":2}');
});

test("a delayed batch released after lease takeover cannot write or advance old state", async t => {
  const { db, sqlite } = fixture(t), old = await held(db), gate = deferred();
  const delayed: D1Database = { prepare: q => db.prepare(q), exec: q => db.exec(q), dump: () => db.dump(), withSession: c => db.withSession(c),
    batch: async entries => { await gate.promise; return db.batch(entries); } };
  const budget = new InvocationBudget();
  const pending = commitSyncSlice(withBudgetD1(delayed, budget), syncFence(old), { phase: "list", cursor: '{"old":true}' }, [fragment]);
  const rejected = assert.rejects(pending, code("sync_fence_lost"));
  assert.equal(budget.snapshot().used.d1, 1);
  sqlite.exec("UPDATE sync_tasks SET lease_until=1");
  const state = await getSyncTask(db, old.id); assert.ok(state);
  const next = await claimSyncTask(db, state, "next-owner"); assert.ok(next);
  gate.resolve();
  await rejected;
  assert.equal((await getSyncTask(db, old.id))?.owner, "next-owner");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sync_fragments").get()?.n, 0);
  assert.equal(budget.snapshot().used.d1, 1);
});

test("history cleanup bounds row deletions and never purges active generations or legacy cache", async t => {
  const { db, sqlite } = fixture(t), claim = await held(db);
  await commitSyncSlice(db, syncFence(claim), { phase: "list", cursor: "{}" },
    [fragment, { ...fragment, page: 2 }, { ...fragment, page: 3 }], items);
  const row = await getSyncTask(db, claim.id); assert.ok(row);
  assert.equal(await cancelSyncTask(db, row), true);
  sqlite.exec("UPDATE sync_tasks SET updated_at=1; INSERT INTO cache VALUES('legacy-checkpoint','keep',9999999999)");
  await task(db, "active", "active-generation");
  assert.equal(await purgeSyncHistory(db, 60, 1), 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sync_fragments").get()?.n, 2);
  assert.equal((await getSyncTask(db, "active"))?.status, "queued");
  await purgeSyncHistory(db, 60, 1);
  await purgeSyncHistory(db, 60, 1);
  assert.equal(await getSyncTask(db, claim.id), null);
  assert.equal(sqlite.prepare("SELECT value FROM cache WHERE key='legacy-checkpoint'").get()?.value, "keep");
});

function historyRow(sqlite: DatabaseSync, id: string, options: { created?: number; completed?: number | null; status?: string; mode?: string } = {}) {
  const status = options.status ?? "completed";
  sqlite.prepare(`INSERT INTO sync_tasks(id,generation,account_id,provider,scope_revision,mode,phase,status,last_completed_at,created_at,updated_at)
    VALUES(?, ?, 1,'cloudflare',1,?,?,?, ?, ?,1)`)
    .run(id, `gen-${id}`, options.mode ?? "full", status === "completed" ? "done" : "list", status, options.completed === undefined ? 100 : options.completed, options.created ?? 100);
}

test("history retention protects latest created-time task despite out-of-order imported rowids", async t => {
  const { db, sqlite } = fixture(t);
  historyRow(sqlite, "latest", { created: 200, completed: 200 });
  historyRow(sqlite, "imported-older", { created: 100, completed: 100 });
  await purgeSyncHistory(db, 60);
  assert.ok(await getSyncTask(db, "latest")); assert.equal(await getSyncTask(db, "imported-older"), null);
});

test("history retention keeps latest actual completion and freshness anchor after a failed newer task", async t => {
  const { db, sqlite } = fixture(t);
  historyRow(sqlite, "success", { created: 100, completed: 500 });
  historyRow(sqlite, "failed", { created: 200, completed: 500, status: "cancelled" });
  historyRow(sqlite, "obsolete", { created: 50, completed: 100 });
  await purgeSyncHistory(db, 60);
  assert.ok(await getSyncTask(db, "success")); assert.ok(await getSyncTask(db, "failed"));
  assert.equal(await getSyncTask(db, "obsolete"), null);
  assert.equal(await createSyncTask(db, { id: "next", generation: "next", accountId: 1, provider: "cloudflare", revision: 1, mode: "full" }), true);
  assert.equal((await getSyncTask(db, "next"))!.last_completed_at, 500);
});

test("history retention isolates account/mode and uses rowid only as a timestamp tie-break", async t => {
  const { db, sqlite } = fixture(t);
  historyRow(sqlite, "old-tie", { created: 100, completed: 100 }); historyRow(sqlite, "new-tie", { created: 100, completed: 100 });
  historyRow(sqlite, "list-only", { created: 50, completed: 50, mode: "list" });
  sqlite.exec("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(2,'other','other','secret','cloudflare')");
  sqlite.exec("INSERT INTO sync_tasks(id,generation,account_id,provider,scope_revision,mode,phase,status,last_completed_at,created_at,updated_at) VALUES('account2-only','other',2,'cloudflare',1,'full','done','completed',100,200,1)");
  await purgeSyncHistory(db, 60);
  assert.equal(await getSyncTask(db, "old-tie"), null);
  for (const id of ["new-tie", "list-only", "account2-only"]) assert.ok(await getSyncTask(db, id));
});

test("history retention leaves blocked, queued, paused, running, damaged and recent generations untouched", async t => {
  const { db, sqlite } = fixture(t);
  for (const [n, status] of ["blocked", "queued", "paused", "running"].entries()) {
    const mode = n % 2 ? "list" : "full";
    // One active task per account/mode; use independent synthetic accounts.
    sqlite.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(?,'offline',?,'secret','cloudflare')").run(n + 2, `offline-${n}`);
    sqlite.prepare(`INSERT INTO sync_tasks(id,generation,account_id,provider,scope_revision,mode,status,owner,lease_until,created_at,updated_at)
      VALUES(?, 'active',?,'cloudflare',1,?,?,?, ?,1,1)`).run(status, n + 2, mode, status, status === "running" ? "owner" : null, status === "running" ? 9999999999 : 0);
    sqlite.prepare(`INSERT INTO sync_tasks(id,generation,account_id,provider,scope_revision,mode,phase,status,last_completed_at,created_at,updated_at)
      VALUES(?, 'newer',?,'cloudflare',1,?,'done','completed',100,2,1)`).run(`newer-${status}`, n + 2, mode);
  }
  historyRow(sqlite, "bad-owner", { created: 1 }); historyRow(sqlite, "bad-cursor", { created: 2 }); historyRow(sqlite, "recent", { created: 3 }); historyRow(sqlite, "latest", { created: 4, completed: 200 });
  sqlite.exec("PRAGMA ignore_check_constraints=ON; UPDATE sync_tasks SET owner='stale',lease_until=9999999999 WHERE id='bad-owner'; UPDATE sync_tasks SET cursor='broken' WHERE id='bad-cursor'; UPDATE sync_tasks SET updated_at=CAST(strftime('%s','now') AS INTEGER) WHERE id='recent'");
  const before = JSON.stringify(sqlite.prepare("SELECT * FROM sync_tasks ORDER BY id").all());
  assert.equal(await purgeSyncHistory(db, 60), 0);
  assert.equal(JSON.stringify(sqlite.prepare("SELECT * FROM sync_tasks ORDER BY id").all()), before);
});

function stagedHistory(sqlite: DatabaseSync, count = 205) {
  historyRow(sqlite, "obsolete", { created: 100 }); historyRow(sqlite, "latest", { created: 200, completed: 200 });
  const fragment = sqlite.prepare("INSERT INTO sync_fragments(task_id,generation,kind,shard,page,payload) VALUES('obsolete','gen-obsolete','dns','offline',?,'[]')");
  const item = sqlite.prepare("INSERT INTO sync_items(task_id,generation,kind,domain_id,baseline) VALUES('obsolete','gen-obsolete','seen',?,'{}')");
  for (let n = 0; n < count; n++) { fragment.run(n); item.run(String(n)); }
}

test("history service defaults to a bounded read-only sample and rejects unsafe options before dispatch", async t => {
  const { db, sqlite } = fixture(t); stagedHistory(sqlite);
  const before = Number(sqlite.prepare("SELECT total_changes() AS n").get()!.n);
  const budget = new InvocationBudget();
  const manager = new DatabaseManager(withBudgetD1(db, budget));
  const preview = await maintainSyncHistory(manager);
  assert.equal(preview.dryRun, true); assert.deepEqual(preview.sample, { candidateTasks: 1, fragments: 100, items: 100 });
  assert.deepEqual(preview.deleted, { fragments: 0, items: 0, tasks: 0 }); assert.equal(preview.hasCandidates, true);
  assert.equal(Number(sqlite.prepare("SELECT total_changes() AS n").get()!.n), before);
  assert.deepEqual(budget.snapshot().used, { d1: 1, external: 0 });
  for (const body of [null, [], true, { dryRun: false }, { dryRun: "false" }, { dryRun: null }, { retentionDays: 29 }, { retentionDays: 3651 },
    { retentionDays: "30" }, { retentionDays: 30.5 }, { retentionDays: null }, { limit: 0 }, { limit: 101 }, { limit: null }, { confirm: "wrong" }, { unexpected: true }]) {
    await assert.rejects(maintainSyncHistory(manager, body), code("bad_request"));
  }
  assert.equal(budget.snapshot().used.d1, 1);
});

test("history service drains children in bounded atomic slices and does not touch business state", async t => {
  const { db, sqlite } = fixture(t); stagedHistory(sqlite);
  sqlite.exec("INSERT INTO cache VALUES('legacy-checkpoint','keep',9999999999); INSERT INTO actions(id,type,status) VALUES('obsolete','sync','completed'); INSERT INTO logs(type,category,message) VALUES('success','sync','original success')");
  const tables = ["accounts", "account_sync_versions", "domains_cache", "domain_mutations", "cache", "actions", "renewal_intents", "settings"];
  const before = tables.map(table => JSON.stringify(sqlite.prepare(`SELECT * FROM ${table}`).all()));
  for (let n = 0; n < 3; n++) {
    const budget = new InvocationBudget(), manager = new DatabaseManager(withBudgetD1(db, budget));
    const result = await maintainSyncHistory(manager, { dryRun: false, confirm: SYNC_HISTORY_CONFIRMATION });
    assert.deepEqual(result.deleted, { fragments: n === 2 ? 5 : 100, items: n === 2 ? 5 : 100, tasks: n === 2 ? 1 : 0 });
    assert.equal(result.hasCandidates, n !== 2); assert.deepEqual(budget.snapshot().used, { d1: 2, external: 0 });
    assert.deepEqual(budget.snapshot().reserved, { d1: 0, external: 0 });
    if (n !== 2) assert.ok(await getSyncTask(db, "obsolete"), "no unbounded child cascade");
  }
  assert.equal(await getSyncTask(db, "obsolete"), null); assert.ok(await getSyncTask(db, "latest"));
  assert.deepEqual(tables.map(table => JSON.stringify(sqlite.prepare(`SELECT * FROM ${table}`).all())), before);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM logs WHERE category='operation'").get()!.n, 3);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM logs WHERE category='sync'").get()!.n, 1);
});

test("history maintenance caps empty task deletion and preview samples independently at 100", async t => {
  const { db, sqlite } = fixture(t);
  for (let n = 0; n < 121; n++) historyRow(sqlite, `history-${n}`, { created: 100 + n, completed: 100 + n });
  const manager = new DatabaseManager(db);
  assert.equal((await maintainSyncHistory(manager)).sample.candidateTasks, 100);
  const first = await maintainSyncHistory(manager, { dryRun: false, confirm: SYNC_HISTORY_CONFIRMATION });
  assert.deepEqual(first.deleted, { fragments: 0, items: 0, tasks: 100 }); assert.equal(first.sample.candidateTasks, 20);
  const second = await maintainSyncHistory(manager, { dryRun: false, confirm: SYNC_HISTORY_CONFIRMATION });
  assert.equal(second.deleted.tasks, 20); assert.equal(second.hasCandidates, false);
  assert.deepEqual(sqlite.prepare("SELECT id FROM sync_tasks").all().map(row => row.id), ["history-120"]);
});

test("deep history uses additive latest/freshness/success indexes without changing retention results", async t => {
  const { sqlite } = fixture(t);
  for (let n = 0; n < 2000; n++) historyRow(sqlite, `deep-${n}`, { created: n+1, completed: n+1 });
  const definitions = sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE name IN ('idx_sync_tasks_latest','idx_sync_tasks_freshness','idx_sync_tasks_success')").all();
  assert.equal(definitions.length, 3);
  // Synthetic in-memory comparison only; no indexes/data changed on a real DB.
  for (const row of definitions) sqlite.exec(`DROP INDEX ${row.name}`);
  const before = sqlProbe(sqlite), start = performance.now();
  const expected = await maintainSyncHistory(new DatabaseManager(before.connection));
  const beforeMs = performance.now()-start;
  for (const row of definitions) sqlite.exec(String(row.sql));
  const after = sqlProbe(sqlite), next = performance.now();
  assert.deepEqual(await maintainSyncHistory(new DatabaseManager(after.connection)), expected);
  const afterMs = performance.now()-next;
  for (const sample of after.samples.values()) {
    for (const name of ['idx_sync_tasks_latest','idx_sync_tasks_freshness','idx_sync_tasks_success']) assert.ok(sample.plan.some(line => line.includes(name)), sample.plan.join("\n"));
  }
  for (let n = 2000; n < 10000; n++) historyRow(sqlite, `deep-${n}`, { created: n+1, completed: n+1 });
  const largeStart = performance.now(), result = await maintainSyncHistory(new DatabaseManager(after.connection));
  assert.equal(result.sample.candidateTasks, 100); assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sync_tasks").get()!.n, 10000);
  t.diagnostic(JSON.stringify({ syntheticTasks: 2000, beforeMs, afterMs, indexed10000Ms: performance.now()-largeStart,
    indexes: definitions.map(r => r.name), scannedRowsBounded: false, cloudCpuMs: null, cloudBilledRows: null }));
});

test("history maintenance rechecks eligibility after preview, including a new owner and removal of the newer task", async t => {
  const { db, sqlite } = fixture(t); stagedHistory(sqlite, 2);
  for (const change of ["UPDATE sync_tasks SET status='running',phase='list',owner='new-owner',lease_until=9999999999 WHERE id='obsolete'",
    "DELETE FROM sync_tasks WHERE id='latest'"]) {
    const gate = deferred(); let calls = 0;
    const delayed = coordinationFault(db, async (_sql, method, execute) => { if (method === "batch" && calls++ === 0) await gate.promise; return execute(); });
    const preview = await maintainSyncHistory(new DatabaseManager(db)); assert.equal(preview.hasCandidates, true);
    const pending = maintainSyncHistory(new DatabaseManager(delayed), { dryRun: false, confirm: SYNC_HISTORY_CONFIRMATION });
    sqlite.exec(change); gate.resolve();
    assert.deepEqual((await pending).deleted, { fragments: 0, items: 0, tasks: 0 });
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sync_fragments").get()!.n, 2);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sync_items").get()!.n, 2);
    sqlite.exec("UPDATE sync_tasks SET status='completed',phase='done',owner=NULL,lease_until=0 WHERE id='obsolete'");
  }
});

test("history maintenance rolls back child deletion and audit together on SQL failure", async t => {
  const { db, sqlite } = fixture(t); stagedHistory(sqlite, 2);
  sqlite.exec("CREATE TRIGGER history_failure BEFORE DELETE ON sync_items BEGIN SELECT RAISE(ABORT,'offline history failure'); END");
  await assert.rejects(maintainSyncHistory(new DatabaseManager(db), { dryRun: false, confirm: SYNC_HISTORY_CONFIRMATION }), /offline history failure/);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sync_fragments").get()!.n, 2);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sync_items").get()!.n, 2);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM logs").get()!.n, 0); assert.ok(await getSyncTask(db, "obsolete"));
});

test("unknown maintenance response is not replayed and exhausted budget makes no mutation", async t => {
  const { db, sqlite } = fixture(t); stagedHistory(sqlite, 2);
  const budget = new InvocationBudget({ d1: 0 });
  await assert.rejects(maintainSyncHistory(new DatabaseManager(withBudgetD1(db, budget)), { dryRun: false, confirm: SYNC_HISTORY_CONFIRMATION }), InvocationBudgetError);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sync_fragments").get()!.n, 2);
  let calls = 0;
  const unknown = coordinationFault(db, async (_sql, method, execute) => { const result = await execute(); if (method === "batch") { calls++; throw new Error("unknown maintenance commit"); } return result; });
  await assert.rejects(maintainSyncHistory(new DatabaseManager(unknown), { dryRun: false, confirm: SYNC_HISTORY_CONFIRMATION }), /unknown maintenance commit/);
  assert.equal(calls, 1); assert.equal(await getSyncTask(db, "obsolete"), null);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM logs WHERE category='operation'").get()!.n, 1);
  assert.equal((await maintainSyncHistory(new DatabaseManager(db))).hasCandidates, false);
});
