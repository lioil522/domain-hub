import type { Domain } from "./domain";
import type { CustomDomain } from "./custom";
import type { MultiProviderKey, JumpSource } from "./provider";
import type { CatalogDnsMatch } from "../../../shared/domain-catalog";
export type SearchDomainHit = Pick<Domain, "id" | "full_domain"> & { account_id?: number; dns_match?: CatalogDnsMatch };

/** 跨来源搜索命中的聚合结果形状 */
export interface CrossSourceResult {
  kw: string;
  dnsheHits: SearchDomainHit[];
  cfHits: SearchDomainHit[];
  dpHits: SearchDomainHit[];
  /** 四个新托管商的命中结果，按 provider key 索引 */
  multiHits: Record<MultiProviderKey, SearchDomainHit[]>;
  customHits: Array<Pick<CustomDomain, "id" | "full_domain"> & { account_id?: number }>;
  totals?: Record<JumpSource, number>;
  dns_scope?: "valid_cached_records";
}
