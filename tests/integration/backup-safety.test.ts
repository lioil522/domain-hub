import assert from "node:assert/strict";
import { test } from "node:test";
import { testDatabase, TEST_AES_KEY, failDatabaseOperation } from "../helpers/database";
import { DatabaseManager } from "../../src/db";
import { BackupService } from "../../src/services/backup-service";
import { encryptText, decryptText } from "../../src/db/crypto";
import { backupChecksum } from "../../src/db/backup-integrity";
import { BACKUP_BODY_LIMIT, normalizeBackup } from "../../src/db/backup-snapshot";
import { downloadableBackup, refreshRestoredData, isBackupPreview } from "../../frontend/src/features/data/utils/backup-transfer";
import worker from "../../src/index";

const account = (id = 1, key = `key-${id}`, alias = `account-${id}`) => ({
  id, api_key: key, api_secret: "plain:c2VjcmV0", alias, provider: "dnshe", website: null, created_at: "2026-01-01",
});
const domain = (id = 101, accountId = 1) => ({
  id, account_id: accountId, subdomain: "test", rootdomain: "us.ci", full_domain: `test${id}.us.ci`,
  status: "active", expires_at: "", remote_id: null,
});
const snapshot = (data: Record<string, unknown[]>) => ({ version: 1, exported_at: "2026-01-01", data });
const context = { waitUntil() {}, props: {} } as unknown as ExecutionContext;
async function request(db: D1Database, session: string, path: string, body: unknown) {
  return worker.fetch(new Request(`http://localhost/api/data/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
    body: JSON.stringify(body),
  }), { DB: db, AES_KEY: TEST_AES_KEY }, context);
}

test("export includes scope, key identity, schema and checksum without system tables or custom columns", async t => {
  const { sqlite, manager } = await testDatabase(t);
  await manager.importAllData(snapshot({ accounts: [account()] }));
  await manager.setPassword("admin", "local-test-password");
  sqlite.exec("ALTER TABLE accounts ADD COLUMN operator_secret TEXT; UPDATE accounts SET operator_secret='do-not-export'");
  const result = await manager.exportAllData();
  assert.equal(result.metadata?.scope, "business");
  assert.equal(result.metadata?.key_id?.length, 64);
  assert.equal(await backupChecksum(result), result.metadata?.checksum);
  assert.ok(!Object.keys(result.data).includes("settings"));
  assert.equal((result.data.accounts[0] as Record<string, unknown>).operator_secret, undefined);
});

test("same-key export and restore preserve decrypted credentials and business rows", async t => {
  const source = await testDatabase(t), target = await testDatabase(t);
  await source.manager.importAllData(snapshot({ accounts: [account()], domains_cache: [domain()] }));
  const exported = await source.manager.exportAllData();
  await target.manager.importAllData(exported);
  const cipher = await target.manager.firstRaw<{ api_secret: string }>("SELECT api_secret FROM accounts WHERE id=1");
  assert.equal(await decryptText(cipher!.api_secret, TEST_AES_KEY), "secret");
  assert.equal((await target.manager.getDomainById(101))?.expires_at, "");
});

test("checksum corruption is rejected before business writes", async t => {
  const source = await testDatabase(t), target = await testDatabase(t);
  await source.manager.importAllData(snapshot({ accounts: [account()] }));
  const exported = await source.manager.exportAllData();
  (exported.data.accounts[0] as Record<string, unknown>).alias = "tampered";
  await assert.rejects(() => target.manager.importAllData(exported), /校验和/);
  assert.equal((await target.manager.getAccounts()).length, 0);
});

test("metadata key mismatch and legacy ciphertext from another key are rejected", async t => {
  const source = await testDatabase(t), target = await testDatabase(t);
  await source.manager.importAllData(snapshot({ accounts: [account()] }));
  const exported = await source.manager.exportAllData();
  const wrong = new DatabaseManager(target.d1, "different-target-key");
  await assert.rejects(() => wrong.importAllData(exported), /AES_KEY 不匹配/);
  const legacy = snapshot({ accounts: [{ ...account(), api_secret: await encryptText("secret", "wrong-source-key") }] });
  await assert.rejects(() => target.manager.importAllData(legacy), /无法用目标 AES_KEY/);
  assert.equal((await target.manager.getAccounts()).length, 0);
});

test("legacy plain credentials require a target key and are re-encrypted on import", async t => {
  const { d1, manager } = await testDatabase(t);
  await assert.rejects(() => new DatabaseManager(d1).importAllData(snapshot({ accounts: [account()] })), /无法用目标 AES_KEY/);
  await manager.importAllData(snapshot({ accounts: [account()] }));
  const cipher = await manager.firstRaw<{ api_secret: string }>("SELECT api_secret FROM accounts WHERE id=1");
  assert.ok(!cipher!.api_secret.startsWith("plain:"));
  assert.equal(await decryptText(cipher!.api_secret, TEST_AES_KEY), "secret");
});

test("same numeric account ID with different business identity is a conflict, not an update", async t => {
  const { manager } = await testDatabase(t);
  await manager.importAllData(snapshot({ accounts: [account(1, "original-key")] }));
  const incoming = snapshot({ accounts: [account(1, "different-key")] });
  const diff = await new BackupService(manager).preview(incoming);
  assert.equal(diff.totalConflicts, 1);
  assert.equal(diff.canImport, false);
  await assert.rejects(() => manager.importAllData(incoming), /身份或引用冲突/);
  assert.equal((await manager.getAccounts())[0].api_key, "original-key");
});

test("same natural account identity using a different ID requires explicit mapping", async t => {
  const { manager } = await testDatabase(t);
  await manager.importAllData(snapshot({ accounts: [account(9, "shared-key")] }));
  const incoming = snapshot({ accounts: [account(1, "shared-key")] });
  assert.equal((await manager.previewDataImport(incoming)).totalConflicts, 1);
  await assert.rejects(() => manager.importAllData(incoming), /冲突/);
  assert.equal((await manager.getAccounts())[0].id, 9);
});

test("same identity updates fields and keeps target-only accounts", async t => {
  const { manager } = await testDatabase(t);
  await manager.importAllData(snapshot({ accounts: [account(), account(2)] }));
  const incoming = snapshot({ accounts: [account(1, "key-1", "updated")] });
  const diff = await manager.previewDataImport(incoming);
  assert.equal(diff.totalUpdate, 1);
  assert.equal(diff.totalRemove, 1);
  assert.equal(diff.totalConflicts, 0);
  await manager.importAllData(incoming);
  assert.equal((await manager.getAccounts()).length, 2);
  assert.equal((await manager.getAccounts()).find(row => row.id === 1)?.alias, "updated");
});

test("duplicate input IDs or natural identities cannot be silently collapsed", async t => {
  const { manager } = await testDatabase(t);
  for (const rows of [[account(), account()], [account(1, "shared"), account(2, "shared")]]) {
    assert.ok((await manager.previewDataImport(snapshot({ accounts: rows }))).totalConflicts > 0);
    await assert.rejects(() => manager.importAllData(snapshot({ accounts: rows })), /冲突/);
  }
  assert.equal((await manager.getAccounts()).length, 0);
});

test("duplicate cached domain display or remote identity is a conflict even with different numeric IDs", async t => {
  const { manager } = await testDatabase(t);
  const row = { ...domain(), remote_id: "zone-1" };
  const incoming = snapshot({ accounts: [account()], domains_cache: [row, { ...row, id: 102, remote_id: "zone-2" }] });
  assert.equal((await manager.previewDataImport(incoming)).totalConflicts, 1);
  await assert.rejects(() => manager.importAllData(incoming), /冲突/);
});

test("foreign-key and cross-group custom account references are reported in preview", async t => {
  const { manager } = await testDatabase(t);
  assert.equal((await manager.previewDataImport(snapshot({ domains_cache: [domain(101, 999)] }))).totalConflicts, 1);
  const incoming = snapshot({
    accounts: [account(), account(2)], custom_accounts: [{ id: 10, group_id: 1, name: "custom" }],
    custom_domains: [{ id: 1, group_id: 2, account_id: 10, full_domain: "manual.us.ci", expires_at: "2030-01-01" }],
  });
  assert.equal((await manager.previewDataImport(incoming)).totalConflicts, 1);
  await assert.rejects(() => manager.importAllData(incoming), /冲突/);
  assert.equal((await manager.getAccounts()).length, 0);
});

test("invalid row types, counts, tables and unsupported providers fail validation", () => {
  for (const input of [
    snapshot({ accounts: [null] }), snapshot({ accounts: [{ ...account(), alias: {} }] }),
    snapshot({ accounts: [{ ...account(), id: 1.5 }] }), snapshot({ accounts: [{ ...account(), provider: "unknown" }] }),
    snapshot({ settings: [] }), { ...snapshot({ accounts: [account()] }), counts: { accounts: 99 } },
  ]) assert.throws(() => normalizeBackup(input));
});

test("over-limit preview is honest and restore retains the bounded atomic batch", async t => {
  const { manager } = await testDatabase(t);
  const incoming = snapshot({ accounts: [], domains_cache: Array.from({ length: 501 }, (_, i) => domain(i + 1)) });
  const preview = await manager.previewDataImport(incoming);
  assert.equal(preview.rowCount, 501);
  assert.equal(preview.importLimit, 500);
  assert.equal(preview.canImport, false);
  await assert.rejects(() => manager.importAllData(incoming), /超过直接导入上限/);
  assert.equal((await manager.getAccounts()).length, 0);
});

test("a concurrent numeric-ID identity collision aborts all import writes, preserving the concurrent row", async t => {
  const { d1, manager } = await testDatabase(t);
  let batches = 0;
  const raced = new Proxy(d1, {
    get(target, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        if (++batches === 2) await d1.prepare("INSERT INTO accounts(id,alias,api_key,api_secret) VALUES(2,'concurrent','unrelated','plain:c2VjcmV0')").run();
        return target.batch(statements);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await assert.rejects(() => new DatabaseManager(raced, TEST_AES_KEY).importAllData(snapshot({ accounts: [account(), account(2)] })));
  assert.deepEqual((await manager.getAccounts()).map(row => row.api_key), ["unrelated"]);
});

test("concurrent NULL-account natural collision rolls back sibling updates without deleting either old row", async t => {
  const { d1, manager } = await testDatabase(t);
  await manager.importAllData(snapshot({ accounts: [account()] }));
  let batches = 0;
  const raced = new Proxy(d1, {
    get(target, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        if (++batches === 2) await d1.prepare("INSERT INTO custom_domains(id,group_id,account_id,full_domain,expires_at,remark) VALUES(99,1,NULL,'manual.us.ci','2030-01-01','concurrent')").run();
        return target.batch(statements);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await assert.rejects(() => new DatabaseManager(raced, TEST_AES_KEY).importAllData(snapshot({
    accounts: [account(1, "key-1", "should-rollback")],
    custom_domains: [{ id: 1, group_id: 1, account_id: null, full_domain: "manual.us.ci", expires_at: "2031-01-01" }],
  })));
  assert.equal((await manager.getAccounts())[0].alias, "account-1");
  assert.equal((await manager.firstRaw<{ remark: string }>("SELECT remark FROM custom_domains WHERE id=99"))?.remark, "concurrent");
});

test("restoring business data does not modify login credentials or existing sessions", async t => {
  const { manager } = await testDatabase(t);
  await manager.setPassword("original", "local-test-password");
  const session = await manager.createSession();
  const before = await manager.getAuthConfig();
  await manager.importAllData(snapshot({ accounts: [account()] }));
  assert.deepEqual(await manager.getAuthConfig(), before);
  assert.equal(await manager.validateSession(session), true);
});

test("API preserves backup conflict status and returns committed success when only audit fails", async t => {
  const { d1, manager } = await testDatabase(t);
  const session = await manager.createSession();
  await manager.importAllData(snapshot({ accounts: [account()] }));
  const conflict = await request(d1, session, "import", { snapshot: snapshot({ accounts: [account(1, "different")] }) });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { error_code: string }).error_code, "backup_conflict");
  const failing = failDatabaseOperation(d1, sql => sql.includes("INSERT INTO audit_logs"), "run");
  const response = await request(failing, session, "import", { snapshot: snapshot({ accounts: [account(2)] }) });
  assert.equal(response.status, 200);
  assert.ok((await response.json() as { warnings: string[] }).warnings.length > 0);
  assert.equal((await manager.getAccounts()).length, 2);
});

test("oversized backup API bodies are rejected with 413 before import", async t => {
  const { d1, manager } = await testDatabase(t);
  const session = await manager.createSession();
  const response = await worker.fetch(new Request("http://localhost/api/data/import", {
    method: "POST", headers: { Authorization: `Bearer ${session}`, "Content-Length": String(BACKUP_BODY_LIMIT + 1) }, body: "{}",
  }), { DB: d1, AES_KEY: TEST_AES_KEY }, context);
  assert.equal(response.status, 413);
});

test("download helper preserves checksum metadata while stripping the response envelope", () => {
  const metadata = { scope: "business", key_id: "key", checksum: "checksum", schema_version: 2 };
  const file = downloadableBackup({ success: true, version: 1, exported_at: "now", counts: {}, data: {}, metadata });
  assert.deepEqual(file.metadata, metadata);
  assert.ok(!Object.keys(file).includes("success"));
});

test("post-restore refresh attempts every source and distinguishes refresh failure from restore failure", async () => {
  const refreshed: string[] = [];
  const success = await refreshRestoredData([
    () => { refreshed.push("accounts"); },
    () => { refreshed.push("cloudflare"); throw new Error("refresh failed"); },
    async () => { refreshed.push("custom"); },
  ]);
  assert.equal(success, false);
  assert.deepEqual(refreshed, ["accounts", "cloudflare", "custom"]);
});

test("preview response validation rejects malformed or misleading completion payloads", () => {
  const valid = { totalAdd: 1, totalUpdate: 0, totalRemove: 0, totalConflicts: 0, canImport: true, rowCount: 1, importLimit: 500, conflictDetails: [] };
  assert.ok(isBackupPreview(valid));
  assert.equal(isBackupPreview({ ...valid, conflictDetails: "bad" }), false);
  assert.equal(isBackupPreview({ ...valid, totalAdd: -1 }), false);
  assert.equal(isBackupPreview({ ...valid, canImport: "true" }), false);
  assert.equal(isBackupPreview({ ...valid, totalConflicts: 1 }), false);
});

test("old snapshots still restore after optional metadata is removed, but actual ciphertext must remain decryptable", async t => {
  const source = await testDatabase(t), target = await testDatabase(t);
  await source.manager.importAllData(snapshot({ accounts: [account()] }));
  const exported = await source.manager.exportAllData();
  const { metadata: _metadata, ...old } = exported;
  await target.manager.importAllData(old);
  assert.equal((await target.manager.getAccounts()).length, 1);
});

test("global API-Key uniqueness is detected even when provider identities differ", async t => {
  const { manager } = await testDatabase(t);
  const incoming = snapshot({ accounts: [account(1, "same-key"), { ...account(2, "same-key"), provider: "cloudflare" }] });
  assert.equal((await manager.previewDataImport(incoming)).totalConflicts, 1);
  await assert.rejects(() => manager.importAllData(incoming), /冲突/);
  assert.equal((await manager.getAccounts()).length, 0);
});
