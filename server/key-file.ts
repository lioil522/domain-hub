import { readFileSync, statSync, mkdirSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "../src/db/crypto";

export class NodeKeyError extends Error {
  constructor(message: string) { super(message); this.name = "NodeKeyError"; }
}
const code = (error: unknown) => typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
const MAX_KEY_BYTES = 65536;
export interface NodeKey { key: string; source: "env" | "file" | "generated"; keyFile: string; }

export function requireSafeSqliteVersion(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 22 || (major === 22 && minor < 12)) throw new NodeKeyError("自建版需要 Node.js >=22.12.0，以保证只读数据库密钥预检。");
}
export function databaseFileExists(file: string): boolean {
  try {
    if (!statSync(file).isFile()) throw new NodeKeyError("数据库路径不是普通文件，请检查 DB_PATH 和数据卷。");
    return true;
  } catch (error) {
    if (code(error) !== "ENOENT") {
      if (error instanceof NodeKeyError) throw error;
      throw new NodeKeyError("无法检查数据库文件，请检查 DB_PATH 和目录权限。");
    }
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try {
        statSync(file + suffix);
        throw new NodeKeyError("主数据库缺失但仍有日志文件，请恢复完整数据卷，不能创建替代数据库。");
      } catch (sidecarError) {
        if (code(sidecarError) !== "ENOENT") {
          if (sidecarError instanceof NodeKeyError) throw sidecarError;
          throw new NodeKeyError("无法检查数据库日志文件，请检查目录权限。");
        }
      }
    }
    return false;
  }
}
function readKeyFile(file: string): string | null {
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size > MAX_KEY_BYTES) throw new NodeKeyError("aes.key 文件类型或大小不正确，请恢复原密钥。");
    const bytes = readFileSync(file);
    if (bytes.length > MAX_KEY_BYTES) throw new NodeKeyError("aes.key 文件过大，请恢复原密钥。");
    let key: string;
    try { key = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes).trim(); }
    catch { throw new NodeKeyError("aes.key 不是有效 UTF-8 文本，请恢复原密钥。"); }
    if (!key) throw new NodeKeyError("aes.key 为空，拒绝覆盖或生成替代密钥，请恢复原密钥。");
    return key;
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    if (error instanceof NodeKeyError) throw error;
    throw new NodeKeyError("无法读取 aes.key，请检查权限并恢复原密钥。");
  }
}

export function resolveNodeKey(dataDir: string, dbPath: string, configuredKey?: string): NodeKey {
  const exists = databaseFileExists(dbPath);
  const keyFile = path.join(dataDir, "aes.key");
  const explicit = configuredKey?.trim();
  if (explicit) return { key: explicit, source: "env", keyFile };
  const stored = readKeyFile(keyFile);
  if (stored !== null) return { key: stored, source: "file", keyFile };
  if (exists) throw new NodeKeyError("已有数据库但缺少 AES_KEY/aes.key，拒绝生成新密钥。请恢复原密钥或显式配置 AES_KEY。");

  // Publish a complete file with an exclusive hard link: rename could overwrite
  // another initializer's key, and directly writing aes.key exposes partial data.
  mkdirSync(dataDir, { recursive: true });
  const key = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(byte => byte.toString(16).padStart(2, "0")).join("");
  const temporary = path.join(dataDir, `.aes.key.${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${key}\n`, { mode: 0o600, flag: "wx" });
    try { linkSync(temporary, keyFile); }
    catch (error) {
      if (code(error) !== "EEXIST") throw error;
      const winner = readKeyFile(keyFile);
      if (winner === null) throw new NodeKeyError("并发初始化密钥未能读取，请检查数据目录并重试。");
      return { key: winner, source: "file", keyFile };
    }
    return { key, source: "generated", keyFile };
  } catch (error) {
    if (error instanceof NodeKeyError) throw error;
    throw new NodeKeyError("无法安全创建 aes.key；请检查目录权限/文件系统，或显式配置 AES_KEY。");
  } finally {
    try { unlinkSync(temporary); }
    catch (error) { if (code(error) !== "ENOENT") throw new NodeKeyError("无法清理本次初始化的临时密钥文件，请检查目录权限。"); }
  }
}
export function verifyManagedKeyFile(selection: NodeKey) {
  if (selection.source === "env") return;
  const stored = readKeyFile(selection.keyFile);
  if (stored === null || !timingSafeEqual(stored, selection.key)) throw new NodeKeyError("aes.key 已丢失或变化，请恢复启动时的原密钥。");
}
