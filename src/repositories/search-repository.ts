import type { DatabaseManager } from "../db";

/** Only searchable public business fields: never account credentials or settings. */
export class SearchRepository {
  constructor(private readonly db: DatabaseManager) {}
  domainsByMetadata(query: string, limit: number) {
    return this.db.allRaw<{ id: number; full_domain: string; account_id: number; account_provider: string; status: string }>(`
      SELECT d.id AS id,d.full_domain,d.account_id,COALESCE(a.provider,'dnshe') account_provider,substr(d.status,1,128) status
      FROM domains_cache d LEFT JOIN accounts a ON a.id=d.account_id
      WHERE instr(lower(COALESCE(d.status,'')),?)>0 OR instr(lower(COALESCE(a.alias,'')),?)>0
      UNION ALL SELECT d.id,d.full_domain,d.group_id account_id,'custom' account_provider,'手动管理' status
      FROM custom_domains d JOIN accounts a ON a.id=d.group_id LEFT JOIN custom_accounts ca ON ca.id=d.account_id
      WHERE instr(lower(COALESCE(a.alias,'')),?)>0 OR instr(lower(COALESCE(ca.name,'')),?)>0 OR instr(lower(COALESCE(d.remark,'')),?)>0
      ORDER BY id LIMIT ?`, [query, query, query, query, query, limit]);
  }
  accounts(query: string, limit: number) {
    return this.db.allRaw<{ id: number; alias: string; provider: string }>(`SELECT id,
      substr(alias,MAX(1,instr(lower(alias),?)-48),512) alias,COALESCE(provider,'dnshe') provider FROM accounts
      WHERE instr(lower(alias),?)>0 OR instr(lower(COALESCE(provider,'dnshe')),?)>0
      ORDER BY CASE WHEN lower(alias)=? THEN 1000 WHEN instr(lower(alias),?)=1 THEN 800
        WHEN instr(lower(alias),?)>0 THEN 600 ELSE 300 END DESC,id LIMIT ?`, [query, query, query, query, query, query, limit]);
  }
  logs(query: string, limit: number) {
    return this.db.allRaw<{ id: number; message: string; category: string }>(`SELECT id,
      substr(message,MAX(1,instr(lower(message),?)-48),512) message,substr(category,1,128) category FROM logs
      WHERE instr(lower(message),?)>0 OR instr(lower(category),?)>0
      ORDER BY CASE WHEN lower(message)=? THEN 1000 WHEN instr(lower(message),?)=1 THEN 800
        WHEN instr(lower(message),?)>0 THEN 600 ELSE 300 END DESC,created_at DESC,id DESC LIMIT ?`,
      [query, query, query, query, query, query, limit]);
  }
}
