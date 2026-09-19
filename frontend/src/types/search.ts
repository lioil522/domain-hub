import type { Domain } from "./domain";
import type { CustomDomain } from "./custom";
import type { MultiProviderKey } from "./provider";

/** 跨来源搜索命中的聚合结果形状 */
export interface CrossSourceResult {
  kw: string;
  dnsheHits: Domain[];
  cfHits: Domain[];
  dpHits: Domain[];
  /** 四个新托管商的命中结果，按 provider key 索引 */
  multiHits: Record<MultiProviderKey, Domain[]>;
  customHits: CustomDomain[];
}
