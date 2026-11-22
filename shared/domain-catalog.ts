import type { DashboardStats } from "./dashboard-stats";
export const CATALOG_PROVIDERS = ["dnshe", "cloudflare", "digitalplat", "dnspod", "alidns", "huaweicloud", "vercel", "custom"] as const;
export type CatalogProvider = typeof CATALOG_PROVIDERS[number];
export type CatalogSearchScope = "domain" | "dns" | "all";
export interface CatalogDnsMatch { type: string; name: string; preview: string; }
export interface CatalogCount { total: number; has_dns: number; }
export interface CatalogHint {
  providers: CatalogProvider[];
  dnshe?: { id: number; expires_at: string; created_at?: string };
  digitalplat?: { id: number; expires_at: string; created_at?: string };
}
export interface CatalogSummary {
  snapshot_at?: number;
  valid_until?: number;
  stats: DashboardStats;
  provider_counts: Record<CatalogProvider, number>;
  account_counts: Record<string, CatalogCount>;
  root_domains: string[];
}
export interface CatalogSearchItem {
  id: number;
  full_domain: string;
  account_id: number;
  provider: CatalogProvider;
  dns_match?: CatalogDnsMatch;
}
export interface CatalogSearch {
  query: string;
  groups: Record<CatalogProvider, { total: number; items: CatalogSearchItem[] }>;
  scope?: CatalogSearchScope;
  dns_scope?: "valid_cached_records";
}
export interface CatalogPage<T, C> {
  domains: T[];
  custom_domains: C[];
  next_cursor: string | null;
  total: number;
  account_counts: Record<string, CatalogCount>;
  hints: Record<string, CatalogHint>;
}
