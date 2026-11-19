import type { DashboardStats } from "./dashboard-stats";
export const CATALOG_PROVIDERS = ["dnshe", "cloudflare", "digitalplat", "dnspod", "alidns", "huaweicloud", "vercel", "custom"] as const;
export type CatalogProvider = typeof CATALOG_PROVIDERS[number];
export interface CatalogCount { total: number; has_dns: number; }
export interface CatalogHint {
  providers: CatalogProvider[];
  dnshe?: { id: number; expires_at: string; created_at?: string };
  digitalplat?: { id: number; expires_at: string; created_at?: string };
}
export interface CatalogSummary {
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
}
export interface CatalogSearch {
  query: string;
  groups: Record<CatalogProvider, { total: number; items: CatalogSearchItem[] }>;
}
export interface CatalogPage<T, C> {
  domains: T[];
  custom_domains: C[];
  next_cursor: string | null;
  total: number;
  account_counts: Record<string, CatalogCount>;
  hints: Record<string, CatalogHint>;
}
