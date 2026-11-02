import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { backupFromEnvironment, decryptSecretEnvelope, encryptSecretEnvelope } from "./backup-secret-envelope.mjs";
const pair = bits => generateKeyPairSync("rsa", { modulusLength: bits, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const keys = pair(3072), other = pair(3072);
const context = { accountId: "a".repeat(32), databaseId: "00000000-0000-4000-8000-000000000001", worker: "domain-hub", sourceSha: "b".repeat(40), repository: "lioil522/domain-hub", secretName: "AES_KEY" };
const secret = "synthetic-only AES recovery test secret";
const encrypt = () => encryptSecretEnvelope(secret, keys.publicKey, context);
test("envelope round trip preserves original material including whitespace", () => {
  const text = " \nsynthetic-test-only-secret\r\n ";
  assert.equal(decryptSecretEnvelope(encryptSecretEnvelope(text, keys.publicKey, context), keys.privateKey, context), text);
});
test("artifact does not contain plaintext, private key or unwrapped encryption key", () => {
  const serialized = JSON.stringify(encrypt());
  assert.ok(!serialized.includes(secret) && !serialized.includes("PRIVATE KEY"));
  assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), ["algorithm", "ciphertext", "format", "iv", "metadata", "tag", "wrappedKey"]);
});
test("fresh encryptions have distinct nonces and wrapped keys", () => {
  const one = encrypt(), two = encrypt(); assert.notEqual(one.iv, two.iv); assert.notEqual(one.wrappedKey, two.wrappedKey);
});
test("wrong recipient fails", () => assert.throws(() => decryptSecretEnvelope(encrypt(), other.privateKey, context)));
for (const field of ["ciphertext", "tag", "iv", "wrappedKey"]) test(`tampered ${field} fails`, () => {
  const envelope = encrypt(), bytes = Buffer.from(envelope[field], "base64"); bytes[0] ^= 1; envelope[field] = bytes.toString("base64");
  assert.throws(() => decryptSecretEnvelope(envelope, keys.privateKey, context));
});
test("tampered authenticated metadata fails", () => {
  const envelope = encrypt(); envelope.metadata.encryptedAt = "2026-01-01T00:00:00.000Z";
  assert.throws(() => decryptSecretEnvelope(envelope, keys.privateKey, context));
});
test("wrong target context fails before returning secret", () => assert.throws(() => decryptSecretEnvelope(encrypt(), keys.privateKey, { ...context, accountId: "c".repeat(32) })));
test("private PEM cannot be passed as recipient public material", () => assert.throws(() => encryptSecretEnvelope(secret, keys.privateKey, context)));
test("weak RSA keys fail", () => assert.throws(() => encryptSecretEnvelope(secret, pair(2048).publicKey, context)));
test("empty and oversized secrets fail", () => { for (const text of ["", "x".repeat(4097)]) assert.throws(() => encryptSecretEnvelope(text, keys.publicKey, context)); });
test("invalid database UUID fails", () => assert.throws(() => encryptSecretEnvelope(secret, keys.publicKey, { ...context, databaseId: "guess-from-name" })));
const env = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", APPROVED_BACKUP_SHA: context.sourceSha, GITHUB_SHA: context.sourceSha, CLOUDFLARE_ACCOUNT_ID: context.accountId, EXPECTED_CLOUDFLARE_ACCOUNT_ID: context.accountId, EXPECTED_D1_DATABASE_ID: context.databaseId, RECIPIENT_PUBLIC_KEY_BASE64: Buffer.from(keys.publicKey).toString("base64"), GITHUB_REPOSITORY: context.repository, AES_KEY: secret };
test("manual main exact-SHA environment can create only the encrypted envelope", () => assert.equal(decryptSecretEnvelope(backupFromEnvironment(env), keys.privateKey, context), secret));
for (const [field, value] of [["GITHUB_EVENT_NAME", "push"], ["GITHUB_REF", "refs/heads/other"], ["APPROVED_BACKUP_SHA", "d".repeat(40)], ["CLOUDFLARE_ACCOUNT_ID", "c".repeat(32)]]) test(`mismatched ${field} fails closed`, () => assert.throws(() => backupFromEnvironment({ ...env, [field]: value })));
test("CLI writes only encrypted output, hides secrets, and refuses overwriting", () => {
  const root = path.join(tmpdir(), "opencode"); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, "synthetic-envelope-cli-"));
  const executable = fileURLToPath(new URL("./backup-secret-envelope.mjs", import.meta.url));
  const run = changed => spawnSync(process.execPath, [executable], { cwd: directory, encoding: "utf8", env: { ...process.env, ...env, ...changed } });
  const failed = run({ GITHUB_EVENT_NAME: "push" }); assert.equal(failed.status, 1); assert.deepEqual(readdirSync(directory), []);
  const success = run({}); assert.equal(success.status, 0);
  const output = path.join(directory, "secret-backup", "AES_KEY.envelope.json");
  const before = readFileSync(output, "utf8");
  assert.deepEqual(readdirSync(path.dirname(output)), ["AES_KEY.envelope.json"]);
  assert.equal(decryptSecretEnvelope(JSON.parse(before), keys.privateKey, context), secret);
  const duplicate = run({}); assert.equal(duplicate.status, 1); assert.equal(readFileSync(output, "utf8"), before);
  for (const result of [failed, success, duplicate]) assert.ok(!(result.stdout + result.stderr).includes(secret));
});
