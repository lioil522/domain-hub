/** Strict, bounded legacy snapshot contract. Secret ciphertext stays encrypted
 * in exports; importing into another key requires an explicitly supplied source
 * key. Business snapshots never carry sessions/settings/coordination state. */
export const BACKUP_PLAN = [
  { table: "accounts", columns: ["id", "alias", "api_key", "api_secret", "provider", "website", "created_at"], required: ["alias", "api_key", "api_secret", "provider"] },
  { table: "custom_accounts", columns: ["id", "group_id", "name", "updated_at"], required: ["group_id", "name"] },
  { table: "custom_domains", columns: ["id", "group_id", "account_id", "full_domain", "registered_at", "expires_at", "remark", "updated_at"], required: ["group_id", "full_domain", "expires_at"] },
  { table: "domains_cache", columns: ["id", "account_id", "subdomain", "rootdomain", "full_domain", "status", "created_at", "expires_at", "last_renewed_at", "has_dns", "dns_provider", "provider_account_id", "remote_id", "updated_at"], required: ["account_id", "subdomain", "rootdomain", "full_domain", "status", "expires_at"] },
  { table: "domain_date_overrides", columns: ["id", "account_id", "full_domain", "registered_at", "expires_at", "source", "updated_at"], required: ["account_id", "full_domain"] },
] as const;
export type BackupRow = Record<string, string | number | null>;
export interface BusinessSnapshot { version: number; exported_at: string; counts?: Record<string, number>; data: Record<string, BackupRow[]> }
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const id = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
export function validBusinessSnapshot(value: unknown): value is BusinessSnapshot {
  if (!object(value) || value.version !== 1 || typeof value.exported_at !== "string" || !value.exported_at || !object(value.data)) return false;
  const data = value.data;
  if (Object.keys(data).some(key => !BACKUP_PLAN.some(p => p.table === key))) return false;
  let total = 0;
  for (const p of BACKUP_PLAN) {
    const rows = data[p.table]; if (rows === undefined) continue;
    if (!Array.isArray(rows) || (total += rows.length) > 500) return false;
    const seen = new Set<number>(), identities = new Set<string>();
    for (const row of rows) {
      if (!object(row) || !id(row.id) || (p.table !== "domains_cache" && Number(row.id) < 1) || seen.has(Number(row.id))) return false;
      seen.add(Number(row.id));
      if (Object.keys(row).some(k => !(p.columns as readonly string[]).includes(k)) || Object.values(row).some(v => v !== null && typeof v !== "string" && !(typeof v === "number" && Number.isFinite(v)))) return false;
      for (const [key, value] of Object.entries(row)) {
        if (value === null) continue;
        if (["id", "group_id", "account_id", "has_dns"].includes(key)) { if (!id(value)) return false; }
        else if (typeof value !== "string") return false;
      }
      for (const key of p.required) {
        if (key.endsWith("_id")) { if (!id(row[key]) || Number(row[key]) < 1) return false; }
        // Zone apex has an empty subdomain; legacy unknown expiry/root fields
        // are empty TEXT, not fabricated dates. Identity/full_domain stays strict.
        else if (typeof row[key] !== "string" || !["api_secret", "subdomain", "rootdomain", "expires_at"].includes(key) && !row[key]) return false;
      }
      if (p.table === "accounts" && !["dnshe", "cloudflare", "digitalplat", "dnspod", "alidns", "huaweicloud", "vercel", "custom"].includes(String(row.provider))) return false;
      if (p.table === "domains_cache" && row.has_dns !== undefined && row.has_dns !== null && row.has_dns !== 0 && row.has_dns !== 1) return false;
      if (p.table === "custom_domains" && row.account_id !== undefined && row.account_id !== null && (!id(row.account_id) || Number(row.account_id) < 1)) return false;
      const identity = p.table === "accounts" ? [row.api_key] : p.table === "custom_accounts" ? [row.group_id, row.name] :
        p.table === "custom_domains" ? [row.group_id, row.account_id ?? null, row.full_domain] : [row.account_id, row.full_domain];
      const key = JSON.stringify(identity);
      if (identities.has(key)) return false;
      identities.add(key);
    }
  }
  const accounts = new Map((data.accounts as BackupRow[] || []).map(r => [r.id, r]));
  if (new Set([...accounts.values()].map(r => r.api_key)).size !== accounts.size) return false;
  const custom = new Map((data.custom_accounts as BackupRow[] || []).map(r => [r.id, r]));
  for (const r of custom.values()) if (accounts.get(r.group_id)?.provider !== "custom") return false;
  for (const r of data.custom_domains as BackupRow[] || []) if (accounts.get(r.group_id)?.provider !== "custom" || r.account_id != null && custom.get(r.account_id)?.group_id !== r.group_id) return false;
  for (const table of ["domains_cache", "domain_date_overrides"]) for (const r of data[table] as BackupRow[] || []) if (!accounts.has(r.account_id) || accounts.get(r.account_id)?.provider === "custom") return false;
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 8 * 1024 * 1024; } catch { return false; }
}
