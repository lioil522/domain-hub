/**
 * useDashboardStats —— 「概览（Dashboard）」标签页的聚合统计。
 *
 * 纯计算在 ./stats.ts，这里只负责按依赖缓存。抽出的原因见 stats.ts 顶部：
 * 统计口径必须能被 Node 测试直接验证，而不是只能靠页面肉眼检查。
 */
import { useMemo } from "react";
import { computeDashboardStats, type DashboardStatsOptions } from "../stats";

export type { DashboardStats } from "../stats";
export type UseDashboardStatsOptions = DashboardStatsOptions;

export function useDashboardStats(options: UseDashboardStatsOptions) {
  const {
    domains,
    cfZones,
    dpDomains,
    customDomains,
    multiProviderDomains,
    dnsheAccounts,
    cfAccountList,
    dpAccountList,
    customGroupList,
    multiProviderAccounts,
    cfExpiryMap,
  } = options;

  return useMemo(
    () =>
      computeDashboardStats({
        domains,
        cfZones,
        dpDomains,
        customDomains,
        multiProviderDomains,
        dnsheAccounts,
        cfAccountList,
        dpAccountList,
        customGroupList,
        multiProviderAccounts,
        cfExpiryMap,
      }),
    [domains, cfZones, dpDomains, customDomains, multiProviderDomains, dnsheAccounts, cfAccountList, dpAccountList, customGroupList, multiProviderAccounts, cfExpiryMap]
  );
}
