/**
 * Cache 表数据访问（cache 表的读写 + 查重池 + DNS 记录缓存 + RDAP + 配额缓存）
 */

import type { QuotaEntry } from "../types";
import { QUOTA_CACHE_KEY, RDAP_CACHE_PREFIX } from "../types";

// ===== 通用 cache CRUD =====

/**
 * 读取缓存值（仅在面板内写操作后失效，长期有效）
 */
export async function getCache(db: D1Database, key: string): Promise<string | null> {
  try {
    const row = await db.prepare(
      "SELECT value FROM cache WHERE key = ? AND expires_at > ?"
    ).bind(key, Math.floor(Date.now() / 1000)).first<{ value: string }>();
    return row ? row.value : null;
  } catch (e) {
    console.error("getCache error:", e);
    return null;
  }
}

/**
 * 写入缓存（默认 1 年后过期，作为极端兜底；正常由写操作主动失效/重填）
 */
export async function setCache(db: D1Database, key: string, value: string, ttlSeconds?: number): Promise<void> {
  try {
    const ttl = ttlSeconds && ttlSeconds > 0 ? ttlSeconds : 366 * 24 * 3600;
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    await db.prepare(
      "INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at"
    ).bind(key, value, expiresAt).run();
  } catch (e) {
    console.error("setCache error:", e);
  }
}

/**
 * 删除指定缓存（写操作后调用，强制下一次读取回源刷新）
 */
export async function deleteCache(db: D1Database, key: string): Promise<void> {
  try {
    await db.prepare("DELETE FROM cache WHERE key = ?").bind(key).run();
  } catch (e) {
    console.error("deleteCache error:", e);
  }
}

/**
 * 清理已过期的缓存行（含查重池），避免 cache 表只进不出无限膨胀
 */
export async function purgeExpiredCache(db: D1Database): Promise<number> {
  try {
    const res = await db.prepare(
      "DELETE FROM cache WHERE expires_at <= ?"
    ).bind(Math.floor(Date.now() / 1000)).run();
    return res.meta?.changes ?? 0;
  } catch (e) {
    console.error("purgeExpiredCache error:", e);
    return 0;
  }
}

// ===== 查重池 =====

/**
 * 批量查询查重池：返回其中「已确认已注册且尚未过期」的域名集合。
 */
export async function getWhoisPool(db: D1Database, domains: string[]): Promise<string[]> {
  if (domains.length === 0) return [];
  const safe = domains.filter(d => /^[a-z0-9][a-z0-9.-]{0,252}$/.test(d));
  if (safe.length === 0) return [];

  const now = Math.floor(Date.now() / 1000);
  const hits: string[] = [];
  const STMT_CHUNK = 400;

  for (let i = 0; i < safe.length; i += STMT_CHUNK) {
    const list = safe
      .slice(i, i + STMT_CHUNK)
      .map(d => `'whois_pool:${d}'`)
      .join(",");
    const rows = await db.prepare(
      `SELECT key FROM cache WHERE key IN (${list}) AND expires_at > ?`
    ).bind(now).all<{ key: string }>();
    for (const r of rows.results || []) {
      hits.push(r.key.replace(/^whois_pool:/, ""));
    }
  }

  return hits;
}

/**
 * 将一个已确认「已注册」的域名写入查重池（默认 7 天后自动失效需重新验证）
 */
export async function addToWhoisPool(db: D1Database, domain: string, ttlSeconds = 7 * 24 * 3600): Promise<void> {
  await setCache(
    db,
    `whois_pool:${domain}`,
    JSON.stringify({ registered: true, ts: Math.floor(Date.now() / 1000) }),
    ttlSeconds
  );
}

// ===== DNS 记录缓存批量读取 =====

/**
 * 批量读取一批域名的解析记录缓存（单条 SQL，避免逐域名 getCache 往返）
 */
export async function getDnsRecordsCacheBatch(db: D1Database, ids: number[]): Promise<Map<number, unknown[]>> {
  const result = new Map<number, unknown[]>();
  const valid = ids.filter((id) => Number.isSafeInteger(id) && id >= 0);
  if (valid.length === 0) return result;

  const now = Math.floor(Date.now() / 1000);
  const STMT_CHUNK = 400;

  for (let i = 0; i < valid.length; i += STMT_CHUNK) {
    const list = valid.slice(i, i + STMT_CHUNK).map((id) => `'api_cache:dns:${id}'`).join(",");
    const rows = await db
      .prepare(`SELECT key, value FROM cache WHERE key IN (${list}) AND expires_at > ?`)
      .bind(now)
      .all<{ key: string; value: string }>();
    for (const row of rows.results || []) {
      const id = Number(String(row.key).replace(/^api_cache:dns:/, ""));
      if (!Number.isFinite(id)) continue;
      try {
        const parsed = JSON.parse(String(row.value));
        if (Array.isArray(parsed)) result.set(id, parsed);
      } catch {
        // 缓存内容损坏时跳过，调用方会为它回源重拉并覆盖
      }
    }
  }
  return result;
}

// ===== RDAP 到期时间缓存 =====

/**
 * 批量读取 RDAP 到期时间缓存（key = 小写域名，value = expires_at）
 */
export async function getRdapExpiryCacheBatch(db: D1Database, domains: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const valid = Array.from(
    new Set(domains.map((d) => String(d || "").trim().toLowerCase()).filter(Boolean))
  );
  if (valid.length === 0) return out;

  const STMT_CHUNK = 400;
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < valid.length; i += STMT_CHUNK) {
    const list = valid
      .slice(i, i + STMT_CHUNK)
      .map((d) => `'${RDAP_CACHE_PREFIX}${d.replace(/'/g, "''")}'`)
      .join(",");
    const { results } = await db
      .prepare(
        `SELECT key, value FROM cache WHERE key IN (${list}) AND expires_at > ?`
      )
      .bind(now)
      .all<{ key: string; value: string }>();
    for (const row of results || []) {
      const host = String(row.key).slice(RDAP_CACHE_PREFIX.length);
      if (!host) continue;
      try {
        const parsed = JSON.parse(String(row.value)) as {
          found?: boolean;
          expires_at?: string;
        };
        if (parsed && parsed.found && parsed.expires_at) {
          out.set(host, String(parsed.expires_at));
        }
      } catch {
        // 缓存脏了按未命中处理
      }
    }
  }
  return out;
}

// ===== 配额缓存 =====

/**
 * 读取配额缓存数组；缓存不存在或内容损坏时返回 null
 */
export async function readQuotaCache(db: D1Database): Promise<QuotaEntry[] | null> {
  const cached = await getCache(db, QUOTA_CACHE_KEY);
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached);
    return Array.isArray(parsed) ? (parsed as QuotaEntry[]) : null;
  } catch (e) {
    return null;
  }
}

/**
 * 写回配额缓存，并保持与 getAccounts() 相同的 id ASC 顺序
 */
export async function writeQuotaCache(db: D1Database, entries: QuotaEntry[]): Promise<void> {
  const sorted = [...entries].sort((a, b) => Number(a.account_id) - Number(b.account_id));
  await setCache(db, QUOTA_CACHE_KEY, JSON.stringify(sorted));
}

/**
 * 解绑账号：摘掉对应条目
 */
export async function removeAccountFromQuotaCache(db: D1Database, accountId: number): Promise<void> {
  const cached = await readQuotaCache(db);
  if (cached === null) return;
  await writeQuotaCache(db, cached.filter((q) => Number(q.account_id) !== accountId));
}

/**
 * 仅改别名：就地改写缓存里的别名
 */
export async function renameAccountInQuotaCache(db: D1Database, accountId: number, alias: string): Promise<void> {
  const cached = await readQuotaCache(db);
  if (cached === null) return;
  if (!cached.some((q) => Number(q.account_id) === accountId)) return;
  await writeQuotaCache(
    db,
    cached.map((q) => (Number(q.account_id) === accountId ? { ...q, alias } : q))
  );
}
