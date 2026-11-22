import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../../src/index";
import { DatabaseManager } from "../../src/db";
import { encryptText, decryptText } from "../../src/db/crypto";
import { base32ToUint8Array } from "../../src/auth/totp";
import { ConflictError } from "../../src/errors";
import { testDatabase, failDatabaseOperation, TEST_AES_KEY, TEST_PASSWORD } from "../helpers/database";

const executionCtx = {
  waitUntil(promise: Promise<unknown>) { void promise.catch(() => {}); },
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

function request(d1: D1Database, route: string, body?: unknown, token?: string, aesKey: string | undefined = TEST_AES_KEY) {
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (route === "/api/auth/setup") headers.set("Authorization", "Bearer isolated-setup-token-for-security-tests");
  return worker.fetch(new Request(`http://localhost${route}`, {
    method: body === undefined ? "GET" : "POST", headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { DB: d1, AES_KEY: aesKey, SETUP_TOKEN: "isolated-setup-token-for-security-tests" }, executionCtx);
}

async function totp(secret: string) {
  const key = await crypto.subtle.importKey("raw", base32ToUint8Array(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = new ArrayBuffer(8);
  new DataView(counter).setBigUint64(0, BigInt(Math.floor(Date.now() / 30000)), false);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = digest[digest.length - 1] & 15;
  const value = new DataView(digest.buffer).getUint32(offset, false) & 0x7fffffff;
  return String(value % 1000000).padStart(6, "0");
}

async function enableFixture(manager: DatabaseManager) {
  await manager.setPassword("admin", TEST_PASSWORD);
  await manager.setTwoFaSecret("JBSWY3DPEHPK3PXP");
  const pending = await manager.getPendingTwoFa();
  assert.ok(pending);
  await manager.setTwoFaEnabled(true, pending.value);
  return manager.createSession();
}

test("auth read outage returns 503 and cannot reinitialize an existing administrator", async t => {
  const { d1, manager } = await testDatabase(t);
  await manager.setPassword("original", TEST_PASSWORD);
  const failing = failDatabaseOperation(d1, sql => sql.includes("SELECT key, value FROM settings WHERE key IN"), "all");
  const response = await request(failing, "/api/auth/setup", { username: "replacement", password: "replacement-password" });
  assert.equal(response.status, 503);
  assert.equal((await manager.getAuthConfig()).username, "original");
  assert.equal(await manager.verifyPassword(TEST_PASSWORD), true);
  assert.equal((await request(failing, "/api/auth/status")).status, 503);
  assert.equal((await request(failing, "/api/auth/login", { username: "original", password: TEST_PASSWORD })).status, 503);
});

test("20 concurrent setup requests create exactly one administrator and one session", async t => {
  const { d1, manager } = await testDatabase(t);
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    request(d1, "/api/auth/setup", { username: `admin${i}`, password: `password-${i}` })));
  const winner = responses.findIndex(response => response.status === 200);
  assert.ok(winner >= 0);
  assert.equal(responses.filter(response => response.status === 200).length, 1);
  assert.ok(responses.every(response => [200, 403, 409].includes(response.status)));
  assert.equal((await manager.getAuthConfig()).username, `admin${winner}`);
  assert.equal(await manager.verifyPassword(`password-${winner}`), true);
  const sessions = await manager.allRaw<{ n: number }>("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'sess_%'");
  assert.equal(sessions[0].n, 1);
});

test("credential failure rolls back the setup claim, username, hash and salt", async t => {
  const { sqlite, d1, manager } = await testDatabase(t);
  sqlite.exec(`CREATE TRIGGER fail_salt BEFORE INSERT ON settings WHEN NEW.key='auth_pass_salt'
    BEGIN SELECT RAISE(ABORT, 'Injected password failure'); END`);
  const response = await request(d1, "/api/auth/setup", { username: "admin", password: TEST_PASSWORD });
  assert.equal(response.status, 500);
  assert.equal((await manager.getAuthConfig()).initialized, false);
  assert.equal(await manager.getSetting("auth_setup_claim"), null);
  sqlite.exec("DROP TRIGGER fail_salt");
  assert.equal((await request(d1, "/api/auth/setup", { username: "admin", password: TEST_PASSWORD })).status, 200);
});

test("password changes are atomic when a later field write fails", async t => {
  const { sqlite, manager } = await testDatabase(t);
  await manager.setPassword("original", TEST_PASSWORD);
  sqlite.exec(`CREATE TRIGGER fail_salt BEFORE INSERT ON settings WHEN NEW.key='auth_pass_salt'
    BEGIN SELECT RAISE(ABORT, 'Injected password failure'); END`);
  await assert.rejects(() => manager.setPassword("replacement", "replacement-password"));
  assert.equal((await manager.getAuthConfig()).username, "original");
  assert.equal(await manager.verifyPassword(TEST_PASSWORD), true);
});

test("partial legacy credentials fail closed rather than offering setup", async t => {
  const { d1, manager } = await testDatabase(t);
  await manager.setSetting("auth_username", "existing-admin");
  assert.equal((await request(d1, "/api/auth/status")).status, 503);
  assert.equal((await request(d1, "/api/auth/setup", { username: "replacement", password: TEST_PASSWORD })).status, 503);
});

test("setting and session writes propagate failures instead of returning success", async t => {
  const { d1 } = await testDatabase(t);
  const failing = failDatabaseOperation(d1, () => true, "run");
  const manager = new DatabaseManager(failing, TEST_AES_KEY);
  await assert.rejects(() => manager.setSetting("probe", "value"));
  await assert.rejects(() => manager.createSession());
});

test("session read outage returns 503 without treating the valid session as expired", async t => {
  const { d1, manager } = await testDatabase(t);
  const token = await manager.createSession();
  const failing = failDatabaseOperation(d1, sql => sql.includes("SELECT value FROM settings WHERE key ="), "first");
  assert.equal((await request(failing, "/api/accounts", undefined, token)).status, 503);
  assert.equal(await manager.validateSession(token), true);
});

test("enabled 2FA cannot be replaced through setup, including direct DAO access", async t => {
  const { d1, manager } = await testDatabase(t);
  const session = await enableFixture(manager);
  const before = await manager.getAuthConfig();
  assert.equal((await request(d1, "/api/auth/2fa/setup", { password: TEST_PASSWORD }, session)).status, 409);
  await assert.rejects(() => manager.setTwoFaSecret("GEZDGNBVGY3TQOJQ"), ConflictError);
  assert.equal((await manager.getAuthConfig()).twoFaSecretCipher, before.twoFaSecretCipher);
});

test("2FA setup requires password, stays pending, and activates only after a valid TOTP", async t => {
  const { d1, manager } = await testDatabase(t);
  await manager.setPassword("admin", TEST_PASSWORD);
  const session = await manager.createSession();
  assert.equal((await request(d1, "/api/auth/2fa/setup", {}, session)).status, 401);
  const setup = await request(d1, "/api/auth/2fa/setup", { password: TEST_PASSWORD }, session);
  assert.equal(setup.status, 200);
  const { secret } = await setup.json() as { secret: string };
  assert.equal((await manager.getAuthConfig()).twoFaEnabled, false);
  assert.equal((await manager.getAuthConfig()).twoFaSecret, "");
  assert.equal((await request(d1, "/api/auth/2fa/enable", { token: "invalid" }, session)).status, 401);
  assert.equal((await manager.getAuthConfig()).twoFaEnabled, false);
  assert.equal((await request(d1, "/api/auth/2fa/enable", { token: await totp(secret) }, session)).status, 200);
  assert.equal((await manager.getAuthConfig()).twoFaSecret, secret);
  assert.equal(await manager.getPendingTwoFa(), null);
  assert.equal((await request(d1, "/api/auth/login", { username: "admin", password: TEST_PASSWORD })).status, 401);
  assert.equal((await request(d1, "/api/auth/login", { username: "admin", password: TEST_PASSWORD, token: await totp(secret) })).status, 200);
});

test("expired and replaced pending secrets cannot be activated", async t => {
  const { manager } = await testDatabase(t);
  await manager.setPassword("admin", TEST_PASSWORD);
  await manager.setTwoFaSecret("JBSWY3DPEHPK3PXP");
  const old = await manager.getPendingTwoFa();
  assert.ok(old);
  await manager.setTwoFaSecret("GEZDGNBVGY3TQOJQ");
  await assert.rejects(() => manager.setTwoFaEnabled(true, old.value), ConflictError);
  const current = await manager.getPendingTwoFa();
  assert.ok(current);
  const expired = JSON.stringify({ ...JSON.parse(current.value), expiresAt: Math.floor(Date.now() / 1000) - 1 });
  await manager.setSetting("auth_2fa_pending", expired);
  assert.equal(await manager.getPendingTwoFa(), null);
  await assert.rejects(() => manager.setTwoFaEnabled(true, expired), ConflictError);
  assert.equal((await manager.getAuthConfig()).twoFaEnabled, false);
  assert.equal((await manager.getAuthConfig()).twoFaSecretCipher, "");
});

test("concurrent 2FA activation has a single winner without changing the active secret", async t => {
  const { manager } = await testDatabase(t);
  await manager.setPassword("admin", TEST_PASSWORD);
  await manager.setTwoFaSecret("JBSWY3DPEHPK3PXP");
  const pending = await manager.getPendingTwoFa();
  assert.ok(pending);
  const results = await Promise.allSettled([manager.setTwoFaEnabled(true, pending.value), manager.setTwoFaEnabled(true, pending.value)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await manager.getAuthConfig()).twoFaSecret, pending.secret);
});

test("2FA activation failure rolls back enabled state and retains pending setup", async t => {
  const { sqlite, manager } = await testDatabase(t);
  await manager.setPassword("admin", TEST_PASSWORD);
  await manager.setTwoFaSecret("JBSWY3DPEHPK3PXP");
  const pending = await manager.getPendingTwoFa();
  assert.ok(pending);
  sqlite.exec(`CREATE TRIGGER fail_active_secret BEFORE INSERT ON settings WHEN NEW.key='auth_2fa_secret'
    BEGIN SELECT RAISE(ABORT, 'Injected 2FA failure'); END`);
  await assert.rejects(() => manager.setTwoFaEnabled(true, pending.value));
  assert.equal((await manager.getAuthConfig()).twoFaEnabled, false);
  assert.equal((await manager.getPendingTwoFa())?.value, pending.value);
  assert.equal(await manager.getSetting("auth_2fa_transition"), null);
});

test("2FA disable requires password and old TOTP, then clears active and pending secrets", async t => {
  const { d1, manager } = await testDatabase(t);
  const session = await enableFixture(manager);
  const cfg = await manager.getAuthConfig();
  const token = await totp(cfg.twoFaSecret);
  assert.equal((await request(d1, "/api/auth/2fa/disable", { token }, session)).status, 401);
  assert.equal((await request(d1, "/api/auth/2fa/disable", { token: "invalid", password: TEST_PASSWORD }, session)).status, 401);
  assert.equal((await manager.getAuthConfig()).twoFaEnabled, true);
  assert.equal((await request(d1, "/api/auth/2fa/disable", { token, password: TEST_PASSWORD }, session)).status, 200);
  assert.equal((await manager.getAuthConfig()).twoFaEnabled, false);
  assert.equal(await manager.getSetting("auth_2fa_secret"), "");
});

test("stale 2FA disable cannot clear a new active verifier", async t => {
  const { manager } = await testDatabase(t);
  await enableFixture(manager);
  const old = await manager.getAuthConfig();
  await manager.setTwoFaEnabled(false, old.twoFaSecretCipher!);
  await manager.setTwoFaSecret("GEZDGNBVGY3TQOJQ");
  const next = await manager.getPendingTwoFa();
  assert.ok(next);
  await manager.setTwoFaEnabled(true, next.value);
  await assert.rejects(() => manager.setTwoFaEnabled(false, old.twoFaSecretCipher!), ConflictError);
  assert.equal((await manager.getAuthConfig()).twoFaSecret, next.secret);
});

test("wrong AES key or missing active 2FA secret blocks login with 503", async t => {
  const { d1, manager } = await testDatabase(t);
  await enableFixture(manager);
  assert.equal((await request(d1, "/api/auth/login", { username: "admin", password: TEST_PASSWORD }, undefined, "wrong-key")).status, 503);
  await manager.deleteSetting("auth_2fa_secret");
  assert.equal((await request(d1, "/api/auth/login", { username: "admin", password: TEST_PASSWORD })).status, 503);
});

test("new secrets require AES_KEY while historical plain: values remain readable", async t => {
  const { d1 } = await testDatabase(t);
  await assert.rejects(() => encryptText("secret"));
  const noKey = new DatabaseManager(d1);
  await assert.rejects(() => noKey.setAppSetting("tg_token", "new-token"));
  assert.equal(await noKey.getSetting("cfg_tg_token"), null);
  assert.equal(await decryptText("plain:c2VjcmV0"), "secret");
});

test("expired login failure counter resets on the next failed attempt", async t => {
  const { d1, manager } = await testDatabase(t);
  await d1.prepare("INSERT INTO cache(key,value,expires_at) VALUES (?, '5', ?)")
    .bind("login_fail:test", Math.floor(Date.now() / 1000) - 1).run();
  assert.equal(await manager.countLoginFailures("test"), 0);
  assert.equal(await manager.recordLoginFailure("test"), 1);
  assert.equal(await manager.recordLoginFailure("test"), 2);
});
