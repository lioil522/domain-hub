import assert from "node:assert/strict";
import { test } from "node:test";
import { BackupService } from "../../src/services/backup-service";
import "../helpers/block-outbound";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createD1FromSqlite } from "../../server/d1-sqlite";
import { DatabaseManager } from "../../src/db";
import { encryptText, decryptText } from "../../src/db/crypto";
import { InvocationBudget } from "../../src/services/invocation-budget";
import { withBudgetD1 } from "../../src/db/budget-d1";
import { coordinationFault } from "../helpers/coordination-fault";
import { validBusinessSnapshot } from "../../src/db/backup-format";
import type { TestContext } from "node:test";

// Exercise pure diff logic without creating a database binding.
const service = Object.create(BackupService.prototype) as BackupService;

test("backup diff reports add/update/remove without performing deletes", () => {
  const diff = service.diff(
    { version: 1, exported_at: "now", data: { accounts: [{ id: 1, alias: "old" }, { id: 2, alias: "keep" }] } },
    { version: 1, exported_at: "now", data: { accounts: [{ id: 1, alias: "new" }, { id: 3, alias: "add" }] } },
  );
  const accounts = diff.tables.find((item) => item.table === "accounts");
  assert.deepEqual(accounts && { add: accounts.add, update: accounts.update, remove: accounts.remove }, { add: 1, update: 1, remove: 1 });
  assert.equal(diff.totalConflicts, 0);
});

function fixture(t: TestContext, key = "offline-target-aes") {
  const sqlite = new DatabaseSync(":memory:"); sqlite.exec(readFileSync("schema.sql", "utf8")); t.after(() => sqlite.close());
  const connection = createD1FromSqlite(sqlite), manager = new DatabaseManager(connection, key);
  return { sqlite, connection, manager, backup: new BackupService(manager) };
}
async function incoming() {
  return { version: 1, exported_at: "offline", data: {
    accounts: [{ id: 1, alias: "offline-api", api_key: "cfsd_offline", api_secret: await encryptText("offline-api-secret", "offline-source-aes"), provider: "dnshe" },
      { id: 2, alias: "offline-group", api_key: "custom:offline", api_secret: await encryptText("", "offline-source-aes"), provider: "custom" }],
    custom_accounts: [{ id: 1, group_id: 2, name: "offline-person" }],
    custom_domains: [{ id: 1, group_id: 2, account_id: 1, full_domain: "custom.example.test", expires_at: "2027-01-01" }],
    domains_cache: [{ id: 4739823932, account_id: 1, subdomain: "a", rootdomain: "example.test", full_domain: "a.example.test", status: "active", expires_at: "2027-01-01", has_dns: 1, provider_account_id: "remote-external-id" }],
    domain_date_overrides: [{ id: 1, account_id: 1, full_domain: "a.example.test", expires_at: "2028-01-01" }],
  } };
}
const businessState = (s: DatabaseSync) => ["accounts", "domains_cache", "custom_accounts", "custom_domains", "domain_date_overrides", "sync_tasks", "cache", "settings"].map(table => JSON.stringify(s.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));

test("backup cross-key preview is read-only; restore maps local collisions without rewriting remote domain IDs", async t => {
  const { sqlite, backup } = fixture(t);
  sqlite.exec("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'keep','keep','plain:a2VlcA==','custom'); INSERT INTO custom_accounts(id,group_id,name) VALUES(1,1,'keep'); INSERT INTO custom_domains(id,group_id,account_id,full_domain,expires_at) VALUES(1,1,1,'keep.example.test','2029-01-01'); INSERT INTO settings VALUES('cfg_login_sync_enabled','false',''); INSERT INTO cache VALUES('offline-checkpoint','keep',9999999999)");
  const snapshot = await incoming(), before = businessState(sqlite);
  const changes = sqlite.prepare("SELECT total_changes() AS n").get()!.n;
  assert.equal((await backup.preview(snapshot, "offline-source-aes")).totalAdd, 6);
  assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()!.n, changes); assert.deepEqual(businessState(sqlite), before);
  const result = await backup.restore(snapshot, "offline-source-aes");
  assert.deepEqual(result.mappings.accounts, { "1": 2, "2": 3 }); assert.deepEqual(result.mappings.custom_accounts, { "1": 2 });
  assert.deepEqual(result.mappings.domains_cache, { "4739823932": 4739823932 });
  const api = sqlite.prepare("SELECT * FROM accounts WHERE id=2").get()!;
  assert.equal(await decryptText(String(api.api_secret), "offline-target-aes"), "offline-api-secret");
  await assert.rejects(decryptText(String(api.api_secret), "offline-source-aes"));
  assert.equal(sqlite.prepare("SELECT account_id FROM domains_cache").get()!.account_id, 2);
  assert.equal(sqlite.prepare("SELECT provider_account_id FROM domains_cache").get()!.provider_account_id, "remote-external-id");
  assert.equal(sqlite.prepare("SELECT group_id FROM custom_domains WHERE id=2").get()!.group_id, 3);
  assert.equal(sqlite.prepare("SELECT account_id FROM custom_domains WHERE id=2").get()!.account_id, 2);
  assert.equal(sqlite.prepare("SELECT account_id FROM domain_date_overrides").get()!.account_id, 2);
  assert.equal(sqlite.prepare("SELECT value FROM cache").get()!.value, "keep");
  assert.equal(sqlite.prepare("SELECT value FROM settings").get()!.value, "false");
  const after = businessState(sqlite), repeated = await backup.restore(snapshot, "offline-source-aes");
  assert.ok(Object.values(repeated.imported).every(n => n === 0)); assert.deepEqual(businessState(sqlite), after);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sync_commit_assertions").get()!.n, 0);
});

test("backup wrong source key, corrupt ciphertext and same-key/provider identity conflicts fail before writes", async t => {
  const { sqlite, backup } = fixture(t); const snapshot = await incoming();
  const before = businessState(sqlite);
  await assert.rejects(backup.restore(snapshot), /凭据无法验证/);
  await assert.rejects(backup.restore(snapshot, "wrong-offline-key"), /凭据无法验证/);
  snapshot.data.accounts[0].api_secret = "broken:cipher";
  await assert.rejects(backup.restore(snapshot, "offline-source-aes"), /凭据无法验证/); assert.deepEqual(businessState(sqlite), before);
  const good = await incoming();
  sqlite.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'conflict','cfsd_offline',?,'dnshe')").run(await encryptText("different-secret", "offline-target-aes"));
  await assert.rejects(backup.preview(good, "offline-source-aes"), /凭据无法验证/);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM accounts").get()!.n, 1);
});

test("backup signed and zero domain IDs survive unchanged and foreign-account collisions never upsert", async t => {
  const { sqlite, backup } = fixture(t); const snapshot = await incoming();
  snapshot.data.domains_cache = [-10, 0, Number.MAX_SAFE_INTEGER].map(id => ({ ...snapshot.data.domains_cache[0], id, full_domain: `${id}.example.test` }));
  await backup.restore(snapshot, "offline-source-aes");
  assert.deepEqual(sqlite.prepare("SELECT id FROM domains_cache ORDER BY id").all().map(r => r.id), [-10,0,Number.MAX_SAFE_INTEGER]);
  const before = businessState(sqlite);
  sqlite.exec("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(9,'other','other','plain:b3RoZXI=','dnshe'); UPDATE domains_cache SET account_id=9 WHERE id=0");
  await assert.rejects(backup.restore(snapshot, "offline-source-aes"), /业务数据冲突/);
  assert.equal(sqlite.prepare("SELECT account_id FROM domains_cache WHERE id=0").get()!.account_id, 9);
  assert.equal(before[0].includes("cfsd_offline"), true);
});

test("backup strict validation rejects duplicate IDs, mixed custom ownership, unknown tables/fields and dangling parents", async () => {
  const original = await incoming(); assert.equal(validBusinessSnapshot(original), true);
  for (const mutate of [
    (s: typeof original) => { s.data.accounts.push(s.data.accounts[0]); },
    (s: typeof original) => { s.data.custom_domains[0].group_id = 1; },
    (s: typeof original) => { s.data.custom_accounts[0].group_id = 1; },
    (s: typeof original) => { s.data.domains_cache[0].account_id = 999; },
    (s: typeof original) => { (s.data as Record<string, unknown>).settings = []; },
    (s: typeof original) => { (s.data.accounts[0] as Record<string, unknown>).injected = "ignored-before"; },
    (s: typeof original) => { (s.data.accounts as unknown[])[0] = null; },
    (s: typeof original) => { s.version = 2; },
    (s: typeof original) => { s.data.custom_accounts[0].id = -1; },
  ]) { const copy = structuredClone(original); mutate(copy); assert.equal(validBusinessSnapshot(copy), false); }
});

for (const failure of ["sql", "audit", "allocation", "higher-allocation", "identity", "unknown"]) test(`backup atomic failure containment: ${failure}`, async t => {
  const { sqlite, connection } = fixture(t); const snapshot = await incoming();
  if (failure === "identity") {
    sqlite.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'same','cfsd_offline',?,'dnshe')").run(await encryptText("offline-api-secret", "offline-target-aes"));
  }
  if (failure === "sql") sqlite.exec("CREATE TRIGGER backup_fault BEFORE INSERT ON custom_domains BEGIN SELECT RAISE(ABORT,'offline SQL failure'); END");
  if (failure === "audit") sqlite.exec("CREATE TRIGGER backup_fault BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'offline audit failure'); END");
  let commits = 0, batches = 0;
  const faulty = coordinationFault(connection, async (sql, method, execute) => {
    if (method === "batch" && ++batches === 7) {
      commits++;
      if (failure === "allocation") sqlite.exec("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'concurrent','concurrent','plain:Yw==','custom')");
      if (failure === "higher-allocation") sqlite.exec("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(99,'concurrent','concurrent','plain:Yw==','custom')");
      if (failure === "identity") sqlite.exec("UPDATE accounts SET api_secret='plain:Y2hhbmdlZA==' WHERE id=1");
      const result = await execute();
      if (failure === "unknown") throw new Error("unknown offline commit");
      return result;
    }
    return execute();
  });
  await assert.rejects(new BackupService(new DatabaseManager(faulty, "offline-target-aes")).restore(snapshot, "offline-source-aes"));
  assert.equal(commits, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM domains_cache").get()!.n, failure === "unknown" ? 1 : 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM audit_logs WHERE result='success'").get()!.n, failure === "unknown" ? 1 : 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sync_commit_assertions").get()!.n, 0);
});

test("backup omitted legacy defaults are materialised, custom empty secrets match, registration dates conflict", async t => {
  const { sqlite, backup } = fixture(t), snapshot = await incoming();
  snapshot.data.accounts[1].api_secret = "";
  await backup.restore(snapshot, "offline-source-aes");
  assert.ok(sqlite.prepare("SELECT created_at FROM accounts WHERE id=1").get()!.created_at);
  assert.ok(sqlite.prepare("SELECT updated_at FROM custom_accounts").get()!.updated_at);
  assert.equal(sqlite.prepare("SELECT source FROM domain_date_overrides").get()!.source, null);
  sqlite.exec("UPDATE accounts SET api_secret='' WHERE provider='custom'; UPDATE domains_cache SET created_at='2025-01-01'");
  const copy = structuredClone(snapshot);
  (copy.data.domains_cache[0] as Record<string, unknown>).created_at = "2024-01-01";
  await assert.rejects(backup.preview(copy, "offline-source-aes"), /冲突/);
  assert.equal((await backup.preview(snapshot, "offline-source-aes")).totalAdd, 0);
});

test("backup local allocation respects deleted AUTOINCREMENT high-water marks", async t => {
  const { sqlite, backup } = fixture(t);
  sqlite.exec("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(100,'deleted','deleted','','custom'); DELETE FROM accounts WHERE id=100");
  const result = await backup.restore(await incoming(), "offline-source-aes");
  assert.deepEqual(result.mappings.accounts, { "1": 101, "2": 102 });
});

test("backup exact compact UTF-8 8MiB bound accepts, one byte over rejects without I/O", async t => {
  const { backup } = fixture(t), snapshot = await incoming();
  const row = snapshot.data.custom_domains[0] as Record<string, unknown>;
  row.remark = "中";
  const base = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  row.remark += "x".repeat(8 * 1024 * 1024-base);
  assert.equal(validBusinessSnapshot(snapshot), true);
  row.remark += "x";
  assert.equal(validBusinessSnapshot(snapshot), false);
  await assert.rejects(async () => backup.restore(snapshot, "offline-source-aes"));
});

test("backup 500-row maximum uses bounded D1 lookup batches; 501 rejects before writes and export never truncates", async t => {
  const { sqlite, connection } = fixture(t); const snapshot = await incoming();
  snapshot.data.custom_domains = Array.from({ length: 495 }, (_, n) => ({ ...snapshot.data.custom_domains[0], id: n+1, full_domain: `d${n}.example.test` }));
  const budget = new InvocationBudget(), backup = new BackupService(new DatabaseManager(withBudgetD1(connection, budget), "offline-target-aes"));
  await backup.restore(snapshot, "offline-source-aes"); assert.equal(budget.snapshot().used.d1, 7); assert.equal(budget.snapshot().used.external, 0);
  snapshot.data.custom_domains.push({ ...snapshot.data.custom_domains[0], id: 9999 });
  await assert.rejects(async () => backup.restore(snapshot, "offline-source-aes")); assert.equal(budget.snapshot().used.d1, 7);
  sqlite.exec("INSERT INTO custom_domains(group_id,account_id,full_domain,expires_at) VALUES(2,1,'extra.example.test','2027-01-01')");
  await assert.rejects(backup.exportSnapshot(), /超过500/);
});
