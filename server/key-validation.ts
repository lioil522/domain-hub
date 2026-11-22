import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase } from "./d1-sqlite";
import { encryptText, decryptText } from "../src/db/crypto";
import { NodeKeyError } from "./key-file";

export const NODE_KEY_CHECK = "node_aes_key_check";
const PROBE = "domain-hub/node-aes-key-check/v1";
const BATCH = 24;
const AES_CIPHER = /^[a-f0-9]{24}:(?:[a-f0-9]{2}){16,}$/i;
const encryptedPrefix = /^[a-f0-9]{24}:/i;

async function checkCipher(value: unknown, key: string, label: string, legacy: boolean, marker = false) {
  if (typeof value !== "string") throw new NodeKeyError(`${label} 存储格式不正确，请恢复数据备份。`);
  if (!value && !marker) return;
  if (!(legacy && value.startsWith("plain:")) && !AES_CIPHER.test(value)) {
    throw new NodeKeyError(`${label} 密文格式不正确，请恢复原数据；不会跳过坏记录或替换密钥。`);
  }
  try {
    const text = await decryptText(value, key);
    if (marker && text !== PROBE) throw new Error("Invalid key probe");
  } catch {
    throw new NodeKeyError(`${label} 无法用当前 AES_KEY 解密，请恢复原密钥或完整数据备份。`);
  }
}
function hasColumns(sqlite: SqliteDatabase, table: string, columns: string[]) {
  if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) return false;
  const fields = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some(column => !fields.some(field => field.name === column))) throw new NodeKeyError(`${table} 结构不完整，无法安全预检密钥。`);
  return true;
}
async function scanColumn(sqlite: SqliteDatabase, table: string, column: string, key: string, legacy: boolean) {
  if (!hasColumns(sqlite, table, [column])) return;
  let cursor: string | null = null;
  while (true) {
    const sql = `SELECT CAST(rowid AS TEXT) cursor,${column} cipher FROM ${table}
      ${cursor === null ? "" : "WHERE rowid>CAST(? AS INTEGER)"} ORDER BY rowid LIMIT ?`;
    const rows = sqlite.prepare(sql).all(...(cursor === null ? [BATCH] : [cursor, BATCH])) as Array<{ cursor: string; cipher: unknown }>;
    for (const row of rows) await checkCipher(row.cipher, key, `${table}.${column}`, legacy);
    if (rows.length < BATCH) return;
    const next = rows[rows.length - 1].cursor;
    if (next === cursor) throw new NodeKeyError("密钥预检游标未前进，拒绝启动。");
    cursor = next;
  }
}

/** Read one SQLite snapshot and bound ciphertext memory; never logs/decrypts into output. */
export async function validateStoredNodeKeys(sqlite: SqliteDatabase, key: string) {
  sqlite.exec("BEGIN");
  try {
    if (hasColumns(sqlite, "settings", ["key", "value"])) {
      const keys = [NODE_KEY_CHECK, "auth_2fa_secret", "auth_2fa_pending", "auth_2fa_enabled", "cfg_tg_token", "cfg_webhook_url"];
      const rows = sqlite.prepare(`SELECT key,value FROM settings WHERE key IN (${keys.map(() => "?").join(",")})`)
        .all(...keys) as Array<{ key: string; value: unknown }>;
      const values = new Map(rows.map(row => [row.key, row.value]));
      if (values.has(NODE_KEY_CHECK)) await checkCipher(values.get(NODE_KEY_CHECK), key, NODE_KEY_CHECK, false, true);
      const active = values.get("auth_2fa_secret");
      if (values.get("auth_2fa_enabled") === "1" && !active) throw new NodeKeyError("两步验证已开启但密钥缺失，请恢复原数据。");
      if (active) await checkCipher(active, key, "auth_2fa_secret", true);
      const pending = values.get("auth_2fa_pending");
      if (pending) {
        let encrypted: unknown;
        try { encrypted = (JSON.parse(String(pending)) as { encrypted: unknown }).encrypted; }
        catch { throw new NodeKeyError("auth_2fa_pending 存储格式不正确，请恢复原数据。"); }
        await checkCipher(encrypted, key, "auth_2fa_pending.encrypted", true);
      }
      for (const name of ["cfg_tg_token", "cfg_webhook_url"]) {
        const value = values.get(name);
        if (value !== undefined && typeof value !== "string") throw new NodeKeyError(`${name} 存储格式不正确，请恢复原配置。`);
        if (typeof value === "string" && (value.startsWith("plain:") || encryptedPrefix.test(value))) {
          await checkCipher(value, key, name, true);
        }
      }
    }
    await scanColumn(sqlite, "accounts", "api_secret", key, true);
    await scanColumn(sqlite, "notification_outbox", "payload_cipher", key, false);
    await scanColumn(sqlite, "restore_chunks", "raw_cipher", key, false);
    sqlite.exec("COMMIT");
  } catch (error) {
    try { sqlite.exec("ROLLBACK"); } catch { /* original error is authoritative */ }
    if (error instanceof NodeKeyError) throw error;
    throw new NodeKeyError("已有数据库只读密钥预检失败，请检查数据库、权限和原密钥。");
  }
}
export async function preflightNodeDatabase(file: string, key: string) {
  let sqlite: DatabaseSync;
  try { sqlite = new DatabaseSync(file, { readOnly: true }); }
  catch { throw new NodeKeyError("无法只读打开已有数据库，请检查 DB_PATH、权限和完整数据卷。"); }
  try {
    // Connection-local only: this does not write the database. A concurrent
    // initializer can temporarily hold a schema/journal lock on a new file.
    sqlite.exec("PRAGMA busy_timeout = 5000");
    await validateStoredNodeKeys(sqlite, key);
  }
  finally { sqlite.close(); }
}
export async function assertNodeKeyMarker(db: D1Database, key: string) {
  const row = await db.prepare("SELECT value FROM settings WHERE key=?").bind(NODE_KEY_CHECK).first<{ value: unknown }>();
  if (!row) throw new NodeKeyError("数据库缺少启动密钥校验记录，请恢复原配置并重启。");
  await checkCipher(row.value, key, NODE_KEY_CHECK, false, true);
}
export async function ensureNodeKeyMarker(db: D1Database, key: string) {
  if (await db.prepare("SELECT value FROM settings WHERE key=?").bind(NODE_KEY_CHECK).first()) {
    await assertNodeKeyMarker(db, key); return;
  }
  const cipher = await encryptText(PROBE, key);
  await db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING").bind(NODE_KEY_CHECK, cipher).run();
  // Another startup can win the claim; do not accept a key different from its winner.
  await assertNodeKeyMarker(db, key);
}
