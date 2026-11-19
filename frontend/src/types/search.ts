import type { Domain } from "./domain";
import type { CustomDomain } from "./custom";
import type { MultiProviderKey, JumpSource } from "./provider";

/** 跨来源搜索命中的聚合结果形状 */
export interface CrossSourceResult {
  kw: string;
  dnsheHits: Array<Pick<Domain, "id" | "full_domain">>;
  cfHits: Array<Pick<Domain, "id" | "full_domain">>;
  dpHits: Array<Pick<Domain, "id" | "full_domain">>;
  /** 四个新托管商的命中结果，按 provider key 索引 */
  multiHits: Record<MultiProviderKey, Array<Pick<Domain, "id" | "full_domain">>>;
  customHits: Array<Pick<CustomDomain, "id" | "full_domain">>;
  totals?: Record<JumpSource, number>;
}
