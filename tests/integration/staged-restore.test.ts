import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { testDatabase, TEST_AES_KEY } from "../helpers/database";
import { StagedRestore } from "../../src/db/dao/restore-dao";
import { sha256Hex, decryptText } from "../../src/db/crypto";
import { planStagedRestore, prepareStagedRestore, restoreRequest, restoreStorageKey } from "../../frontend/src/features/data/utils/staged-restore";
import { RESTORE_MAX_BYTES } from "../../shared/restore-wire";
import { base32ToUint8Array } from "../../src/auth/totp";
import worker from "../../src/index";

const owner = "a".repeat(64), other = "b".repeat(64);
const account = (id = 1, key = `key-${id}`) => ({ id, alias: `account-${id}`, api_key: key, api_secret: "plain:c2VjcmV0", provider: "dnshe" });
const domain = (id: number) => ({ id, account_id: 1, subdomain: `test${id}`, rootdomain: "us.ci", full_domain: `test${id}.us.ci`, status: "active", expires_at: "" });
const snapshot = (count = 25) => ({ version: 1, data: { accounts: [account()], domains_cache: Array.from({ length: count }, (_, i) => domain(100 + i)) } });

async function fixture(t: TestContext, source: unknown = snapshot()) {
  const database = await testDatabase(t);
  const plan = await planStagedRestore(source);
  const id = crypto.randomUUID(), restore = database.manager.stagedRestore();
  await restore.create(id, owner, plan.manifest);
  return { ...database, plan, id, restore };
}
async function uploaded(t: TestContext, source: unknown = snapshot()) {
  const result = await fixture(t, source);
  for (const [index, rows] of result.plan.chunks.entries()) await result.restore.upload(result.id, owner, index, rows);
  return result;
}
async function ready(t: TestContext, source: unknown = snapshot()) {
  const result = await uploaded(t, source);
  assert.equal((await result.restore.validate(result.id, owner)).status, "ready");
  return result;
}
function fakeStorage(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); });
  return values;
}

test("creation is idempotent for the same manifest and session, but not for a different file", async t => {
  const { restore, id, plan, manager } = await fixture(t);
  assert.equal((await restore.create(id, owner, plan.manifest)).id, id);
  await assert.rejects(() => restore.create(id, owner, { ...plan.manifest, digest: "0".repeat(64) }), /不同快照/);
  assert.equal((await manager.getAccounts()).length, 0);
});

test("uploads write staging only and keep raw legacy chunks encrypted", async t => {
  const { restore, id, plan, manager } = await fixture(t);
  await restore.upload(id, owner, 0, plan.chunks[0]);
  assert.equal((await manager.getAccounts()).length, 0);
  const chunk = await manager.firstRaw<{ raw_cipher: string }>("SELECT raw_cipher FROM restore_chunks");
  assert.ok(!chunk!.raw_cipher.includes("plain:"));
  assert.ok((await decryptText(chunk!.raw_cipher, TEST_AES_KEY)).includes("plain:"));
  const staged = await manager.firstRaw<{ payload: string }>("SELECT payload FROM restore_rows");
  assert.ok(!JSON.parse(staged!.payload).api_secret.startsWith("plain:"));
});

test("bad chunk digests, lengths and out-of-order chunks cannot advance the cursor", async t => {
  const { restore, id, plan } = await fixture(t);
  await assert.rejects(() => restore.upload(id, owner, 0, []), /长度或摘要/);
  await assert.rejects(() => restore.upload(id, owner, 0, [{ ...account(), alias: "tampered" }]), /长度或摘要/);
  await assert.rejects(() => restore.upload(id, owner, 1, plan.chunks[1]), /next_chunk/);
  assert.equal((await restore.get(id, owner)).next_chunk, 0);
});

test("retrying a stored chunk is idempotent and does not duplicate rows", async t => {
  const { restore, id, plan, manager } = await fixture(t);
  await restore.upload(id, owner, 0, plan.chunks[0]);
  await restore.upload(id, owner, 0, plan.chunks[0]);
  assert.equal((await restore.get(id, owner)).next_chunk, 1);
  assert.equal((await manager.firstRaw<{ n: number }>("SELECT COUNT(*) n FROM restore_rows"))?.n, 1);
});

test("failed chunk transaction rolls back rows, chunk marker and cursor together", async t => {
  const { restore, id, plan, d1, manager } = await fixture(t);
  const failing = new Proxy(d1, { get(target, key) {
    if (key === "prepare") return (sql: string) => target.prepare(sql.startsWith("INSERT INTO restore_rows") ? sql.replace("restore_rows", "injected_missing_table") : sql);
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(() => new StagedRestore(failing, TEST_AES_KEY).upload(id, owner, 0, plan.chunks[0]), /injected_missing_table/);
  assert.equal((await restore.get(id, owner)).next_chunk, 0);
  assert.equal((await manager.firstRaw<{ n: number }>("SELECT COUNT(*) n FROM restore_chunks"))?.n, 0);
});

test("duplicates across chunks reject the entire offending chunk", async t => {
  const source = { version: 1, data: { accounts: [account()], domains_cache: [...Array.from({ length: 20 }, (_, i) => domain(i + 1)), domain(1)] } };
  const { restore, id, plan, manager } = await fixture(t, source);
  await restore.upload(id, owner, 0, plan.chunks[0]);
  await restore.upload(id, owner, 1, plan.chunks[1]);
  await assert.rejects(() => restore.upload(id, owner, 2, plan.chunks[2]), /重复 ID 或业务身份/);
  assert.equal((await restore.get(id, owner)).next_chunk, 2);
  assert.equal((await manager.getAccounts()).length, 0);
});

test("incomplete upload cannot validate or commit", async t => {
  const { restore, id } = await fixture(t);
  await assert.rejects(() => restore.validate(id, owner), /未上传齐/);
  await assert.rejects(() => restore.commit(id, owner), /尚未通过/);
});

test("total snapshot digest is checked before readiness or business writes", async t => {
  const { restore, plan, manager } = await fixture(t);
  const id = crypto.randomUUID();
  await restore.create(id, owner, { ...plan.manifest, digest: "0".repeat(64) });
  for (const [index, rows] of plan.chunks.entries()) await restore.upload(id, owner, index, rows);
  await assert.rejects(() => restore.validate(id, owner), /总摘要/);
  assert.equal((await manager.getAccounts()).length, 0);
});

test("source metadata checksum remains verified after chunk reconstruction", async t => {
  const sourceDb = await testDatabase(t);
  await sourceDb.manager.importAllData({ version: 1, data: { accounts: [account()] } });
  const source = await sourceDb.manager.exportAllData();
  source.metadata!.checksum = "0".repeat(64);
  const { restore, id, manager } = await uploaded(t, source);
  await assert.rejects(() => restore.validate(id, owner), /校验和/);
  assert.equal((await manager.getAccounts()).length, 0);
});

test("target identities and dangling references are real validation conflicts", async t => {
  const { restore, id, manager } = await uploaded(t);
  await manager.importAllData({ version: 1, data: { accounts: [account(1, "unrelated")] } });
  const state = await restore.validate(id, owner);
  assert.equal(state.status, "uploading");
  assert.ok(state.result?.diff?.totalConflicts);
  await assert.rejects(() => restore.commit(id, owner), /尚未通过/);
  assert.equal((await manager.getAccounts())[0].api_key, "unrelated");
});

test("over 500 rows restore in one business transaction rather than one statement per row", async t => {
  const { restore, id, manager, d1 } = await ready(t, snapshot(601));
  const queries: string[] = [];
  const observed = new Proxy(d1, { get(target, key) {
    if (key === "prepare") return (sql: string) => { queries.push(sql); return target.prepare(sql); };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const result = await new StagedRestore(observed, TEST_AES_KEY).commit(id, owner);
  assert.equal(result.status, "committed");
  assert.equal(result.result?.imported?.domains_cache, 601);
  assert.equal((await manager.getDomains()).length, 601);
  assert.equal(queries.filter(sql => sql.startsWith("INSERT INTO")).length, 5);
  assert.ok(queries.length < 20);
  assert.equal((await manager.firstRaw<{ n: number }>("SELECT COUNT(*) n FROM restore_rows"))?.n, 0);
});

test("10,000-row restore stays bounded and keeps all records", { timeout: 30000 }, async t => {
  const { restore, id, manager } = await ready(t, snapshot(9999));
  await restore.commit(id, owner);
  assert.equal((await manager.getDomains()).length, 9999);
  assert.equal((await manager.getAccounts()).length, 1);
});

test("a final-commit SQL error rolls back earlier tables and leaves staging resumable", async t => {
  const { restore, id, d1, manager } = await ready(t);
  const failing = new Proxy(d1, { get(target, key) {
    if (key === "prepare") return (sql: string) => target.prepare(sql.startsWith("INSERT INTO domains_cache") ? sql.replace("INSERT INTO domains_cache", "INSERT INTO injected_missing_table") : sql);
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(() => new StagedRestore(failing, TEST_AES_KEY).commit(id, owner), /injected_missing_table/);
  assert.equal((await manager.getAccounts()).length, 0);
  assert.equal((await restore.get(id, owner)).status, "ready");
  await restore.commit(id, owner);
  assert.equal((await manager.getAccounts()).length, 1);
});

test("a target identity race during final commit aborts all inserts but preserves concurrent work", async t => {
  const { restore, id, d1, manager } = await ready(t, { version: 1, data: { accounts: [account(), account(2)] } });
  let batches = 0;
  const raced = new Proxy(d1, { get(target, key) {
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      if (++batches === 2) await target.prepare("INSERT INTO accounts(id,alias,api_key,api_secret) VALUES(2,'concurrent','unrelated','plain:c2VjcmV0')").run();
      return target.batch(statements);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(() => new StagedRestore(raced, TEST_AES_KEY).commit(id, owner), /整批已回滚/);
  assert.deepEqual((await manager.getAccounts()).map(row => row.api_key), ["unrelated"]);
  assert.equal((await restore.get(id, owner)).status, "ready");
});

test("concurrent commit retries return the same committed result and cannot duplicate data", async t => {
  const { restore, id, manager } = await ready(t);
  const states = await Promise.all([restore.commit(id, owner), restore.commit(id, owner)]);
  assert.ok(states.every(state => state.status === "committed"));
  assert.equal((await manager.getAccounts()).length, 1);
  assert.equal((await manager.getDomains()).length, 25);
});

test("cancellation purges staging, blocks later commit and cannot roll back completed business data", async t => {
  const first = await ready(t), second = await ready(t);
  assert.equal((await first.restore.cancel(first.id, owner)).status, "cancelled");
  await assert.rejects(() => first.restore.commit(first.id, owner), /尚未通过/);
  assert.equal((await first.manager.firstRaw<{ n: number }>("SELECT COUNT(*) n FROM restore_rows"))?.n, 0);
  await second.restore.commit(second.id, owner);
  assert.equal((await second.restore.cancel(second.id, owner)).status, "committed");
  assert.equal((await second.manager.getDomains()).length, 25);
});

test("every session operation is bound to the originating login session", async t => {
  const { restore, id, plan } = await fixture(t);
  for (const operation of [
    () => restore.get(id, other), () => restore.upload(id, other, 0, plan.chunks[0]),
    () => restore.validate(id, other), () => restore.commit(id, other), () => restore.cancel(id, other),
  ]) await assert.rejects(operation, /不属于当前登录会话/);
});

test("expiry blocks stale upload and creation cleans only expired staging", async t => {
  const { d1, plan, manager } = await fixture(t);
  let now = Date.now();
  const restore = new StagedRestore(d1, TEST_AES_KEY, () => now), id = crypto.randomUUID();
  await restore.create(id, other, plan.manifest);
  await restore.upload(id, other, 0, plan.chunks[0]);
  now += 3600001;
  await assert.rejects(() => restore.get(id, other), /已过期/);
  await assert.rejects(() => restore.upload(id, other, 1, plan.chunks[1]), /已过期/);
  await restore.create(crypto.randomUUID(), other, plan.manifest);
  assert.equal(await manager.firstRaw("SELECT id FROM restore_sessions WHERE id=?", [id]), null);
  assert.equal((await manager.getAccounts()).length, 0);
});

test("session and payload budgets reject excess work without partial staging", async t => {
  const { restore, id, plan, manager } = await fixture(t);
  await restore.create(crypto.randomUUID(), owner, plan.manifest);
  await assert.rejects(() => restore.create(crypto.randomUUID(), owner, plan.manifest), /会话过多/);
  await manager.executeRaw("UPDATE restore_sessions SET uploaded_bytes=? WHERE id=?", [RESTORE_MAX_BYTES, id]);
  await assert.rejects(() => restore.upload(id, owner, 0, plan.chunks[0]), /8MB/);
  assert.equal((await restore.get(id, owner)).next_chunk, 0);
});

test("key changes mid-session cannot decrypt or commit a pending restore", async t => {
  const { d1, id } = await fixture(t);
  await assert.rejects(() => new StagedRestore(d1, "changed-key").get(id, owner), /AES_KEY 已改变/);
});

test("client resumes from persisted server cursor after a lost chunk request", async t => {
  fakeStorage(t);
  const { d1, manager } = await testDatabase(t), token = await manager.createSession();
  let fail = true;
  const calls: string[] = [];
  const api = async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (fail && url.endsWith("/chunks/1")) { fail = false; throw new Error("network unavailable"); }
    const headers = new Headers(init?.headers); headers.set("Authorization", `Bearer ${token}`);
    return worker.fetch(new Request(`http://localhost${url}`, { ...init, headers }), { DB: d1, AES_KEY: TEST_AES_KEY },
      { waitUntil() {}, props: {} } as unknown as ExecutionContext);
  };
  const source = snapshot(41);
  const options = { isCurrent: () => true, onSession() {}, onProgress() {}, onStorageFailure: () => assert.fail("storage failure") };
  await assert.rejects(() => prepareStagedRestore(api, source, "", "test-reference", options), /network unavailable/);
  calls.length = 0;
  const state = await prepareStagedRestore(api, source, "", "test-reference", options);
  assert.equal(state.status, "ready");
  assert.ok(!calls.some(url => url.endsWith("/chunks/0")));
  assert.equal((await manager.getAccounts()).length, 0);
  assert.equal((await restoreRequest(api, `${state.id}/commit`, {})).session.status, "committed");
  assert.equal((await manager.getDomains()).length, 41);
  assert.notEqual(await restoreStorageKey("https://one", token), await restoreStorageKey("https://two", token));
});

test("client detects a changed file during upload and does not submit business data", async t => {
  fakeStorage(t);
  const { d1, manager } = await testDatabase(t), token = await manager.createSession();
  let current = true;
  const api = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers); headers.set("Authorization", `Bearer ${token}`);
    const response = await worker.fetch(new Request(`http://localhost${url}`, { ...init, headers }), { DB: d1, AES_KEY: TEST_AES_KEY },
      { waitUntil() {}, props: {} } as unknown as ExecutionContext);
    if (url.endsWith("/chunks/0")) current = false;
    return response;
  };
  await assert.rejects(() => prepareStagedRestore(api, snapshot(41), "", "changed-reference", {
    isCurrent: () => current, onSession() {}, onProgress() {}, onStorageFailure() {},
  }), /文件选择已改变/);
  assert.equal((await manager.getAccounts()).length, 0);
});

test("wire planner enforces row and single-record size limits before creating a session", async () => {
  await assert.rejects(() => planStagedRestore(snapshot(10000)), /10,000 行/);
  await assert.rejects(() => planStagedRestore({ version: 1, data: { accounts: [{ ...account(), alias: "x".repeat(300000) }] } }), /单行超过/);
});

test("mixed custom accounts, nullable domains and date overrides keep their references in bulk restore", async t => {
  const source = { version: 1, data: {
    accounts: [{ ...account(), provider: "custom" }],
    custom_accounts: [{ id: 10, group_id: 1, name: "manual" }],
    custom_domains: [
      { id: 20, group_id: 1, account_id: 10, full_domain: "one.us.ci", expires_at: "2030-01-01" },
      { id: 21, group_id: 1, account_id: null, full_domain: "two.us.ci", expires_at: "2031-01-01" },
    ],
    domain_date_overrides: [{ id: 30, account_id: 1, full_domain: "one.us.ci", source: "keep me" }],
  } };
  const { restore, id, manager } = await ready(t, source);
  await restore.commit(id, owner);
  assert.equal((await manager.listAllCustomDomains()).length, 2);
  assert.equal((await manager.getDateOverrides())[0].source, "keep me");
});

test("a cancellation racing final commit wins safely when it commits first", async t => {
  const { restore, id, d1, manager } = await ready(t);
  let batches = 0;
  const raced = new Proxy(d1, { get(target, key) {
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      if (++batches === 2) await restore.cancel(id, owner);
      return target.batch(statements);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(() => new StagedRestore(raced, TEST_AES_KEY).commit(id, owner), /改变或取消/);
  assert.equal((await manager.getAccounts()).length, 0);
  assert.equal((await restore.get(id, owner)).status, "cancelled");
});

test("the final HTTP commit requires current 2FA and does not accept an empty token", async t => {
  const { d1, manager } = await testDatabase(t);
  const token = await manager.createSession(), sessionOwner = await sha256Hex(token), id = crypto.randomUUID();
  const restore = manager.stagedRestore(), plan = await planStagedRestore(snapshot());
  await restore.create(id, sessionOwner, plan.manifest);
  for (const [index, rows] of plan.chunks.entries()) await restore.upload(id, sessionOwner, index, rows);
  await restore.validate(id, sessionOwner);
  const secret = "JBSWY3DPEHPK3PXP";
  await manager.setTwoFaSecret(secret);
  await manager.setTwoFaEnabled(true, (await manager.getPendingTwoFa())!.value);
  const api = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers); headers.set("Authorization", `Bearer ${token}`);
    return worker.fetch(new Request(`http://localhost${url}`, { ...init, headers }), { DB: d1, AES_KEY: TEST_AES_KEY },
      { waitUntil() {}, props: {} } as unknown as ExecutionContext);
  };
  await assert.rejects(() => restoreRequest(api, `${id}/commit`, { token: "" }), /6 位动态/);
  assert.equal((await manager.getAccounts()).length, 0);
  const key = await crypto.subtle.importKey("raw", base32ToUint8Array(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = new ArrayBuffer(8);
  new DataView(counter).setBigUint64(0, BigInt(Math.floor(Date.now() / 30000)), false);
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = signed[signed.length - 1] & 15;
  const code = String((new DataView(signed.buffer).getUint32(offset, false) & 0x7fffffff) % 1000000).padStart(6, "0");
  assert.equal((await restoreRequest(api, `${id}/commit`, { token: code })).session.status, "committed");
});

test("a new restore session can repeat a large snapshot without duplicates or loss of target-only rows", async t => {
  const source = snapshot(601);
  const { restore, id, plan, manager } = await ready(t, source);
  await restore.commit(id, owner);
  await manager.importAllData({ version: 1, data: { accounts: [account(2)] } });
  const second = crypto.randomUUID();
  await restore.create(second, owner, plan.manifest);
  for (const [index, rows] of plan.chunks.entries()) await restore.upload(second, owner, index, rows);
  await restore.validate(second, owner);
  await restore.commit(second, owner);
  assert.equal((await manager.getDomains()).length, 601);
  assert.equal((await manager.getAccounts()).length, 2);
});

test("a commit near the upload deadline retains its success receipt instead of reporting expiry", async t => {
  const { d1, plan, manager } = await fixture(t, snapshot(0));
  let now = Date.now(), start = now;
  const restore = new StagedRestore(d1, TEST_AES_KEY, () => now), id = crypto.randomUUID();
  await restore.create(id, other, plan.manifest);
  await restore.upload(id, other, 0, plan.chunks[0]);
  await restore.validate(id, other);
  now = start + 3599999;
  await restore.commit(id, other);
  now = start + 3601000;
  assert.equal((await restore.get(id, other)).status, "committed");
  assert.equal((await new StagedRestore(d1, "rotated-after-commit", () => now).get(id, other)).status, "committed");
  assert.equal((await manager.getAccounts()).length, 1);
});

test("manifest whitelisting prevents extra secrets or invented imported tables in plaintext metadata", async t => {
  const { restore, plan } = await fixture(t);
  for (const manifest of [
    { ...plan.manifest, header: { ...plan.manifest.header, api_secret: "never-store-me" } },
    { ...plan.manifest, counts: { ...plan.manifest.counts, settings: 999 } },
    { ...plan.manifest, chunks: plan.manifest.chunks.map(chunk => ({ ...chunk, api_secret: "never-store-me" })) },
  ]) await assert.rejects(() => restore.create(crypto.randomUUID(), other, manifest), /不支持的字段|分块描述/);
});
