/**
 * 域名缓存表数据访问（domains_cache 表的 CRUD + 同步）
 */

import { getBeijingNow } from "../time-utils";
import type { DBDomain, UpstreamSubdomain, AccountProvider } from "../types";
import { THREE_STATE_STATUSES, nonDnsheProviderSqlList } from "../types";

/**
 * 跨账号列出域名（包含所属账户别名），支持搜索与状态过滤
 */
export async function getDomains(
  db: D1Database,
  search = "",
  status = "",
  accountId?: number,
  provider?: AccountProvider
): Promise<DBDomain[]> {
  let query = `
    SELECT d.*, a.alias as account_alias, a.provider as account_provider
    FROM domains_cache d
    LEFT JOIN accounts a ON d.account_id = a.id
    WHERE 1=1
  `;
  const binds: (string | number)[] = [];

  if (search) {
    query += " AND (d.subdomain LIKE ? OR d.rootdomain LIKE ? OR d.full_domain LIKE ?)";
    const searchPattern = `%${search}%`;
    binds.push(searchPattern, searchPattern, searchPattern);
  }

  if (status) {
    query += " AND d.status = ?";
    binds.push(status);
  }

  if (accountId) {
    query += " AND d.account_id = ?";
    binds.push(accountId);
  }

  if (provider === "cloudflare") {
    query += " AND a.provider = 'cloudflare'";
  } else if (provider === "digitalplat") {
    query += " AND a.provider = 'digitalplat'";
  } else if (
    provider === "dnspod" ||
    provider === "alidns" ||
    provider === "huaweicloud" ||
    provider === "vercel"
  ) {
    query += " AND a.provider = ?";
    binds.push(provider);
  } else if (provider === "dnshe") {
    query += ` AND IFNULL(a.provider, 'dnshe') NOT IN (${nonDnsheProviderSqlList()})`;
  } else {
    query += ` AND IFNULL(a.provider, 'dnshe') NOT IN (${nonDnsheProviderSqlList()})`;
  }

  query += " ORDER BY d.expires_at ASC";

  const { results } = await db.prepare(query).bind(...binds).all<DBDomain & { account_provider?: string }>();
  return results || [];
}

/**
 * 按主键查询单条域名记录
 */
export async function getDomainById(db: D1Database, id: number): Promise<DBDomain | null> {
  const result = await db.prepare(`
    SELECT d.*, a.alias as account_alias
    FROM domains_cache d
    LEFT JOIN accounts a ON d.account_id = a.id
    WHERE d.id = ?
  `).bind(id).first<DBDomain>();
  return result || null;
}

/**
 * 构造单条域名的 UPSERT 语句
 *
 * NOTE: 只有当调用方带上 dns_state_known 时，才允许覆盖已有行的 status / has_dns / dns_provider。
 */
export function buildDomainUpsert(db: D1Database, accountId: number, sub: UpstreamSubdomain): D1PreparedStatement {
  let hasDnsVal = 1;
  if (sub.dns_state_known) {
    hasDnsVal = sub.has_dns ? 1 : 0;
  } else if (sub.disable_ns_management) {
    hasDnsVal = 0;
  } else if (sub.ns1 || sub.ns2) {
    const ns1 = (sub.ns1 || "").toLowerCase();
    const ns2 = (sub.ns2 || "").toLowerCase();
    const isDefault = ns1.includes("dnshe.com") || ns2.includes("dnshe.com");
    hasDnsVal = isDefault ? 1 : 0;
  } else if (sub.has_dns !== undefined) {
    hasDnsVal = sub.has_dns ? 1 : 0;
  }
  const dnsProvider = sub.dns_provider ?? null;

  const providerAccountId =
    sub.provider_account_id === undefined || sub.provider_account_id === null
      ? null
      : String(sub.provider_account_id);

  const dnsStateAssignments = sub.dns_state_known
    ? `status = excluded.status,
          has_dns = excluded.has_dns,
          dns_provider = COALESCE(excluded.dns_provider, domains_cache.dns_provider),`
    : "";

  const statusVal = sub.dns_state_known || THREE_STATE_STATUSES.has(sub.status)
    ? sub.status
    : "未解析";

  return db.prepare(`
    INSERT INTO domains_cache (id, account_id, subdomain, rootdomain, full_domain, status, created_at, expires_at, has_dns, dns_provider, provider_account_id, remote_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      account_id = excluded.account_id,
      provider_account_id = COALESCE(excluded.provider_account_id, domains_cache.provider_account_id),
      remote_id = COALESCE(excluded.remote_id, domains_cache.remote_id),
      ${dnsStateAssignments}
      created_at = COALESCE(NULLIF(excluded.created_at, ''), domains_cache.created_at),
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).bind(
    sub.id,
    accountId,
    sub.subdomain,
    sub.rootdomain,
    sub.full_domain,
    statusVal,
    sub.created_at || "",
    sub.expires_at || "",
    hasDnsVal,
    dnsProvider,
    providerAccountId,
    sub.remote_id || null,
    getBeijingNow()
  );
}

/**
 * 写入/更新单条域名缓存（不做账号级别的清理扫描）
 */
export async function upsertDomain(db: D1Database, accountId: number, sub: UpstreamSubdomain): Promise<void> {
  await buildDomainUpsert(db, accountId, sub).run();
}

/**
 * 同步单个账号名下的域名到缓存表
 */
export async function syncAccountDomains(db: D1Database, accountId: number, subdomains: UpstreamSubdomain[]): Promise<void> {
  const statements: D1PreparedStatement[] = [];

  const cachedDomains = await db.prepare(
    "SELECT id FROM domains_cache WHERE account_id = ?"
  ).bind(accountId).all();
  const cachedIds = new Set((cachedDomains.results || []).map((d: Record<string, unknown>) => d.id as number));
  const activeIds = new Set(subdomains.map(s => s.id));

  for (const sub of subdomains) {
    statements.push(buildDomainUpsert(db, accountId, sub));
  }

  const deleteIds = [...cachedIds].filter(id => !activeIds.has(id));
  for (const deleteId of deleteIds) {
    statements.push(
      db.prepare("DELETE FROM domains_cache WHERE id = ? AND account_id = ?").bind(deleteId, accountId)
    );
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }
}

/**
 * 增量写入该账号的一批域名（不删除任何行）
 */
export async function upsertAccountDomains(db: D1Database, accountId: number, subdomains: UpstreamSubdomain[]): Promise<void> {
  if (subdomains.length === 0) return;
  const statements = subdomains.map((sub) => buildDomainUpsert(db, accountId, sub));
  await db.batch(statements);
}

/**
 * 标记域名已续期成功
 */
export async function markDomainRenewed(db: D1Database, id: number, newExpiresAt: string): Promise<void> {
  const beijingNow = getBeijingNow();
  await db.prepare(`
    UPDATE domains_cache
    SET expires_at = ?, last_renewed_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(newExpiresAt, beijingNow, beijingNow, id).run();
}

/**
 * 从本地缓存中移除一条域名记录
 */
export async function deleteDomainFromCache(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM domains_cache WHERE id = ?").bind(id).run();
}

/**
 * 实时更新域名的解析状态与 NS 标记 (用于 DNS 增删改后精准即时刷新状态)
 */
export async function updateDomainStatusAndDns(db: D1Database, domainId: number, status: string, hasDns: number, dnsProvider?: string): Promise<void> {
  try {
    const beijingNow = getBeijingNow();
    await db.prepare(
      "UPDATE domains_cache SET status = ?, has_dns = ?, dns_provider = ?, updated_at = ? WHERE id = ?"
    ).bind(status, hasDns, dnsProvider || (hasDns ? "system" : "external"), beijingNow, domainId).run();
  } catch (e) {
    console.error("Failed to update domain status and dns:", e);
  }
}
