/**
 * 鉴权数据访问（登录凭据、2FA、会话管理、登录失败限流）
 *
 * NOTE: 鉴权相关配置以 auth_ 前缀独立存储于 settings 表。
 */

import { getSetting, setSetting } from "./settings-dao";
import { encryptText, decryptText, hashPassword, generateSalt, timingSafeEqual, sha256Hex } from "../crypto";
import { toBeijingString } from "../time-utils";
import type { AuthConfig } from "../types";

/** 会话有效期：7 天 */
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

/** Session Token 前缀（鉴权中间件据此区分会话 token 与应急令牌） */
export const SESSION_PREFIX = "dh_sess_";

// ===== 鉴权配置 =====

/**
 * 读取管理员鉴权配置
 *
 * NOTE: 改为一条 IN 查询后 5 次 D1 往返收敛成 1 次。
 */
export async function getAuthConfig(db: D1Database, aesKey?: string): Promise<AuthConfig> {
  const AUTH_KEYS = [
    "auth_username",
    "auth_pass_hash",
    "auth_pass_salt",
    "auth_2fa_enabled",
    "auth_2fa_secret",
  ];

  const values = new Map<string, string>();
  try {
    const { results } = await db
      .prepare(
        `SELECT key, value FROM settings WHERE key IN (${AUTH_KEYS.map(() => "?").join(", ")})`
      )
      .bind(...AUTH_KEYS)
      .all<{ key: string; value: string }>();
    for (const row of results || []) {
      values.set(row.key, String(row.value));
    }
  } catch (e) {
    console.error("getAuthConfig read error:", e);
  }

  const passHash = values.get("auth_pass_hash") || "";
  const encryptedSecret = values.get("auth_2fa_secret") || "";

  let twoFaSecret = "";
  if (encryptedSecret) {
    try {
      twoFaSecret = await decryptText(encryptedSecret, aesKey);
    } catch (e) {
      console.error("Failed to decrypt 2FA secret:", e);
    }
  }

  return {
    username: values.get("auth_username") || "admin",
    passHash,
    passSalt: values.get("auth_pass_salt") || "",
    twoFaEnabled: values.get("auth_2fa_enabled") === "1",
    twoFaSecret,
    initialized: !!passHash,
  };
}

/**
 * 设置/修改管理员密码（自动生成新盐值并哈希存储）
 */
export async function setPassword(db: D1Database, username: string, password: string): Promise<void> {
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);
  await setSetting(db, "auth_username", username);
  await setSetting(db, "auth_pass_hash", hash);
  await setSetting(db, "auth_pass_salt", salt);
}

/**
 * 校验管理员密码
 */
export async function verifyPassword(db: D1Database, aesKey: string | undefined, password: string): Promise<boolean> {
  const cfg = await getAuthConfig(db, aesKey);
  if (!cfg.passHash || !cfg.passSalt) return false;
  const hash = await hashPassword(password, cfg.passSalt);
  return timingSafeEqual(hash, cfg.passHash);
}

/**
 * 保存（加密）待启用的 2FA TOTP 密钥
 */
export async function setTwoFaSecret(db: D1Database, aesKey: string | undefined, secretBase32: string): Promise<void> {
  const encrypted = await encryptText(secretBase32, aesKey);
  await setSetting(db, "auth_2fa_secret", encrypted);
}

/**
 * 开启/关闭 2FA
 */
export async function setTwoFaEnabled(db: D1Database, enabled: boolean): Promise<void> {
  await setSetting(db, "auth_2fa_enabled", enabled ? "1" : "0");
  if (!enabled) {
    // 关闭时清除密钥，避免残留
    await setSetting(db, "auth_2fa_secret", "");
  }
}

// ===== 会话管理 =====

/**
 * 签发一个新会话，返回 Session Token
 */
export async function createSession(db: D1Database, ttlSeconds = SESSION_TTL_SECONDS): Promise<string> {
  const token = `${SESSION_PREFIX}${crypto.randomUUID()}`;
  const digest = await sha256Hex(token);
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  await setSetting(db, `sess_${digest}`, String(expiresAt));
  return token;
}

/**
 * 校验会话是否有效（存在且未过期）
 */
export async function validateSession(db: D1Database, token: string): Promise<boolean> {
  if (!token.startsWith(SESSION_PREFIX)) return false;
  const digest = await sha256Hex(token);
  const stored = await getSetting(db, `sess_${digest}`);
  if (!stored) return false;
  const expiresAt = Number(stored);
  return Number.isFinite(expiresAt) && expiresAt > Math.floor(Date.now() / 1000);
}

/**
 * 注销会话（登出时删除对应的哈希行，使已签发的 token 立即失效）
 */
export async function revokeSession(db: D1Database, token: string): Promise<void> {
  if (!token || !token.startsWith(SESSION_PREFIX)) return;
  try {
    const digest = await sha256Hex(token);
    await db.prepare("DELETE FROM settings WHERE key = ?").bind(`sess_${digest}`).run();
  } catch (e) {
    console.error("revokeSession error:", e);
  }
}

/**
 * 清理已过期会话 — 供每日 cron 调用，返回清理条数
 */
export async function purgeExpiredSessions(db: D1Database, ttlSeconds = SESSION_TTL_SECONDS): Promise<number> {
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    const expired = await db.prepare(
      "DELETE FROM settings WHERE key LIKE 'sess_%' AND value != 'valid' AND CAST(value AS INTEGER) <= ?"
    ).bind(nowSec).run();

    // 历史遗留格式：value = 'valid' 没有到期时间
    const legacyCutoff = toBeijingString(new Date((nowSec - ttlSeconds) * 1000));
    const legacy = await db.prepare(
      "DELETE FROM settings WHERE key LIKE 'sess_%' AND value = 'valid' AND updated_at <= ?"
    ).bind(legacyCutoff).run();

    return (expired.meta?.changes || 0) + (legacy.meta?.changes || 0);
  } catch (e) {
    console.error("purgeExpiredSessions error:", e);
    return 0;
  }
}

// ===== 登录失败限流 =====

/**
 * 读取指定 scope 当前的失败次数（已过期的计数返回 0）
 */
export async function countLoginFailures(db: D1Database, scope: string): Promise<number> {
  try {
    const row = await db.prepare(
      "SELECT value FROM cache WHERE key = ? AND expires_at > ?"
    ).bind(`login_fail:${scope}`, Math.floor(Date.now() / 1000)).first<{ value: string }>();
    if (!row) return 0;
    const n = parseInt(String(row.value), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (e) {
    console.error("countLoginFailures error:", e);
    return 0;
  }
}

/**
 * 记录一次登录失败
 */
export async function recordLoginFailure(db: D1Database, scope: string, windowSeconds = 15 * 60): Promise<number> {
  try {
    const expiresAt = Math.floor(Date.now() / 1000) + windowSeconds;
    await db.prepare(
      `INSERT INTO cache (key, value, expires_at) VALUES (?, '1', ?)
       ON CONFLICT(key) DO UPDATE SET
         value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
         expires_at = excluded.expires_at`
    ).bind(`login_fail:${scope}`, expiresAt).run();
  } catch (e) {
    console.error("recordLoginFailure error:", e);
  }
  return countLoginFailures(db, scope);
}

/**
 * 登录成功后清空该 scope 的失败计数
 */
export async function clearLoginFailures(db: D1Database, scope: string): Promise<void> {
  try {
    await db.prepare("DELETE FROM cache WHERE key = ?").bind(`login_fail:${scope}`).run();
  } catch (e) {
    console.error("clearLoginFailures error:", e);
  }
}
