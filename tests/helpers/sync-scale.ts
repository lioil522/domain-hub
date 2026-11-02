import "./block-outbound";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createD1FromSqlite, type SqliteDatabase } from "../../server/d1-sqlite";
import { DatabaseManager } from "../../src/db";
import { DNSHEClient } from "../../src/dnshe";
import { withBudgetD1 } from "../../src/db/budget-d1";
import { InvocationBudget } from "../../src/services/invocation-budget";
import { syncStep, syncPlan } from "../../src/services/sliced-sync-service";

export interface SqlSample { sql: string; executions: number; ms: number; returnedRows: number; runChanges: number; plan: string[] }
/** Observe executed SQLite statements, including each statement in a D1 batch.
 * Returned rows/changes are NOT scanned rows or cloud billing. EXPLAIN runs
 * outside the instrumented adapter and is excluded from timing/call totals.
 */
export function sqlProbe(sqlite: DatabaseSync) {
  const samples = new Map<string, SqlSample>();
  const adapter: SqliteDatabase = {
    exec: sql => sqlite.exec(sql),
    prepare: sql => {
      const statement = sqlite.prepare(sql);
      function record<T>(operation: () => T, params: unknown[], kind: "get" | "all" | "run"): T {
        let sample = samples.get(sql);
        if (!sample) {
          sample = { sql, executions: 0, ms: 0, returnedRows: 0, runChanges: 0,
            plan: sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params as SQLInputValue[]).map(row => String(row.detail)) };
          samples.set(sql, sample);
        }
        const start = performance.now();
        try {
          const result = operation();
          sample.returnedRows += kind === "get" ? result == null ? 0 : 1 : kind === "all" ? (result as unknown[]).length : 0;
          if (kind === "run") sample.runChanges += Number((result as { changes: number | bigint }).changes);
          return result;
        } finally { sample.executions++; sample.ms += performance.now() - start; }
      }
      return {
        get: (...params) => record(() => statement.get(...params as SQLInputValue[]), params, "get"),
        all: (...params) => record(() => statement.all(...params as SQLInputValue[]), params, "all"),
        run: (...params) => record(() => statement.run(...params as SQLInputValue[]), params, "run"),
      };
    },
  };
  return { connection: createD1FromSqlite(adapter), samples };
}
const schema = readFileSync("schema.sql", "utf8");
export function scaleFixture() { const sqlite = new DatabaseSync(":memory:"); sqlite.exec(schema); return sqlite; }
export function seedAccounts(sqlite: DatabaseSync, count: number) {
  const insert = sqlite.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(?,'offline',?,'offline','dnshe')");
  for (let id = 1; id <= count; id++) insert.run(id, `offline-${id}`);
}
export function seedHistory(sqlite: DatabaseSync, accounts: number, count: number) {
  const insert = sqlite.prepare(`INSERT INTO sync_tasks(id,generation,account_id,provider,scope_revision,mode,phase,status,last_completed_at,created_at,updated_at)
    VALUES(?, ?, ?, 'dnshe',1,'full','done','completed',100,?,100)`);
  for (let id = 1; id <= accounts; id++) for (let n = 0; n < count; n++) insert.run(`history-${id}-${n}`, `generation-${id}-${n}`, id, 100 + Math.floor(n / 2));
}
export async function scalePlan(accounts = 75, history = 100) {
  const sqlite = scaleFixture();
  try {
    seedAccounts(sqlite, accounts); seedHistory(sqlite, accounts, history);
    const probe = sqlProbe(sqlite), pages = [], ids: number[] = []; let after = 0;
    do {
      const budget = new InvocationBudget(), db = new DatabaseManager(withBudgetD1(probe.connection, budget));
      const start = performance.now(), plan = await syncPlan(db, { manual: true, after });
      assert.ok(plan.plans.length <= 25); assert.equal(budget.snapshot().used.external, 0);
      for (const row of plan.plans) { ids.push(row.accountId); assert.ok("taskId" in row); assert.equal(row.taskId, `history-${row.accountId}-${history - 1}`); }
      pages.push({ accounts: plan.plans.length, ms: performance.now() - start, d1: budget.snapshot().used.d1 });
      after = plan.nextAfter ?? 0;
    } while (after);
    assert.deepEqual(ids, Array.from({ length: accounts }, (_, i) => i + 1));
    return { accounts, history, pages, sql: [...probe.samples.values()] };
  } finally { sqlite.close(); }
}
export async function scaleSync(options: { accounts: number; domains: number; dnsPages: number; rounds?: number; unrelatedDomains?: number }) {
  const sqlite = scaleFixture();
  try {
    seedAccounts(sqlite, options.accounts + 1);
    const sub = (accountId: number, n: number) => ({ id: accountId * 100000 + n, subdomain: `d${n}`, rootdomain: "example.test", full_domain: `a${accountId}-d${n}.example.test`, status: "active", expires_at: "2027-01-01" });
    const insert = sqlite.prepare("INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at) VALUES(?,?,?,?,?,'active','2027-01-01')");
    for (let account = 1; account <= options.accounts + 1; account++) for (let n = 0; n < (account <= options.accounts ? options.domains : options.unrelatedDomains ?? 0); n++) {
      const domain = sub(account, n); insert.run(domain.id, account, domain.subdomain, domain.rootdomain, domain.full_domain);
    }
    const probe = sqlProbe(sqlite), slices: { phase: string; ms: number; d1: number; external: number; sql: number }[] = [], growth = [];
    let externalPages = 0;
    const beforeChanges = Number(sqlite.prepare("SELECT total_changes() AS n").get()!.n);
    for (let round = 0; round < (options.rounds ?? 1); round++) {
      const tasks = new Map<number, string>(); const completed = new Set<number>(); const readPages = new Set<string>();
      for (let step = 0; completed.size < options.accounts && step < 5000; step++) for (let account = 1; account <= options.accounts; account++) {
        if (completed.has(account)) continue;
        const budget = new InvocationBudget(), db = new DatabaseManager(withBudgetD1(probe.connection, budget));
        const client = new DNSHEClient("offline", "offline");
        const pageRead = (key: string) => { assert.ok(!readPages.has(key), `repeated upstream page: ${key}`); readPages.add(key); budget.consume("external"); externalPages++; };
        client.listSubdomains = async (page = 1) => {
          pageRead(`list:${account}:${page}`);
          const rows = Array.from({ length: Math.max(0, Math.min(100, options.domains - (page - 1) * 100)) }, (_, n) => sub(account, (page - 1) * 100 + n));
          return { success: true, total: options.domains, subdomains: rows };
        };
        client.listDnsRecordsPage = async (id, cursor = 0) => {
          pageRead(`dns:${account}:${id}:${cursor}`);
          const page = Number(cursor);
          return { success: true, records: [{ id: `${id}-${page}`, name: "@", type: "A", content: "192.0.2.1", ttl: 60 }],
            pagination: page + 1 < options.dnsPages ? { has_more: true, next_cursor: page + 1 } : { has_more: false } };
        };
        db.getClientForAccount = async () => ({ client, alias: "offline", provider: "dnshe" });
        const taskId = tasks.get(account), previous = taskId ? sqlite.prepare("SELECT phase,cursor FROM sync_tasks WHERE id=?").get(taskId)! : null;
        const phase = previous ? previous.phase === "list" ? `list:${JSON.parse(String(previous.cursor)).stage ?? "candidates"}` : String(previous.phase) : "list:candidates";
        const before = [...probe.samples.values()].reduce((n, s) => n + s.executions, 0), start = performance.now();
        const state = await syncStep(db, account, { manual: true, taskId });
        const elapsed = performance.now() - start, snapshot = budget.snapshot();
        assert.ok(snapshot.used.d1 <= 40 && snapshot.used.external <= 1); assert.deepEqual(snapshot.reserved, { d1: 0, external: 0 }); budget.close();
        assert.ok(["queued", "completed"].includes(state.status), JSON.stringify(state));
        if (taskId) assert.equal(state.taskId, taskId); tasks.set(account, state.taskId);
        slices.push({ phase, ms: elapsed, d1: snapshot.used.d1, external: snapshot.used.external, sql: [...probe.samples.values()].reduce((n, s) => n + s.executions, 0) - before });
        if (state.status === "completed") { assert.equal(state.dns_completed, options.domains); completed.add(account); }
      }
      assert.equal(completed.size, options.accounts);
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM logs WHERE category='sync' AND type='success'").get()!.n, options.accounts * (round + 1));
      growth.push({ round: round + 1, tasks: sqlite.prepare("SELECT count(*) AS n FROM sync_tasks").get()!.n,
        items: sqlite.prepare("SELECT count(*) AS n FROM sync_items").get()!.n, fragments: sqlite.prepare("SELECT count(*) AS n FROM sync_fragments").get()!.n,
        payloadBytes: sqlite.prepare("SELECT COALESCE(sum(length(CAST(payload AS BLOB))),0) AS n FROM sync_fragments").get()!.n,
        baselineBytes: sqlite.prepare("SELECT COALESCE(sum(length(CAST(baseline AS BLOB))),0) AS n FROM sync_items").get()!.n,
        logs: sqlite.prepare("SELECT count(*) AS n FROM logs").get()!.n,
        allocatedBytes: Number(sqlite.prepare("PRAGMA page_count").get()!.page_count) * Number(sqlite.prepare("PRAGMA page_size").get()!.page_size) });
    }
    return { options, slices, growth, externalPages, totalSqliteChangesIncludingTriggers: Number(sqlite.prepare("SELECT total_changes() AS n").get()!.n) - beforeChanges, sql: [...probe.samples.values()] };
  } finally { sqlite.close(); }
}
