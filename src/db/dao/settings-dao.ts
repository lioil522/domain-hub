/**
 * Settings 表数据访问（settings 表的 CRUD）
 *
 * NOTE: settings 表同时承载「应用配置」（cfg_ 前缀）和「会话」（sess_ 前缀），
 * 这里只负责通用 key-value 读写，上层按业务语义分流。
 */

import { getBeijingNow } from "../time-utils";
import { encryptText, decryptText } from "../crypto";

/**
 * 读取 settings 表中的单个键值
 */
export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  try {
    const res = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value?: unknown }>();
    return res ? String(res.value ?? "") : null;
  } catch (e) {
    return null;
  }
}

/**
 * 写入 settings 表（upsert 语义）
 */
export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  try {
    const now = getBeijingNow();
    await db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).bind(key, value, now).run();
  } catch (e) {
    console.error("setSetting error:", e);
  }
}

/**
 * 删除 settings 表中的单个键
 */
export async function deleteSetting(db: D1Database, key: string): Promise<void> {
  try { await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run(); } catch (e) { console.error("deleteSetting error:", e); }
}

/**
 * 批量读取所有以 cfg_ 为前缀的应用配置项，返回去前缀后的键值对象
 *
 * NOTE: 敏感字段（如 Telegram Token）以 AES 加密形式存储，此处返回解密后的原文，
 * 由上层接口决定是否打码后再下发前端。
 */
export async function getAllAppSettings(db: D1Database, aesKey?: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const { results } = await db.prepare(
      "SELECT key, value FROM settings WHERE key LIKE 'cfg_%'"
    ).all<{ key: string; value: string }>();
    for (const row of results || []) {
      const shortKey = row.key.replace(/^cfg_/, "");
      let val = row.value;
      // 敏感字段解密
      if ((shortKey === "tg_token" || shortKey === "webhook_url") && val) {
        try {
          val = await decryptText(val, aesKey);
        } catch (e) {
          // 解密失败保持原值（可能是历史明文）
        }
      }
      out[shortKey] = val;
    }
  } catch (e) {
    console.error("getAllAppSettings error:", e);
  }
  return out;
}

/**
 * 保存单个应用配置项（自动加 cfg_ 前缀，敏感字段自动 AES 加密）
 */
export async function setAppSetting(db: D1Database, aesKey: string | undefined, shortKey: string, value: string): Promise<void> {
  let stored = value;
  if ((shortKey === "tg_token" || shortKey === "webhook_url") && value) {
    try {
      stored = await encryptText(value, aesKey);
    } catch (e) {
      console.error("setAppSetting encrypt error:", e);
    }
  }
  await setSetting(db, `cfg_${shortKey}`, stored);
}
