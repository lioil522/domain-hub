import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, createPublicKey, constants, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FORMAT = "domain-hub-secret-backup-v1";
const ALGORITHM = "RSA-OAEP-SHA256+AES-256-GCM";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function validateContext(context) {
  assert.ok(object(context), "Backup context required");
  assert.ok(/^[a-f0-9]{32}$/i.test(context.accountId ?? ""), "Explicit account ID required");
  assert.ok(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(context.databaseId ?? ""), "Explicit database UUID required");
  assert.ok(/^[a-z0-9_-]{1,63}$/.test(context.worker ?? ""), "Explicit Worker required");
  assert.ok(/^[a-f0-9]{40}$/.test(context.sourceSha ?? ""), "Explicit source SHA required");
  assert.ok(typeof context.repository === "string" && /^[\w.-]+\/[\w.-]+$/.test(context.repository), "Explicit repository required");
  assert.ok(context.secretName === "AES_KEY", "Only AES_KEY backup is supported");
}
function base64(value, length) {
  assert.ok(typeof value === "string" && value.length <= 16384, "Invalid envelope field");
  const bytes = Buffer.from(value, "base64");
  assert.ok(bytes.toString("base64") === value && (length === undefined || bytes.length === length), "Invalid envelope encoding");
  return bytes;
}
export function encryptSecretEnvelope(secret, publicKeyPem, context) {
  validateContext(context);
  assert.ok(typeof secret === "string" && Buffer.byteLength(secret, "utf8") > 0 && Buffer.byteLength(secret, "utf8") <= 4096, "Secret must be nonempty and bounded");
  assert.ok(typeof publicKeyPem === "string" && publicKeyPem.length <= 12288 && /^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+\r?\n-----END PUBLIC KEY-----\s*$/.test(publicKeyPem), "A public SPKI PEM key is required");
  const recipient = createPublicKey(publicKeyPem);
  assert.ok(recipient.asymmetricKeyType === "rsa" && recipient.asymmetricKeyDetails.modulusLength >= 3072 && recipient.asymmetricKeyDetails.modulusLength <= 8192, "RSA public key must be 3072 to 8192 bits");
  const metadata = { ...context, encryptedAt: new Date().toISOString(), recipientKeySha256: createHash("sha256").update(recipient.export({ type: "spki", format: "der" })).digest("hex") };
  const key = randomBytes(32);
  const plaintext = Buffer.from(secret, "utf8");
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(metadata), "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrappedKey = publicEncrypt({ key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
    return { format: FORMAT, algorithm: ALGORITHM, metadata, wrappedKey: wrappedKey.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  } finally { key.fill(0); plaintext.fill(0); }
}
export function decryptSecretEnvelope(envelope, privateKeyPem, expectedContext) {
  validateContext(expectedContext);
  assert.ok(object(envelope) && envelope.format === FORMAT && envelope.algorithm === ALGORITHM, "Unsupported secret envelope");
  validateContext(envelope.metadata);
  for (const name of ["accountId", "databaseId", "worker", "sourceSha", "repository", "secretName"]) {
    assert.ok(envelope.metadata[name] === expectedContext[name], "Backup context does not match approved target");
  }
  const publicKey = createPublicKey(privateKeyPem);
  const fingerprint = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
  assert.ok(fingerprint === envelope.metadata.recipientKeySha256, "Recipient key does not match");
  const key = privateDecrypt({ key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, base64(envelope.wrappedKey));
  try {
    assert.ok(key.length === 32, "Invalid envelope key size");
    const decipher = createDecipheriv("aes-256-gcm", key, base64(envelope.iv, 12));
    decipher.setAAD(Buffer.from(JSON.stringify(envelope.metadata), "utf8"));
    decipher.setAuthTag(base64(envelope.tag, 16));
    const plaintext = Buffer.concat([decipher.update(base64(envelope.ciphertext)), decipher.final()]);
    try { assert.ok(plaintext.length > 0 && plaintext.length <= 4096, "Invalid decrypted secret size"); return plaintext.toString("utf8"); }
    finally { plaintext.fill(0); }
  } finally { key.fill(0); }
}
export function backupFromEnvironment(env) {
  assert.ok(env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_REF === "refs/heads/main", "Manual main dispatch required");
  assert.ok(env.APPROVED_BACKUP_SHA === env.GITHUB_SHA, "Backup SHA approval mismatch");
  assert.ok(env.CLOUDFLARE_ACCOUNT_ID === env.EXPECTED_CLOUDFLARE_ACCOUNT_ID, "GitHub account does not match the inspected target");
  assert.ok(typeof env.RECIPIENT_PUBLIC_KEY_BASE64 === "string" && env.RECIPIENT_PUBLIC_KEY_BASE64.length <= 16384, "Recipient public key required");
  const recipientPem = base64(env.RECIPIENT_PUBLIC_KEY_BASE64).toString("utf8");
  return encryptSecretEnvelope(env.AES_KEY, recipientPem, { accountId: env.CLOUDFLARE_ACCOUNT_ID, databaseId: env.EXPECTED_D1_DATABASE_ID, worker: "domain-hub", sourceSha: env.GITHUB_SHA, repository: env.GITHUB_REPOSITORY, secretName: "AES_KEY" });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const envelope = backupFromEnvironment(process.env);
    // Only an encrypted artifact may be written/uploaded. Never print the secret.
    mkdirSync("secret-backup", { recursive: true });
    writeFileSync("secret-backup/AES_KEY.envelope.json", JSON.stringify(envelope, null, 2), { flag: "wx", mode: 0o600 });
    console.log("Encrypted AES recovery artifact created; database pairing still requires local verification.");
  } catch { console.error("Encrypted AES backup failed; no secret values logged and no deployment performed."); process.exitCode = 1; }
}
