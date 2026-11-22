import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createD1FromSqlite } from "../../server/d1-sqlite";
import { initializeDatabase } from "../../server/initialize-database";
import { resolveNodeKey, verifyManagedKeyFile, requireSafeSqliteVersion, NodeKeyError, databaseFileExists } from "../../server/key-file";
import { validateStoredNodeKeys, preflightNodeDatabase, ensureNodeKeyMarker, assertNodeKeyMarker, NODE_KEY_CHECK } from "../../server/key-validation";
import { encryptText } from "../../src/db/crypto";
import { freshSchemaSql } from "../../src/db/schema-definition";

const KEY = "node-key-security-fixture";
const SECRET = "private-fixture-do-not-log";
function directory() {
  const base = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA!, "Temp/opencode") : tmpdir();
  return mkdtempSync(path.join(base, "domain-hub-key-security-"));
}
function fixture(t: TestContext, full = true) {
  const dir = directory(), file = path.join(dir, "domain-hub.db"), sqlite = new DatabaseSync(file);
  sqlite.exec(full ? freshSchemaSql() : `CREATE TABLE accounts(id INTEGER PRIMARY KEY,api_secret TEXT NOT NULL);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  t.after(() => { try { sqlite.close(); } catch { /* already closed */ } });
  return { dir, file, sqlite, d1: createD1FromSqlite(sqlite) };
}
function account(sqlite: DatabaseSync, cipher: string, id = 1) {
  sqlite.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(?,'fixture',?,?,'dnshe')").run(id, `fixture-${id}`, cipher);
}
async function failedProcess(dir: string, key?: string, extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dir, HOST: "127.0.0.1", PORT: "0", DISABLE_CRON: "1" };
  for (const name of ["AES_KEY", "DB_PATH", "SCHEMA_FILE", "DEFAULT_API_KEY", "DEFAULT_API_SECRET", "DEFAULT_API_ALIAS",
    "ADMIN_TOKEN", "WEBHOOK_URL", "WEBHOOK_TYPE", "ALLOWED_ORIGIN"]) delete env[name];
  if (key !== undefined) env.AES_KEY = key;
  Object.assign(env, extra);
  const child = spawn(process.execPath, ["dist-node/server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", timedOut = false;
  child.stdout.on("data", bytes => { output = (output + bytes).slice(-65536); });
  child.stderr.on("data", bytes => { output = (output + bytes).slice(-65536); });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(timedOut, false, output);
  assert.notEqual(code, 0, output);
  assert.ok(!output.includes("自建版已启动"), output);
  assert.ok(!output.includes(SECRET) && !output.includes(KEY), "failure diagnostics leaked key/secret");
  return output;
}
async function runningProcess(t: TestContext, dir: string, key?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dir, HOST: "127.0.0.1", PORT: "0", DISABLE_CRON: "1" };
  for (const name of ["AES_KEY", "DB_PATH", "SCHEMA_FILE", "DEFAULT_API_KEY", "DEFAULT_API_SECRET", "DEFAULT_API_ALIAS",
    "ADMIN_TOKEN", "WEBHOOK_URL", "WEBHOOK_TYPE", "ALLOWED_ORIGIN"]) delete env[name];
  if (key !== undefined) env.AES_KEY = key;
  const child = spawn(process.execPath, ["dist-node/server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const exit = new Promise(resolve => child.once("exit", resolve));
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 9000);
    await exit; clearTimeout(timer);
  };
  t.after(stop);
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 10000);
    const capture = (bytes: Buffer) => {
      output = (output + bytes).slice(-65536);
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(output)); });
  });
  return { stop, url: `http://127.0.0.1:${port}`, output: () => output };
}

test("read-only preflight requires a supported Node version", () => {
  for (const version of ["22.12.0", "22.19.0", "23.0.0", "24.0.0"]) requireSafeSqliteVersion(version);
  for (const version of ["22.5.0", "22.11.9", "21.0.0", "18.0.0", "invalid"]) assert.throws(() => requireSafeSqliteVersion(version), NodeKeyError);
});
test("new installation publishes one complete private key and reuses it without overwrite", () => {
  const dir = directory(), file = path.join(dir, "domain-hub.db");
  const first = resolveNodeKey(dir, file);
  assert.match(first.key, /^[a-f0-9]{64}$/);
  assert.equal(first.source, "generated");
  const bytes = readFileSync(first.keyFile);
  const second = resolveNodeKey(dir, file);
  assert.equal(second.source, "file"); assert.equal(second.key, first.key);
  assert.deepEqual(readFileSync(first.keyFile), bytes);
  assert.equal(existsSync(file), false, "key selection must not create a DB");
  if (process.platform !== "win32") assert.equal(statSync(first.keyFile).mode & 0o777, 0o600);
});
test("existing database without a key fails without creating aes.key or modifying the DB", t => {
  const { dir, file, sqlite } = fixture(t);
  sqlite.close();
  const before = readFileSync(file);
  assert.throws(() => resolveNodeKey(dir, file), /已有数据库.*缺少/);
  assert.equal(existsSync(path.join(dir, "aes.key")), false);
  assert.deepEqual(readFileSync(file), before);
});
test("empty, malformed or unreadable key files are not silently replaced", () => {
  for (const value of [Buffer.from(" \n"), Buffer.from([0xff, 0xfe]), Buffer.alloc(65537)]) {
    const dir = directory(), keyFile = path.join(dir, "aes.key");
    writeFileSync(keyFile, value);
    assert.throws(() => resolveNodeKey(dir, path.join(dir, "domain-hub.db")), NodeKeyError);
    assert.deepEqual(readFileSync(keyFile), value);
  }
  const dir = directory(); mkdirSync(path.join(dir, "aes.key"));
  assert.throws(() => resolveNodeKey(dir, path.join(dir, "domain-hub.db")), NodeKeyError);
});
test("explicit env key takes precedence but never rewrites the managed key file", t => {
  const { dir, file } = fixture(t);
  writeFileSync(path.join(dir, "aes.key"), "different-file-key\n");
  const selected = resolveNodeKey(dir, file, KEY);
  assert.equal(selected.source, "env"); assert.equal(selected.key, KEY);
  assert.equal(readFileSync(selected.keyFile, "utf8"), "different-file-key\n");
  verifyManagedKeyFile(selected);
});
test("missing main DB with WAL/journal evidence cannot be replaced", () => {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const dir = directory(), file = path.join(dir, "domain-hub.db");
    writeFileSync(file + suffix, "fixture");
    assert.throws(() => databaseFileExists(file), /日志文件/);
    assert.throws(() => resolveNodeKey(dir, file), NodeKeyError);
    assert.equal(existsSync(file), false); assert.equal(existsSync(path.join(dir, "aes.key")), false);
  }
});
test("legacy plain account/config values remain readable with an explicit key", async t => {
  const { sqlite } = fixture(t);
  account(sqlite, `plain:${btoa(SECRET)}`);
  sqlite.exec("INSERT INTO settings(key,value) VALUES('cfg_webhook_url','https://fixture.invalid'),('cfg_tg_token','legacy-token')");
  await validateStoredNodeKeys(sqlite, KEY);
});
test("correct encrypted accounts validate and wrong keys fail without revealing values", async t => {
  const { sqlite } = fixture(t);
  const cipher = await encryptText(SECRET, KEY); account(sqlite, cipher);
  await validateStoredNodeKeys(sqlite, KEY);
  await assert.rejects(() => validateStoredNodeKeys(sqlite, "wrong-key"), error =>
    error instanceof NodeKeyError && !error.message.includes(cipher) && !error.message.includes(KEY) && !error.message.includes(SECRET));
});
test("cipher validation traverses later pages rather than trusting only a sample", async t => {
  const { sqlite } = fixture(t);
  for (let i = 1; i <= 50; i++) account(sqlite, `plain:${btoa(SECRET)}`, i);
  account(sqlite, await encryptText(SECRET, KEY), 51);
  await assert.rejects(() => validateStoredNodeKeys(sqlite, "wrong-key"), /accounts.api_secret/);
});
test("read-only key failure happens before any migration or key marker", async t => {
  const { dir, file, sqlite } = fixture(t, false);
  sqlite.prepare("INSERT INTO accounts(id,api_secret) VALUES(1,?)").run(await encryptText(SECRET, KEY));
  sqlite.close();
  const before = readFileSync(file);
  await assert.rejects(() => preflightNodeDatabase(file, "wrong-key"), /解密/);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(existsSync(path.join(dir, "aes.key")), false);
  const check = new DatabaseSync(file, { readOnly: true });
  assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='domain_hub_schema_migrations'").get(), undefined);
  assert.equal(check.prepare("SELECT value FROM settings WHERE key=?").get(NODE_KEY_CHECK), undefined);
  check.close();
});
test("active and pending 2FA and encrypted notification configuration must use the same key", async t => {
  for (const name of ["auth_2fa_secret", "auth_2fa_pending", "cfg_tg_token", "cfg_webhook_url"]) {
    const data = fixture(t);
    const cipher = await encryptText(SECRET, KEY);
    const value = name === "auth_2fa_pending" ? JSON.stringify({ encrypted: cipher, expiresAt: 1 }) : cipher;
    data.sqlite.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(name, value);
    await validateStoredNodeKeys(data.sqlite, KEY);
    await assert.rejects(() => validateStoredNodeKeys(data.sqlite, "wrong-key"), /解密/);
  }
});
test("active 2FA without a secret, malformed pending data and damaged ciphers fail closed", async t => {
  for (const [name, value] of [["auth_2fa_enabled", "1"], ["auth_2fa_pending", "bad-json"],
    ["cfg_tg_token", "a".repeat(24) + ":not-hex"], ["auth_2fa_secret", "plain:invalid$"]]) {
    const data = fixture(t);
    data.sqlite.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(name, value);
    await assert.rejects(() => validateStoredNodeKeys(data.sqlite, KEY), NodeKeyError);
  }
  const data = fixture(t);
  data.sqlite.prepare("INSERT INTO settings(key,value) VALUES('cfg_tg_token',?)").run(Buffer.from("not-text"));
  await assert.rejects(() => validateStoredNodeKeys(data.sqlite, KEY), NodeKeyError);
});
test("retained outbox and staging ciphers are validated, and weak payloads cannot bypass it", async t => {
  const { sqlite } = fixture(t);
  const cipher = await encryptText(SECRET, KEY);
  sqlite.prepare(`INSERT INTO notification_outbox(id,event_key,channel,target_id,payload_cipher,status,not_before,deadline_at,created_at,updated_at)
    VALUES('id','event','webhook','target',?,'dead',0,0,0,0)`).run(cipher);
  sqlite.exec(`INSERT INTO restore_sessions(id,owner,manifest,key_id,status,expires_at,created_at) VALUES('session','owner','{}','key','uploading',0,0)`);
  sqlite.prepare("INSERT INTO restore_chunks(session_id,chunk_index,digest,normalized_digest,raw_cipher) VALUES('session',0,'d','n',?)").run(cipher);
  await validateStoredNodeKeys(sqlite, KEY);
  await assert.rejects(() => validateStoredNodeKeys(sqlite, "wrong-key"), NodeKeyError);
  sqlite.exec("UPDATE notification_outbox SET payload_cipher='plain:Zml4dHVyZQ=='");
  await assert.rejects(() => validateStoredNodeKeys(sqlite, KEY), /notification_outbox/);
});
test("first successful startup marker binds even a plain-only database to its chosen key", async t => {
  const { sqlite, d1 } = fixture(t);
  await initializeDatabase(d1);
  await ensureNodeKeyMarker(d1, KEY);
  const before = sqlite.prepare("SELECT value FROM settings WHERE key=?").get(NODE_KEY_CHECK);
  await ensureNodeKeyMarker(d1, KEY);
  assert.deepEqual(sqlite.prepare("SELECT value FROM settings WHERE key=?").get(NODE_KEY_CHECK), before);
  await assertNodeKeyMarker(d1, KEY);
  await assert.rejects(() => validateStoredNodeKeys(sqlite, "wrong-key"), NodeKeyError);
  await assert.rejects(() => ensureNodeKeyMarker(d1, "wrong-key"), NodeKeyError);
});
test("managed key removal or replacement breaks readiness but env-selected keys do not depend on that file", () => {
  const dir = directory(), selected = resolveNodeKey(dir, path.join(dir, "domain-hub.db"));
  verifyManagedKeyFile(selected);
  unlinkSync(selected.keyFile);
  assert.throws(() => verifyManagedKeyFile(selected), NodeKeyError);
  writeFileSync(selected.keyFile, "replacement");
  assert.throws(() => verifyManagedKeyFile(selected), NodeKeyError);
});
test("real Node process refuses a missing key for current and legacy database names", async t => {
  for (const name of ["domain-hub.db", "dnshe.db"]) {
    const dir = directory(), sqlite = new DatabaseSync(path.join(dir, name));
    sqlite.exec(freshSchemaSql()); sqlite.close();
    const bytes = readFileSync(path.join(dir, name));
    assert.match(await failedProcess(dir), /缺少 AES_KEY/);
    assert.equal(existsSync(path.join(dir, "aes.key")), false);
    assert.deepEqual(readFileSync(path.join(dir, name)), bytes);
  }
});
test("real Node process checks wrong keys before extension SQL and database migration", async t => {
  const { dir, file, sqlite } = fixture(t, false);
  sqlite.prepare("INSERT INTO accounts(id,api_secret) VALUES(1,?)").run(await encryptText(SECRET, KEY));
  sqlite.close();
  const before = readFileSync(file), extension = path.join(dir, "extension.sql");
  writeFileSync(extension, "CREATE TABLE must_not_run(id INTEGER);");
  assert.match(await failedProcess(dir, "wrong-key", { SCHEMA_FILE: extension }), /解密/);
  assert.deepEqual(readFileSync(file), before);
});
test("fresh process generates a stable key, becomes ready, and restarts with the same marker", async t => {
  const dir = directory();
  const first = await runningProcess(t, dir);
  assert.equal((await fetch(`${first.url}/healthz`)).status, 200);
  assert.equal((await fetch(`${first.url}/livez`)).status, 200);
  assert.match(first.output(), /自动生成/);
  await first.stop();
  const keyBytes = readFileSync(path.join(dir, "aes.key"));
  const sqlite = new DatabaseSync(path.join(dir, "domain-hub.db"), { readOnly: true });
  const marker = sqlite.prepare("SELECT value FROM settings WHERE key=?").get(NODE_KEY_CHECK);
  sqlite.close();
  const second = await runningProcess(t, dir);
  assert.equal((await fetch(`${second.url}/healthz`)).status, 200);
  assert.deepEqual(readFileSync(path.join(dir, "aes.key")), keyBytes);
  await second.stop();
  const check = new DatabaseSync(path.join(dir, "domain-hub.db"), { readOnly: true });
  assert.deepEqual(check.prepare("SELECT value FROM settings WHERE key=?").get(NODE_KEY_CHECK), marker);
  check.close();
});
test("live process reports 503 when its managed key or startup marker is damaged", async t => {
  const dir = directory(), server = await runningProcess(t, dir), keyFile = path.join(dir, "aes.key");
  const keyBytes = readFileSync(keyFile);
  unlinkSync(keyFile);
  assert.equal((await fetch(`${server.url}/healthz`)).status, 503);
  assert.equal((await fetch(`${server.url}/livez`)).status, 200);
  writeFileSync(keyFile, keyBytes);
  assert.equal((await fetch(`${server.url}/healthz`)).status, 200);
  const sqlite = new DatabaseSync(path.join(dir, "domain-hub.db"));
  sqlite.prepare("UPDATE settings SET value='plain:Zml4dHVyZQ==' WHERE key=?").run(NODE_KEY_CHECK);
  sqlite.close();
  const bad = await fetch(`${server.url}/healthz`);
  assert.equal(bad.status, 503);
  assert.ok(!(await bad.text()).includes(keyBytes.toString().trim()));
});
test("legacy plain-only DB accepts an explicit key once, then refuses a different key on restart", async t => {
  const { dir, sqlite } = fixture(t);
  account(sqlite, `plain:${btoa(SECRET)}`); sqlite.close();
  const server = await runningProcess(t, dir, KEY);
  assert.equal((await fetch(`${server.url}/healthz`)).status, 200);
  assert.equal(existsSync(path.join(dir, "aes.key")), false, "env keys must not be silently persisted");
  await server.stop();
  assert.match(await failedProcess(dir, "different-key"), /node_aes_key_check.*解密/);
});
test("concurrent fresh processes share one complete published key", async t => {
  const dir = directory();
  const [one, two] = await Promise.all([runningProcess(t, dir), runningProcess(t, dir)]);
  assert.equal((await fetch(`${one.url}/healthz`)).status, 200);
  assert.equal((await fetch(`${two.url}/healthz`)).status, 200);
  const stored = readFileSync(path.join(dir, "aes.key"), "utf8").trim();
  assert.match(stored, /^[a-f0-9]{64}$/);
  assert.ok(!one.output().includes(stored) && !two.output().includes(stored));
});
