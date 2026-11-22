import type { DatabaseManager } from "../db";
import type { CatalogProvider } from "../../shared/domain-catalog";
import { toASCII } from "../../shared/punycode";

export const DNS_SEARCH_CACHE_PREFIX = "api_cache:dns:";
export function dnsSearchNeedles(query: string) {
  // SQLite folds ASCII case only. Preserve non-ASCII text for literal TXT search.
  const q = query.trim().replace(/[A-Z]/g, value => value.toLowerCase());
  const ascii = toASCII(q);
  return [...new Set([q, ...(ascii.length <= 253 ? [ascii] : [])])].filter(Boolean);
}
export interface CachedDnsHit {
  id: number; full_domain: string; account_id: number; provider: CatalogProvider;
  record_index: number; record_id: string | null; type: string; name: string; preview: string;
  score: number;
}
interface DnsSearchOptions { provider?: CatalogProvider; accountId?: number; eachRecord?: boolean; limit?: number; }
export class CachedDnsSearchRepository {
  constructor(private readonly db: DatabaseManager) {}
  async matches(query: string, options: DnsSearchOptions = {}): Promise<CachedDnsHit[]> {
    const needles = dnsSearchNeedles(query);
    if (!needles.length || options.provider === "custom") return [];
    // Never return cache blobs to the Worker. JSON is guarded before expansion,
    // then only bounded fields from currently owned, unexpired DNS entries leave SQL.
    const cacheJson = `CASE WHEN length(CAST(c.value AS BLOB))<=524288 THEN
      CASE WHEN json_valid(c.value) THEN CASE WHEN json_type(c.value)='array' THEN c.value ELSE '[]' END
      ELSE '[]' END ELSE '[]' END`;
    const record = "CASE WHEN r.type='object' THEN r.value ELSE '{}' END";
    const text = (field: string) => `CASE WHEN json_type(${record},'$.${field}')='text' THEN json_extract(${record},'$.${field}') ELSE '' END`;
    const id = `CASE WHEN json_type(${record},'$.id') IN ('text','integer') THEN CAST(json_extract(${record},'$.id') AS TEXT)
      WHEN json_type(${record},'$.record_id') IN ('text','integer') THEN CAST(json_extract(${record},'$.record_id') AS TEXT) ELSE NULL END`;
    const scope = `${options.provider ? " AND COALESCE(a.provider,'dnshe')=?" : ""}${options.accountId === undefined ? "" : " AND d.account_id=?"}`;
    const binds: (string | number)[] = [JSON.stringify(needles), DNS_SEARCH_CACHE_PREFIX, `${DNS_SEARCH_CACHE_PREFIX}\uffff`, Math.floor(Date.now() / 1000)];
    if (options.provider) binds.push(options.provider);
    if (options.accountId !== undefined) binds.push(options.accountId);
    if (options.limit !== undefined) binds.push(options.limit);
    return this.db.allRaw<CachedDnsHit>(`WITH needles AS (SELECT value q FROM json_each(?)),
      fields AS (
        SELECT d.id,d.full_domain,d.account_id,COALESCE(a.provider,'dnshe') provider,CAST(r.key AS INTEGER) record_index,
          ${id} record_id,${text("type")} type,${text("name")} name,${text("content")} content,
          json_type(${record},'$.content')='text' content_valid,
          (json_type(${record},'$.name') IS NULL OR json_type(${record},'$.name') IN ('text','null')) name_valid
        FROM cache c JOIN domains_cache d
          ON d.id=CAST(substr(c.key,${DNS_SEARCH_CACHE_PREFIX.length + 1}) AS INTEGER)
          AND c.key='${DNS_SEARCH_CACHE_PREFIX}'||CAST(d.id AS TEXT)
        JOIN accounts a ON a.id=d.account_id CROSS JOIN json_each(${cacheJson}) r
        WHERE c.key>? AND c.key<? AND c.expires_at>?
          AND COALESCE(a.provider,'dnshe') IN ('dnshe','cloudflare','digitalplat','dnspod','alidns','huaweicloud','vercel')${scope}
      ),
      matched AS (
        SELECT *,(SELECT MIN(NULLIF(instr(lower(content),q),0)) FROM needles) content_position
        FROM fields WHERE content_valid AND name_valid AND length(type) BETWEEN 1 AND 16 AND length(name)<=254
          AND EXISTS(SELECT 1 FROM needles WHERE instr(lower(type),q)>0 OR instr(lower(name),q)>0 OR instr(lower(content),q)>0)
      ),
      bounded AS (SELECT id,full_domain,account_id,provider,record_index,
        CASE WHEN length(record_id)<=128 THEN record_id ELSE NULL END record_id,type,name,
        CASE WHEN EXISTS(SELECT 1 FROM needles WHERE lower(CASE WHEN name='' THEN full_domain ELSE name END)=q) THEN 1000
          WHEN EXISTS(SELECT 1 FROM needles WHERE instr(lower(CASE WHEN name='' THEN full_domain ELSE name END),q)=1) THEN 800
          WHEN EXISTS(SELECT 1 FROM needles WHERE instr(lower(CASE WHEN name='' THEN full_domain ELSE name END),q)>0) THEN 600
          ELSE 300 END score,
        substr(content,CASE WHEN content_position>0 THEN MAX(1,content_position-48) ELSE 1 END,512) preview FROM matched),
      ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY id ORDER BY record_index) ordinal FROM bounded)
      SELECT id,full_domain,account_id,provider,record_index,record_id,type,name,preview,score
      FROM ranked ${options.eachRecord ? "" : "WHERE ordinal=1"} ORDER BY ${options.eachRecord ? "score DESC," : ""}id,record_index${options.limit === undefined ? "" : " LIMIT ?"}`, binds);
  }
}
