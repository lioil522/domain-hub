/**
 * 日志表数据访问（logs 表的 CRUD + 自动清理）
 */

import { getBeijingNow } from "../time-utils";
import type { DBLog } from "../types";

/**
 * 写入日志
 */
export async function writeLog(
  db: D1Database,
  type: "info" | "success" | "warning" | "error",
  category: "sync" | "renew" | "system" | "auth" | "api" | "operation",
  message: string,
  details?: unknown
): Promise<void> {
  try {
    const detailsStr = details ? (typeof details === "string" ? details : JSON.stringify(details)) : null;
    const beijingNow = getBeijingNow();
    await db.prepare(
      "INSERT INTO logs (type, category, message, details, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(type, category, message, detailsStr, beijingNow).run();
  } catch (e) {
    console.error("Failed to write database log:", e);
  }
}

/**
 * 获取日志列表 (按时间倒序，限制100条)
 *
 * NOTE: 可选按 categories 过滤（传入分类数组，如 ["api","sync","renew"]）。
 */
export async function getLogs(db: D1Database, limit = 100, categories?: string[]): Promise<DBLog[]> {
  if (categories && categories.length > 0) {
    const placeholders = categories.map(() => "?").join(",");
    const { results } = await db.prepare(
      `SELECT * FROM logs WHERE category IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`
    ).bind(...categories, limit).all<DBLog>();
    return results || [];
  }
  const { results } = await db.prepare(
    "SELECT * FROM logs ORDER BY created_at DESC LIMIT ?"
  ).bind(limit).all<DBLog>();
  return results || [];
}

/**
 * 清理所有日志
 */
export async function clearLogs(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM logs").run();
  await writeLog(db, "info", "operation", "已手动清空运行日志");
}

/**
 * 自动清理过期日志（保留最近 30 天）
 *
 * NOTE: 在每次 Cron 任务执行后调用此方法，防止日志无限增长
 * 占满 D1 免费版的 500MB 存储限制
 */
export async function pruneExpiredLogs(db: D1Database): Promise<void> {
  try {
    const result = await db.prepare(
      "DELETE FROM logs WHERE created_at < datetime('now', '-30 days')"
    ).run();
    const deletedCount = result.meta?.changes || 0;
    if (deletedCount > 0) {
      await writeLog(db, "info", "system", `自动清理了 ${deletedCount} 条超过 30 天的过期日志`);
    }
  } catch (e) {
    console.error("Failed to prune expired logs:", e);
  }
}
