import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { createD1FromSqlite } from "../../server/d1-sqlite";
import { initializeDatabase } from "../../server/initialize-database";
import { DatabaseManager } from "../../src/db";
import { ensureDatabaseSchema, verifyDatabaseSchema } from "../../src/db/schema-migrations";
import {
  freshSchemaSql, LEGACY_COLUMNS, MIGRATION_TABLE, MIGRATION_NAMES,
  SCHEMA_INDEXES, SCHEMA_TABLES, SCHEMA_VERSION,
  BASELINE_TABLES, BASELINE_INDEXES, MIGRATION_TABLE_SQL,
  RESTORE_SCHEMA_INDEXES,
} from "../../src/db/schema-definition";
import worker from "../../src/index";

function fixture(t: TestContext, legacy = false) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  if (legacy) {
    for (const table of SCHEMA_TABLES) {
      const optional = new Set(Object.keys(LEGACY_COLUMNS[table.name] || {}));
      const lines = table.sql.split("\n").filter(line => !optional.has(line.trim().split(" ")[0]));
      sqlite.exec(lines.join("\n"));
    }
    sqlite.exec(`
      INSERT INTO accounts(id, alias, api_key, api_secret) VALUES (1,'legacy','legacy-key','opaque-secret');
      INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at)
        VALUES (101,1,'old','us.ci','old.us.ci','已委派','2035-01-01');
      INSERT INTO settings(key,value) VALUES ('auth_pass_hash','opaque-hash'),('auth_2fa_secret','opaque-2fa');
      INSERT INTO custom_domains(group_id,full_domain,expires_at,remark) VALUES (1,'manual.us.ci','2035-01-01','keep this remark');
    `);
  }
  const db = createD1FromSqlite(sqlite);
  return { sqlite, db };
}

function proxyDatabase(db: D1Database, prepare: (sql: string) => D1PreparedStatement) {
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return prepare;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function structure(sqlite: DatabaseSync) {
  return {
    tables: SCHEMA_TABLES.map(table => ({
      name: table.name,
      columns: sqlite.prepare(`PRAGMA table_info(${table.name})`).all()
        .map(row => { const { cid: _cid, ...definition } = row; return definition; })
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      foreignKeys: sqlite.prepare(`PRAGMA foreign_key_list(${table.name})`).all(),
    })),
    indexes: sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all(),
  };
}

test("fresh schema creates all required tables, indexes and ordered migration history", async t => {
  const { sqlite, db } = fixture(t);
  assert.equal(await ensureDatabaseSchema(db), SCHEMA_VERSION);
  await verifyDatabaseSchema(db);
  const rows = sqlite.prepare(`SELECT version, name FROM ${MIGRATION_TABLE} ORDER BY version`).all();
  assert.deepEqual(rows.map(row => [row.version, row.name]), MIGRATION_NAMES.map((name, index) => [index + 1, name]));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").get()?.count, SCHEMA_INDEXES.length);
});

test("all supported legacy fields migrate without changing credentials, IDs, dates or remarks", async t => {
  const { sqlite, db } = fixture(t, true);
  const settings = sqlite.prepare("SELECT * FROM settings ORDER BY key").all();
  await initializeDatabase(db);
  assert.deepEqual(sqlite.prepare("SELECT * FROM settings ORDER BY key").all(), settings);
  const account = sqlite.prepare("SELECT * FROM accounts WHERE id=1").get();
  assert.equal(account?.api_secret, "opaque-secret");
  assert.equal(account?.provider, "dnshe");
  assert.equal(account?.website, null);
  assert.equal(sqlite.prepare("SELECT status FROM domains_cache WHERE id=101").get()?.status, "已委派");
  assert.equal(sqlite.prepare("SELECT remark FROM custom_domains").get()?.remark, "keep this remark");
});

test("new, legacy and generated-SQL databases converge on the same structure", async t => {
  const fresh = fixture(t), legacy = fixture(t, true), snapshot = fixture(t);
  snapshot.sqlite.exec(freshSchemaSql());
  await Promise.all([fresh.db, legacy.db, snapshot.db].map(db => ensureDatabaseSchema(db)));
  assert.deepEqual(structure(legacy.sqlite), structure(fresh.sqlite));
  assert.deepEqual(structure(snapshot.sqlite), structure(fresh.sqlite));
});

test("schema.sql exactly matches its generated source and does not stamp a legacy version", t => {
  const { sqlite } = fixture(t);
  assert.equal(readFileSync("schema.sql", "utf8").replace(/\r\n/g, "\n"), freshSchemaSql());
  sqlite.exec(freshSchemaSql());
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${MIGRATION_TABLE}`).get()?.count, 0);
});

test("current schema checks are a single read with no DDL, PRAGMA or persistent cache writes", async t => {
  const { sqlite, db } = fixture(t);
  await ensureDatabaseSchema(db);
  const before = sqlite.prepare(`SELECT * FROM ${MIGRATION_TABLE}`).all();
  const queries: string[] = [];
  const observed = proxyDatabase(db, sql => { queries.push(sql); return db.prepare(sql); });
  assert.equal(await ensureDatabaseSchema(observed), SCHEMA_VERSION);
  assert.equal(await ensureDatabaseSchema(observed), SCHEMA_VERSION);
  assert.equal(queries.length, 2);
  assert.ok(queries.every(sql => sql.startsWith("SELECT version, name")));
  assert.deepEqual(sqlite.prepare(`SELECT * FROM ${MIGRATION_TABLE}`).all(), before);
});

test("first-request bootstrap uses combined metadata reads and leaves a bounded query budget", async t => {
  const { db } = fixture(t);
  const queries: string[] = [];
  const observed = proxyDatabase(db, sql => { queries.push(sql); return db.prepare(sql); });
  await ensureDatabaseSchema(observed);
  assert.ok(queries.length <= 43, `Bootstrap prepared ${queries.length} queries`);
  assert.ok(!queries.some(sql => sql.startsWith("PRAGMA")), queries.join("\n"));
});

test("parallel managers sharing one binding coalesce migration without duplicate records", async t => {
  const { sqlite, db } = fixture(t, true);
  assert.ok((await Promise.all(Array.from({ length: 20 }, () => new DatabaseManager(db).ensureTables()))).every(Boolean));
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${MIGRATION_TABLE}`).get()?.count, SCHEMA_VERSION);
});

test("independent binding facades racing on legacy ALTER accept only committed migration history", async t => {
  const { sqlite, db } = fixture(t, true);
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  function competing() {
    let batches = 0;
    return new Proxy(db, {
      get(target, key) {
        if (key === "batch") return async (statements: D1PreparedStatement[]) => {
          if (++batches === 2) { if (++arrivals === 2) release(); await gate; }
          return target.batch(statements);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  assert.deepEqual(await Promise.all([ensureDatabaseSchema(competing()), ensureDatabaseSchema(competing())]), [SCHEMA_VERSION, SCHEMA_VERSION]);
  await verifyDatabaseSchema(db);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${MIGRATION_TABLE}`).get()?.count, SCHEMA_VERSION);
});

test("failed ALTER rolls back all fields and baseline record; retry can migrate normally", async t => {
  const { sqlite, db } = fixture(t, true);
  const failing = proxyDatabase(db, sql => db.prepare(sql.includes("ADD COLUMN remote_id") ? "SELECT * FROM injected_missing_table" : sql));
  await assert.rejects(() => ensureDatabaseSchema(failing), /injected_missing_table/);
  const columns = sqlite.prepare("PRAGMA table_info(accounts)").all().map(row => row.name);
  assert.equal(columns.includes("provider"), false);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${MIGRATION_TABLE}`).get()?.count, 0);
  assert.equal(await ensureDatabaseSchema(db), SCHEMA_VERSION);
});

test("failed index migration rolls back its entire batch and cannot record version two", async t => {
  const { sqlite, db } = fixture(t);
  const failing = proxyDatabase(db, sql => db.prepare(sql.includes("CREATE INDEX IF NOT EXISTS idx_cache_expires") ? "SELECT * FROM injected_missing_table" : sql));
  await assert.rejects(() => ensureDatabaseSchema(failing), /injected_missing_table/);
  assert.equal(sqlite.prepare(`SELECT MAX(version) AS version FROM ${MIGRATION_TABLE}`).get()?.version, null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").get()?.count, 0);
  await initializeDatabase(db);
});

test("a conflicting named index is not dropped or overwritten", async t => {
  const { sqlite, db } = fixture(t, true);
  sqlite.exec("CREATE INDEX idx_domains_expires ON domains_cache(full_domain)");
  await assert.rejects(() => ensureDatabaseSchema(db), /unexpected definition/);
  assert.equal(sqlite.prepare("PRAGMA index_info(idx_domains_expires)").get()?.name, "full_domain");
  assert.equal(sqlite.prepare(`SELECT MAX(version) AS version FROM ${MIGRATION_TABLE}`).get()?.version, 1);
});

test("outages reading migration history fail closed and cannot trigger a new bootstrap", async t => {
  const { db } = fixture(t);
  await ensureDatabaseSchema(db);
  const queries: string[] = [];
  const failing = proxyDatabase(db, sql => {
    queries.push(sql);
    if (sql.includes("SELECT version, name")) throw new Error("Injected ledger read outage");
    return db.prepare(sql);
  });
  assert.equal(await new DatabaseManager(failing).ensureTables(), false);
  assert.equal(queries.length, 1);
});

test("a future schema or a history gap is rejected without rewriting its records", async t => {
  const { sqlite, db } = fixture(t);
  await ensureDatabaseSchema(db);
  sqlite.prepare(`INSERT INTO ${MIGRATION_TABLE}(version,name) VALUES(5,'future-version')`).run();
  await assert.rejects(() => ensureDatabaseSchema(db), /Unsupported or inconsistent/);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${MIGRATION_TABLE}`).get()?.count, 5);
  sqlite.exec(`DELETE FROM ${MIGRATION_TABLE} WHERE version IN (1,5)`);
  await assert.rejects(() => ensureDatabaseSchema(db), /Unsupported or inconsistent/);
});

test("unsupported missing legacy fields require manual recovery, not destructive table rebuilds", async t => {
  const { sqlite, db } = fixture(t);
  sqlite.exec("CREATE TABLE accounts(id INTEGER PRIMARY KEY, alias TEXT); INSERT INTO accounts VALUES(7,'keep')");
  await assert.rejects(() => ensureDatabaseSchema(db), /accounts.api_key/);
  assert.equal(sqlite.prepare("SELECT alias FROM accounts WHERE id=7").get()?.alias, "keep");
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${MIGRATION_TABLE}`).get()?.count, 0);
});

test("a new database binding cannot inherit readiness from an earlier successful API request", async t => {
  const first = fixture(t), second = fixture(t);
  const context = { waitUntil() {}, props: {} } as unknown as ExecutionContext;
  for (const db of [first.db, second.db]) {
    const response = await worker.fetch(new Request("http://localhost/api/auth/status"), { DB: db }, context);
    assert.equal(response.status, 200);
  }
  await verifyDatabaseSchema(second.db);
});

test("API schema failure returns 503 and does not execute setup writes; recovery retries", async t => {
  const { sqlite, db } = fixture(t);
  const failing = proxyDatabase(db, sql => db.prepare(sql.includes("CREATE INDEX") ? "SELECT * FROM injected_missing_table" : sql));
  const request = () => new Request("http://localhost/api/auth/setup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "should-not-create", password: "test-password" }),
  });
  const context = { waitUntil() {}, props: {} } as unknown as ExecutionContext;
  const response = await worker.fetch(request(), { DB: failing }, context);
  assert.equal(response.status, 503);
  if (sqlite.prepare("SELECT name FROM sqlite_master WHERE name='settings'").get()) {
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM settings").get()?.count, 0);
  }
  assert.equal(await new DatabaseManager(db).ensureTables(), true);
});

test("Node startup rejects missing required indexes even when the version ledger is current", async t => {
  const { sqlite, db } = fixture(t);
  await initializeDatabase(db);
  sqlite.exec("DROP INDEX idx_domains_account");
  await assert.rejects(() => initializeDatabase(db), /idx_domains_account is missing/);
});

test("unrelated custom indexes, columns and nullable duplicates remain untouched", async t => {
  const { sqlite, db } = fixture(t, true);
  sqlite.exec(`
    ALTER TABLE accounts ADD COLUMN operator_note TEXT;
    UPDATE accounts SET operator_note='keep me';
    CREATE INDEX operator_domains_name ON domains_cache(full_domain);
    INSERT INTO custom_domains(group_id,full_domain,expires_at,remark) VALUES(1,'manual.us.ci','2036-01-01','another remark');
  `);
  await initializeDatabase(db);
  assert.equal(sqlite.prepare("SELECT operator_note FROM accounts").get()?.operator_note, "keep me");
  assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='operator_domains_name'").get());
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM custom_domains").get()?.count, 2);
});

test("account-expiry, cache cleanup and action-list query plans use the required indexes", async t => {
  const { sqlite, db } = fixture(t);
  await initializeDatabase(db);
  for (const [sql, expected] of [
    ["SELECT * FROM domains_cache WHERE account_id=1 ORDER BY expires_at", "idx_domains_account_expires"],
    ["SELECT key FROM cache WHERE expires_at<1000", "idx_cache_expires"],
    ["SELECT * FROM actions ORDER BY updated_at DESC LIMIT 50", "idx_actions_updated"],
  ]) {
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail).join(" ");
    assert.ok(plan.includes(expected), plan);
    assert.ok(!plan.includes("USE TEMP B-TREE"), plan);
  }
  assert.equal(SCHEMA_INDEXES.length, 15);
});

test("an existing v2 database appends v3 without changing its previous migration history", async t => {
  const { sqlite, db } = fixture(t);
  for (const table of BASELINE_TABLES) sqlite.exec(table.sql);
  for (const index of BASELINE_INDEXES) sqlite.exec(index.sql);
  sqlite.exec(MIGRATION_TABLE_SQL);
  sqlite.prepare(`INSERT INTO ${MIGRATION_TABLE}(version,name,applied_at) VALUES(?,?,?)`).run(1, MIGRATION_NAMES[0], "original-one");
  sqlite.prepare(`INSERT INTO ${MIGRATION_TABLE}(version,name,applied_at) VALUES(?,?,?)`).run(2, MIGRATION_NAMES[1], "original-two");
  await ensureDatabaseSchema(db);
  assert.equal(sqlite.prepare(`SELECT applied_at FROM ${MIGRATION_TABLE} WHERE version=1`).get()?.applied_at, "original-one");
  assert.equal(sqlite.prepare(`SELECT applied_at FROM ${MIGRATION_TABLE} WHERE version=2`).get()?.applied_at, "original-two");
  assert.equal(sqlite.prepare(`SELECT MAX(version) n FROM ${MIGRATION_TABLE}`).get()?.n, SCHEMA_VERSION);
  await verifyDatabaseSchema(db);
});

test("v3 failure rolls back all new staging tables and cannot mark the migration applied", async t => {
  const { sqlite, db } = fixture(t);
  for (const table of BASELINE_TABLES) sqlite.exec(table.sql);
  for (const index of BASELINE_INDEXES) sqlite.exec(index.sql);
  sqlite.exec(MIGRATION_TABLE_SQL);
  for (let i = 0; i < 2; i++) sqlite.prepare(`INSERT INTO ${MIGRATION_TABLE}(version,name) VALUES(?,?)`).run(i + 1, MIGRATION_NAMES[i]);
  const failing = proxyDatabase(db, sql => db.prepare(sql.includes("CREATE INDEX IF NOT EXISTS idx_restore_sessions_expires")
    ? "SELECT * FROM injected_missing_table" : sql));
  await assert.rejects(() => ensureDatabaseSchema(failing), /injected_missing_table/);
  assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='restore_sessions'").get(), undefined);
  assert.equal(sqlite.prepare(`SELECT MAX(version) n FROM ${MIGRATION_TABLE}`).get()?.n, 2);
  await ensureDatabaseSchema(db);
});

function seedV3(sqlite: DatabaseSync) {
  for (const table of SCHEMA_TABLES.filter(table => !table.name.startsWith("sync_"))) {
    sqlite.exec(table.name === "cf_sync_state" ? table.sql.replace("    credential_fingerprint TEXT,\n", "") : table.sql);
  }
  for (const index of [...BASELINE_INDEXES, ...RESTORE_SCHEMA_INDEXES]) sqlite.exec(index.sql);
  sqlite.exec(MIGRATION_TABLE_SQL);
  for (let i = 0; i < 3; i++) sqlite.prepare(`INSERT INTO ${MIGRATION_TABLE}(version,name,applied_at) VALUES(?,?,?)`).run(i + 1, MIGRATION_NAMES[i], `old-${i}`);
}

test("v3 upgrades to the work queue without changing old version records or CF checkpoints", async t => {
  const { sqlite, db } = fixture(t);
  seedV3(sqlite);
  sqlite.exec(`INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'CF','fake','plain:c2VjcmV0','cloudflare');
    INSERT INTO cf_sync_state(account_id,generation,next_page,total_synced,lease_token,lease_until,updated_at) VALUES(1,'old',7,300,'old-token',0,1000)`);
  await ensureDatabaseSchema(db);
  assert.equal(sqlite.prepare(`SELECT applied_at FROM ${MIGRATION_TABLE} WHERE version=3`).get()?.applied_at, "old-2");
  assert.equal(sqlite.prepare("SELECT next_page FROM cf_sync_state").get()?.next_page, 7);
  assert.equal(sqlite.prepare("SELECT credential_fingerprint FROM cf_sync_state").get()?.credential_fingerprint, null);
  await verifyDatabaseSchema(db);
});

test("v4 failure rolls back work tables and CF fingerprint migration together", async t => {
  const { sqlite, db } = fixture(t);
  seedV3(sqlite);
  const failing = proxyDatabase(db, sql => db.prepare(sql.includes("CREATE INDEX IF NOT EXISTS idx_sync_work_due") ? "SELECT * FROM injected_missing_table" : sql));
  await assert.rejects(() => ensureDatabaseSchema(failing), /injected_missing_table/);
  assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='sync_work'").get(), undefined);
  assert.ok(!sqlite.prepare("PRAGMA table_info(cf_sync_state)").all().some(row => row.name === "credential_fingerprint"));
  assert.equal(sqlite.prepare(`SELECT MAX(version) n FROM ${MIGRATION_TABLE}`).get()?.n, 3);
  await ensureDatabaseSchema(db);
});
