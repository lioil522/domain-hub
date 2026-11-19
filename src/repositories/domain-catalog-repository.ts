import { DatabaseManager } from "../db";
import type { DBDomain } from "../db";
import { RDAP_CACHE_PREFIX } from "../db";
import type { CatalogProvider } from "../../shared/domain-catalog";
import type { SummaryDomain } from "../../shared/dashboard-stats";

export interface CatalogRow extends SummaryDomain {
  id: number;
  account_id: number;
  provider: CatalogProvider;
  rootdomain: string;
  has_dns: number;
}
export interface CatalogCustomRow {
  id: number; group_id: number; account_id: number | null; full_domain: string;
  registered_at: string | null; expires_at: string; remark: string | null; updated_at: string;
  account_name?: string | null;
}
interface SqlPageFilter { provider: CatalogProvider; filter?: number; status?: string; ids?: number[]; }
export class DomainCatalogRepository {
  constructor(private readonly db: DatabaseManager) {}

  // Compact projection is consumed on the server, never sent as a full browser inventory.
  projection() {
    return this.db.allRaw<CatalogRow>(`SELECT d.id,d.account_id,d.full_domain,d.expires_at,d.created_at,d.status,
      d.rootdomain,COALESCE(d.has_dns,0) has_dns,COALESCE(a.alias,'') account_alias,
      COALESCE(a.provider,'dnshe') provider FROM domains_cache d LEFT JOIN accounts a ON a.id=d.account_id ORDER BY d.id`);
  }
  custom() {
    return this.db.allRaw<Pick<CatalogCustomRow, "id" | "group_id" | "full_domain" | "expires_at">>(
      "SELECT id,group_id,full_domain,expires_at FROM custom_domains ORDER BY id");
  }
  searchProjection() {
    return this.db.allRaw<{ id: number; full_domain: string; account_id: number; provider: CatalogProvider }>(`
      SELECT d.id,d.full_domain,d.account_id,COALESCE(a.provider,'dnshe') provider FROM domains_cache d
      LEFT JOIN accounts a ON a.id=d.account_id
      UNION ALL SELECT id,full_domain,group_id account_id,'custom' provider FROM custom_domains ORDER BY id`);
  }
  private selection(input: SqlPageFilter) {
    const custom = input.provider === "custom";
    let from = custom ? "FROM custom_domains d LEFT JOIN custom_accounts ca ON ca.id=d.account_id WHERE 1=1" : "FROM domains_cache d LEFT JOIN accounts a ON a.id=d.account_id WHERE COALESCE(a.provider,'dnshe') = ?";
    const binds: (number | string)[] = custom ? [] : [input.provider];
    if (input.filter !== undefined) { from += custom ? " AND d.group_id=?" : " AND d.account_id=?"; binds.push(input.filter); }
    if (input.status && !custom) { from += " AND d.status=?"; binds.push(input.status); }
    if (input.ids !== undefined) { from += " AND d.id IN (SELECT value FROM json_each(?))"; binds.push(JSON.stringify(input.ids)); }
    return { from, binds, custom };
  }
  async ceiling(input: SqlPageFilter) {
    const { from, binds } = this.selection(input);
    return (await this.db.firstRaw<{ ceiling: number | null }>(`SELECT MAX(d.id) ceiling ${from}`, binds))?.ceiling ?? -1;
  }
  async counts(input: SqlPageFilter, ceiling: number) {
    const { from, binds, custom } = this.selection(input);
    return this.db.allRaw<{ account_id: number; total: number; has_dns: number }>(`
      SELECT ${custom ? "d.group_id" : "d.account_id"} account_id,COUNT(*) total,
      ${custom ? "0" : "SUM(CASE WHEN d.has_dns THEN 1 ELSE 0 END)"} has_dns
      ${from} AND d.id<=? GROUP BY ${custom ? "d.group_id" : "d.account_id"}`, [...binds, ceiling]);
  }
  page(input: SqlPageFilter, after: number, ceiling: number, limit: number) {
    const { from, binds, custom } = this.selection(input);
    const sql = `SELECT d.*${custom ? ",ca.name account_name" : ",a.alias account_alias,a.provider account_provider"}
      ${from} AND d.id>? AND d.id<=? ORDER BY d.id ASC LIMIT ?`;
    const parameters = [...binds, after, ceiling, limit + 1];
    return custom ? this.db.allRaw<CatalogCustomRow>(sql, parameters) : this.db.allRaw<DBDomain>(sql, parameters);
  }
  hintRows(names: string[]) {
    return this.db.allRaw<Pick<CatalogRow, "id" | "provider" | "full_domain" | "expires_at" | "created_at">>(`
      SELECT d.id,d.full_domain,d.expires_at,d.created_at,COALESCE(a.provider,'dnshe') provider
      FROM domains_cache d LEFT JOIN accounts a ON a.id=d.account_id
      WHERE lower(trim(d.full_domain,' .')) IN (SELECT value FROM json_each(?)) ORDER BY d.id`, [JSON.stringify(names)]);
  }
  accounts() { return this.db.allRaw<{ id: number; alias: string; provider: CatalogProvider }>("SELECT id,alias,provider FROM accounts ORDER BY id"); }
  expiryMetadata() {
    return this.db.allRaw<{ kind: "cache" | "manual"; full_domain: string; expires_at: string | null; value: string | null }>(`
      SELECT 'cache' kind,substr(key,?) full_domain,NULL expires_at,value,'' updated_at,0 id
      FROM cache WHERE key LIKE ? AND expires_at>?
      UNION ALL SELECT 'manual' kind,full_domain,expires_at,NULL value,updated_at,id
      FROM domain_date_overrides ORDER BY kind,updated_at,id`,
      [RDAP_CACHE_PREFIX.length + 1, `${RDAP_CACHE_PREFIX}%`, Math.floor(Date.now() / 1000)]);
  }
}
