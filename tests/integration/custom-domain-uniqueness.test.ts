import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createD1FromSqlite } from "../../server/d1-sqlite";
import { DatabaseManager } from "../../src/db";
import { ensureDatabaseSchema, verifyDatabaseSchema } from "../../src/db/schema-migrations";
import { SCHEMA_TABLES, SCHEMA_INDEXES, MIGRATION_TABLE_SQL, MIGRATION_NAMES, SCHEMA_VERSION } from "../../src/db/schema-definition";
import { CUSTOM_DOMAIN_ARCHIVE_PREFIX } from "../../src/db/custom-domain-uniqueness";
import { CATALOG_REVISION_KEY } from "../../src/db/catalog-version";
import { ConflictError } from "../../src/errors";
import worker from "../../src/index";
import { TEST_AES_KEY } from "../helpers/database";

function v5(t: TestContext, duplicates = true, insensitiveSettings = false) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  for (const table of SCHEMA_TABLES) sqlite.exec(table.name === "settings" && insensitiveSettings
    ? table.sql.replace("value TEXT NOT NULL", "value TEXT COLLATE NOCASE NOT NULL") : table.sql);
  for (const index of SCHEMA_INDEXES.slice(0, 17)) sqlite.exec(index.sql);
  sqlite.exec(MIGRATION_TABLE_SQL);
  for (let i = 0; i < 5; i++) sqlite.prepare("INSERT INTO domain_hub_schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(i + 1, MIGRATION_NAMES[i], `original-${i + 1}`);
  sqlite.exec(`INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'first','one','plain:c2VjcmV0','custom'),(2,'second','two','plain:c2VjcmV0','custom');
    INSERT INTO custom_accounts(id,group_id,name) VALUES(1,1,'scoped');
    INSERT INTO custom_domains(id,group_id,account_id,full_domain,registered_at,expires_at,remark,updated_at)
      VALUES(1,1,NULL,'duplicate.example','2001-01-01','2030-01-01','original remark','original time'),
      (3,1,1,'duplicate.example',NULL,'2040-01-01','account scoped','scoped time'),
      (4,2,NULL,'duplicate.example',NULL,'2050-01-01','other group','other time'),
      (5,1,NULL,'different.example',NULL,'2060-01-01','different name','different time');
    INSERT INTO settings(key,value) VALUES('catalog_summary_revision','before'),('operator_setting','untouched')`);
  if (duplicates) sqlite.exec(`INSERT INTO custom_domains(id,group_id,account_id,full_domain,registered_at,expires_at,remark,updated_at)
    VALUES(2,1,NULL,'duplicate.example','2002-02-02','2032-02-02','conflicting second remark','second time')`);
  const d1 = createD1FromSqlite(sqlite);
  return { sqlite, d1, manager: new DatabaseManager(d1, TEST_AES_KEY) };
}
function archive(sqlite: DatabaseSync, id = 2) {
  const value = sqlite.prepare("SELECT value FROM settings WHERE key=?").get(`${CUSTOM_DOMAIN_ARCHIVE_PREFIX}${id}`)?.value;
  assert.equal(typeof value, "string");
  return JSON.parse(String(value));
}
function state(sqlite: DatabaseSync) {
  return {
    rows: sqlite.prepare("SELECT * FROM custom_domains ORDER BY id").all(),
    settings: sqlite.prepare("SELECT * FROM settings ORDER BY key").all(),
    history: sqlite.prepare("SELECT * FROM domain_hub_schema_migrations ORDER BY version").all(),
  };
}
test("v5 duplicates keep the oldest row unchanged and archive every conflicting original field", async t => {
  const { sqlite, d1 } = v5(t);
  const before = state(sqlite);
  await ensureDatabaseSchema(d1);
  await verifyDatabaseSchema(d1);
  assert.deepEqual(sqlite.prepare("SELECT * FROM custom_domains WHERE id=1").get(), before.rows[0]);
  assert.deepEqual(sqlite.prepare("SELECT * FROM custom_domains WHERE id>2 ORDER BY id").all(), before.rows.slice(2));
  const saved = archive(sqlite);
  assert.equal(saved.survivor_id, "1");
  for (const [name, value] of Object.entries(before.rows[1])) {
    assert.equal(saved.columns[name].value, value === null ? null : String(value), name);
  }
  assert.deepEqual(sqlite.prepare("SELECT * FROM domain_hub_schema_migrations WHERE version<=5 ORDER BY version").all(), before.history);
  assert.notEqual(sqlite.prepare("SELECT value FROM settings WHERE key=?").get(CATALOG_REVISION_KEY)?.value, "before");
  assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key='operator_setting'").get()?.value, "untouched");
  assert.throws(() => sqlite.exec("INSERT INTO custom_domains(group_id,full_domain,expires_at) VALUES(1,'duplicate.example','later')"), /UNIQUE/);
});
test("archive preserves operator columns, Blob bytes, large integers, real precision and NULL tags", async t => {
  const { sqlite, d1 } = v5(t);
  sqlite.exec(`ALTER TABLE custom_domains ADD COLUMN operator_note TEXT;
    ALTER TABLE custom_domains ADD COLUMN operator_blob BLOB;
    ALTER TABLE custom_domains ADD COLUMN operator_int INTEGER;
    ALTER TABLE custom_domains ADD COLUMN operator_real REAL;
    ALTER TABLE custom_domains ADD COLUMN operator_null TEXT;
    UPDATE custom_domains SET operator_note='operator extra',operator_blob=x'00ff01',operator_int=9223372036854775806,operator_real=1.2345678901234567 WHERE id=2`);
  await ensureDatabaseSchema(d1);
  const fields = archive(sqlite).columns;
  assert.deepEqual(fields.operator_note, { storage: "text", value: "operator extra" });
  assert.deepEqual(fields.operator_blob, { storage: "blob", value: "00FF01" });
  assert.deepEqual(fields.operator_int, { storage: "integer", value: "9223372036854775806" });
  assert.equal(fields.operator_real.storage, "real");
  assert.equal(Number(fields.operator_real.value), 1.2345678901234567);
  assert.deepEqual(fields.operator_null, { storage: "null", value: null });
});
test("migration without duplicates adds only the required unique index and does not rewrite data/settings", async t => {
  const { sqlite, d1 } = v5(t, false), before = state(sqlite);
  await ensureDatabaseSchema(d1);
  const after = state(sqlite);
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(after.settings, before.settings);
  assert.equal(after.history.length, SCHEMA_VERSION);
});
test("archive failure or corruption rolls back rows, archives, revision, index and migration history", async t => {
  for (const trigger of [
    `CREATE TRIGGER fail_archive BEFORE INSERT ON settings WHEN NEW.key LIKE '${CUSTOM_DOMAIN_ARCHIVE_PREFIX}%' BEGIN SELECT RAISE(ABORT,'archive failed'); END`,
    `CREATE TRIGGER ignore_archive BEFORE INSERT ON settings WHEN NEW.key LIKE '${CUSTOM_DOMAIN_ARCHIVE_PREFIX}%' BEGIN SELECT RAISE(IGNORE); END`,
    `CREATE TRIGGER corrupt_archive AFTER INSERT ON settings WHEN NEW.key LIKE '${CUSTOM_DOMAIN_ARCHIVE_PREFIX}%' BEGIN UPDATE settings SET value='corrupted' WHERE key=NEW.key; END`,
    "CREATE TRIGGER fail_v6 BEFORE INSERT ON domain_hub_schema_migrations WHEN NEW.version=6 BEGIN SELECT RAISE(ABORT,'late migration failure'); END",
  ]) {
    const { sqlite, d1 } = v5(t), before = state(sqlite);
    sqlite.exec(trigger);
    await assert.rejects(() => ensureDatabaseSchema(d1));
    assert.deepEqual(state(sqlite), before);
    assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='idx_custom_domains_unassigned_unique'").get(), undefined);
  }
});
test("reserved archive key collision and unexpected named index refuse migration without overwriting", async t => {
  for (const injection of [
    `INSERT INTO settings(key,value) VALUES('${CUSTOM_DOMAIN_ARCHIVE_PREFIX}2','operator-owned-value')`,
    "CREATE INDEX idx_custom_domains_unassigned_unique ON custom_domains(expires_at)",
  ]) {
    const { sqlite, d1 } = v5(t); sqlite.exec(injection);
    const before = state(sqlite);
    await assert.rejects(() => ensureDatabaseSchema(d1));
    assert.deepEqual(state(sqlite), before);
  }
});
test("archive byte equality cannot be weakened by an operator's NOCASE settings collation", async t => {
  const { sqlite, d1 } = v5(t, true, true), before = state(sqlite);
  sqlite.exec(`CREATE TRIGGER alter_case AFTER INSERT ON settings WHEN NEW.key LIKE '${CUSTOM_DOMAIN_ARCHIVE_PREFIX}%'
    BEGIN UPDATE settings SET value=upper(value) WHERE key=NEW.key; END`);
  await assert.rejects(() => ensureDatabaseSchema(d1), /UNIQUE/);
  assert.deepEqual(state(sqlite), before);
});
test("unknown child references or custom delete triggers block automatic archival", async t => {
  for (const extension of [
    "CREATE TABLE operator_child(domain_id INTEGER REFERENCES custom_domains(id) ON DELETE CASCADE); INSERT INTO operator_child VALUES(2)",
    "CREATE TRIGGER operator_delete AFTER DELETE ON custom_domains BEGIN DELETE FROM settings WHERE key='operator_setting'; END",
  ]) {
    const { sqlite, d1 } = v5(t); sqlite.exec(extension);
    const before = state(sqlite);
    await assert.rejects(() => ensureDatabaseSchema(d1), /自定义引用或触发器/);
    assert.deepEqual(state(sqlite), before);
  }
});
test("independent migration facades have one committed archive and cannot overwrite a winner", async t => {
  const { sqlite, d1 } = v5(t);
  let arrivals = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const competing = () => new Proxy(d1, { get(target, property) {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      if (++arrivals === 2) release();
      await gate;
      return target.batch(statements);
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  assert.deepEqual(await Promise.all([ensureDatabaseSchema(competing()), ensureDatabaseSchema(competing())]), [SCHEMA_VERSION, SCHEMA_VERSION]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE ?").get(`${CUSTOM_DOMAIN_ARCHIVE_PREFIX}%`)?.n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM domain_hub_schema_migrations").get()?.n, SCHEMA_VERSION);
});
test("forty null-account upserts use the unique constraint and retain one stable ID", async t => {
  const { sqlite, d1, manager } = v5(t);
  await ensureDatabaseSchema(d1);
  await Promise.all(Array.from({ length: 40 }, (_, i) => manager.upsertCustomDomain(1, null, "duplicate.example", `2035-${i}`, `remark-${i}`, `2005-${i}`)));
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM custom_domains WHERE group_id=1 AND account_id IS NULL AND full_domain='duplicate.example'").get()?.n, 1);
  const current = sqlite.prepare("SELECT * FROM custom_domains WHERE id=1").get();
  assert.equal(current?.expires_at, "2035-39");
  assert.equal(current?.registered_at, "2005-39");
  assert.equal(current?.remark, "remark-39");
  assert.equal(archive(sqlite).columns.remark.value, "conflicting second remark");
});
test("editing into an existing name returns conflict without changing either row or revision", async t => {
  const { sqlite, d1, manager } = v5(t);
  await ensureDatabaseSchema(d1);
  const before = state(sqlite);
  await assert.rejects(() => manager.updateCustomDomainById(5, 1, "duplicate.example", "new", "new"), ConflictError);
  assert.deepEqual(state(sqlite), before);
  assert.equal(await manager.updateCustomDomainById(999, 1, "none.example", "new", "new"), false);
});
test("archives are paginated, private and retained after group deletion; API conflicts return 409", async t => {
  const { sqlite, d1, manager } = v5(t);
  for (let id = 6; id < 30; id++) sqlite.prepare("INSERT INTO custom_domains(id,group_id,full_domain,expires_at,remark) VALUES(?,1,'duplicate.example','old',?)").run(id, `original-${id}`);
  await ensureDatabaseSchema(d1);
  const token = await manager.createSession();
  const ctx = { waitUntil() {}, props: {} } as unknown as ExecutionContext;
  const call = (route: string, init: RequestInit = {}) => worker.fetch(new Request(`http://localhost${route}`,
    { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } }), { DB: d1, AES_KEY: TEST_AES_KEY }, ctx);
  const first = await call("/api/custom-groups/domain-conflicts");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("Cache-Control"), "private, no-store");
  const page = await first.json() as { archives: unknown[]; page: { next_cursor: string; has_more: boolean } };
  assert.equal(page.archives.length, 20);
  assert.equal(page.page.has_more, true);
  const next = await call(`/api/custom-groups/domain-conflicts?cursor=${encodeURIComponent(page.page.next_cursor)}`);
  assert.equal((await next.json() as { archives: unknown[] }).archives.length, 5);
  const edited = await call("/api/custom-groups/1/domains", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 5, full_domain: "duplicate.example", expires_at: "2036-01-01" }) });
  assert.equal(edited.status, 409);
  await manager.deleteAccount(1);
  assert.equal((await manager.listCustomDomainArchives()).archives.length, 20);
  assert.equal((await call("/api/custom-groups/domain-conflicts?cursor=not-an-archive")).status, 400);
  const unauth = await worker.fetch(new Request("http://localhost/api/custom-groups/domain-conflicts"), { DB: d1 }, ctx);
  assert.equal(unauth.status, 401);
});
test("oversized archives are retained and require full database export instead of being skipped", async t => {
  const { sqlite, d1, manager } = v5(t);
  await ensureDatabaseSchema(d1);
  const value = JSON.stringify({ format: "domain-hub/custom-null-archive/v1", columns: { large: "x".repeat(512 * 1024) } });
  sqlite.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(`${CUSTOM_DOMAIN_ARCHIVE_PREFIX}0`, value);
  await assert.rejects(() => manager.listCustomDomainArchives(), /完整 SQLite\/D1 导出/);
  assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key=?").get(`${CUSTOM_DOMAIN_ARCHIVE_PREFIX}0`)?.value, value);
});
