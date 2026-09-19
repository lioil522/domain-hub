/**
 * 自定义服务商数据访问（custom_accounts / custom_domains / domain_date_overrides 表）
 */

import { getBeijingNow } from "../time-utils";

// ===== 自定义账号 =====

/** 列出某个服务商分组下的所有账号 */
export async function listCustomAccounts(db: D1Database, groupId: number): Promise<
  Array<{ id: number; group_id: number; name: string; updated_at: string }>
> {
  const { results } = await db
    .prepare("SELECT id, group_id, name, updated_at FROM custom_accounts WHERE group_id = ? ORDER BY id ASC")
    .bind(groupId)
    .all<{ id: number; group_id: number; name: string; updated_at: string }>();
  return results || [];
}

/** 跨分组列出所有账号 */
export async function listAllCustomAccounts(db: D1Database): Promise<
  Array<{ id: number; group_id: number; name: string; updated_at: string }>
> {
  const { results } = await db
    .prepare("SELECT id, group_id, name, updated_at FROM custom_accounts ORDER BY group_id ASC, id ASC")
    .all<{ id: number; group_id: number; name: string; updated_at: string }>();
  return results || [];
}

/** 新增账号（同名 upsert 更新） */
export async function upsertCustomAccount(db: D1Database, groupId: number, name: string): Promise<number> {
  const now = getBeijingNow();
  await db.prepare(`
    INSERT INTO custom_accounts (group_id, name, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(group_id, name) DO UPDATE SET updated_at = excluded.updated_at
  `).bind(groupId, name, now).run();
  const row = await db
    .prepare("SELECT id FROM custom_accounts WHERE group_id = ? AND name = ?")
    .bind(groupId, name)
    .first<{ id: number }>();
  return row ? row.id : 0;
}

/** 删除账号（级联删除其下域名） */
export async function deleteCustomAccount(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM custom_accounts WHERE id = ?").bind(id).run();
}

// ===== 自定义域名 =====

/**
 * 新增手动域名（同名 upsert，更新注册/到期时间与备注）
 */
export async function upsertCustomDomain(
  db: D1Database,
  groupId: number,
  accountId: number | null,
  fullDomain: string,
  expiresAt: string,
  remark: string,
  registeredAt?: string | null
): Promise<void> {
  const now = getBeijingNow();

  // NOTE: SQLite 的 UNIQUE 把每个 NULL 视作互不相同
  if (accountId === null) {
    const existing = await db
      .prepare("SELECT id FROM custom_domains WHERE group_id = ? AND account_id IS NULL AND full_domain = ?")
      .bind(groupId, fullDomain)
      .first<{ id: number }>();
    if (existing?.id) {
      await db
        .prepare("UPDATE custom_domains SET registered_at = ?, expires_at = ?, remark = ?, updated_at = ? WHERE id = ?")
        .bind(registeredAt || null, expiresAt, remark || null, now, existing.id)
        .run();
      return;
    }
    await db
      .prepare(`
        INSERT INTO custom_domains (group_id, account_id, full_domain, registered_at, expires_at, remark, updated_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?)
      `)
      .bind(groupId, fullDomain, registeredAt || null, expiresAt, remark || null, now)
      .run();
    return;
  }

  await db.prepare(`
    INSERT INTO custom_domains (group_id, account_id, full_domain, registered_at, expires_at, remark, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_id, account_id, full_domain) DO UPDATE SET
      registered_at = excluded.registered_at,
      expires_at = excluded.expires_at,
      remark = excluded.remark,
      updated_at = excluded.updated_at
  `).bind(groupId, accountId, fullDomain, registeredAt || null, expiresAt, remark || null, now).run();
}

/**
 * 按行 id 更新一条手动域名
 */
export async function updateCustomDomainById(
  db: D1Database,
  id: number,
  groupId: number,
  fullDomain: string,
  expiresAt: string,
  remark: string,
  registeredAt?: string | null
): Promise<boolean> {
  const now = getBeijingNow();
  const row = await db
    .prepare("SELECT id FROM custom_domains WHERE id = ? AND group_id = ?")
    .bind(id, groupId)
    .first<{ id: number }>();
  if (!row?.id) return false;
  await db
    .prepare(`
      UPDATE custom_domains
      SET full_domain = ?, registered_at = ?, expires_at = ?, remark = ?, updated_at = ?
      WHERE id = ?
    `)
    .bind(fullDomain, registeredAt || null, expiresAt, remark || null, now, id)
    .run();
  return true;
}

/** 删除一条手动域名 */
export async function deleteCustomDomain(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM custom_domains WHERE id = ?").bind(id).run();
}

/** 跨分组列出所有自定义域名（含分组/账号信息，供到期提醒用） */
export async function listAllCustomDomains(db: D1Database): Promise<
  Array<{ id: number; group_id: number; account_id: number | null; full_domain: string; registered_at: string | null; expires_at: string; remark: string | null; account_name: string | null; group_alias: string }>
> {
  const { results } = await db
    .prepare(`
      SELECT d.id, d.group_id, d.account_id, d.full_domain, d.registered_at, d.expires_at, d.remark,
             ca.name as account_name, a.alias as group_alias
      FROM custom_domains d
      LEFT JOIN custom_accounts ca ON d.account_id = ca.id
      LEFT JOIN accounts a ON d.group_id = a.id
      ORDER BY d.expires_at ASC
    `)
    .all<{ id: number; group_id: number; account_id: number | null; full_domain: string; registered_at: string | null; expires_at: string; remark: string | null; account_name: string | null; group_alias: string }>();
  return results || [];
}

// ===== 域名日期手动覆盖 =====

/** 读取全部手动覆盖行 */
export async function getDateOverrides(db: D1Database): Promise<
  Array<{ account_id: number; full_domain: string; registered_at: string | null; expires_at: string | null; source: string | null }>
> {
  const { results } = await db
    .prepare(
      "SELECT account_id, full_domain, registered_at, expires_at, source FROM domain_date_overrides ORDER BY full_domain ASC"
    )
    .all<{ account_id: number; full_domain: string; registered_at: string | null; expires_at: string | null; source: string | null }>();
  return results || [];
}

/** 批量读取指定 CF 账号下域名的手动日期覆盖 */
export async function getDateOverridesByAccountIds(
  db: D1Database,
  accountIds: number[]
): Promise<Map<number, Map<string, string>>> {
  const out = new Map<number, Map<string, string>>();
  const valid = accountIds.filter((id) => Number.isSafeInteger(id) && id > 0);
  if (valid.length === 0) return out;

  const CHUNK = 90;
  for (let i = 0; i < valid.length; i += CHUNK) {
    const list = valid.slice(i, i + CHUNK).join(",");
    const { results } = await db
      .prepare(
        `SELECT account_id, full_domain, expires_at FROM domain_date_overrides
         WHERE account_id IN (${list}) AND expires_at IS NOT NULL AND expires_at != ''`
      )
      .all<{ account_id: number; full_domain: string; expires_at: string }>();
    for (const row of results || []) {
      const host = String(row.full_domain || "").trim().toLowerCase();
      if (!host) continue;
      let bucket = out.get(row.account_id);
      if (!bucket) {
        bucket = new Map<string, string>();
        out.set(row.account_id, bucket);
      }
      bucket.set(host, String(row.expires_at));
    }
  }
  return out;
}

/** 写入/更新单条手动覆盖 */
export async function upsertDateOverride(
  db: D1Database,
  accountId: number,
  fullDomain: string,
  fields: { registered_at?: string | null; expires_at?: string | null; source?: string | null }
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO domain_date_overrides (account_id, full_domain, registered_at, expires_at, source, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(account_id, full_domain) DO UPDATE SET
        registered_at = excluded.registered_at,
        expires_at = excluded.expires_at,
        source = excluded.source,
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(
      accountId,
      fullDomain,
      fields.registered_at || null,
      fields.expires_at || null,
      fields.source || null
    )
    .run();
}

/** 删除单条手动覆盖 */
export async function deleteDateOverride(db: D1Database, accountId: number, fullDomain: string): Promise<void> {
  await db
    .prepare("DELETE FROM domain_date_overrides WHERE account_id = ? AND full_domain = ?")
    .bind(accountId, fullDomain)
    .run();
}
