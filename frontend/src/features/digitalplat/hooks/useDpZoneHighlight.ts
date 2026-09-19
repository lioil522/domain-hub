import { useEffect, useState } from "react";
import type { Domain } from "../../../types/domain";
import { domainKeyCandidates } from "../../../lib/domain-keys";

/** `useDpZoneHighlight` 的外部依赖 —— 由 `App.tsx` 注入 */
export interface UseDpZoneHighlightOptions {
  /**
   * 当前标签页。仅用于与 `"digitalplat"` 比较，故取 `string`，
   * 避免把 `App` 内部的 `TabKey` 联合类型导出（会牵动大量无关类型）。
   */
  activeTab: string;
  /** DP 域名（按域名键定位目标域名） */
  dpDomains: Domain[];
  /** 当前账号筛选（跳转时若收窄则放宽到全部，避免目标卡片不可见） */
  dpAccountFilter: string;
  /** 账号筛选 setter（useDpDomains 返回） */
  setDpAccountFilter: (v: string) => void;
  /** 已收起的分组账号 id（跳转前需展开目标分组） */
  dpCollapsedAccounts: Set<number>;
  /** 折叠状态落盘（useDpDomains 返回，保证与折叠按钮共用同一套持久化） */
  persistDpCollapsed: (next: Set<number>) => void;
  /** 切换标签页 */
  setActiveTab: (tab: "digitalplat") => void;
}

/**
 * DigitalPlat「跨来源跳转 + 跳转后定位高亮」
 *
 * 从 `App.tsx` 抽出（Phase 6-3），结构与 `useCfZoneHighlight` 同构。**纯搬运**：
 *   - `gotoDpDomain(fullDomain)`：按域名键找到同名域名，切到 DP 标签页，
 *     放宽账号筛选、必要时展开其账号分组，并设置高亮 id；
 *   - 定位高亮 effect：等标签页与分组展开渲染完成后平滑滚动到目标卡片
 *     （`#dp-domain-card-{id}`），停留 4 秒自动清除。
 *
 * NOTE: 高亮 effect 只依赖 `(dpHighlightDomainId, activeTab)`，**不 import 任何页面**；
 * 跳转只通过「设置 activeTab + 设置 highlightId」这组中立信号完成（见任务书 §6.3）。
 */
export function useDpZoneHighlight({
  activeTab,
  dpDomains,
  dpAccountFilter,
  setDpAccountFilter,
  dpCollapsedAccounts,
  persistDpCollapsed,
  setActiveTab,
}: UseDpZoneHighlightOptions) {
  // 从 Cloudflare zone 卡片交叉提示跳转过来时待定位的 DP 域名卡片 id（短暂高亮后自动清除）
  const [dpHighlightDomainId, setDpHighlightDomainId] = useState<number | null>(null);

  // 交叉提示跳转（CF zone 卡片 → DigitalPlat 标签页）：切页、放宽账号筛选、展开分组并定位
  const gotoDpDomain = (fullDomain: string) => {
    const keys = domainKeyCandidates(String(fullDomain || ""));
    const dp = dpDomains.find((d) =>
      domainKeyCandidates(String(d.full_domain || "")).some((k) => keys.includes(k))
    );
    setActiveTab("digitalplat");
    if (!dp) return;
    // 账号筛选若收窄到其它账号会让目标卡片不可见，跳转时一律放宽到全部
    if (dpAccountFilter !== "all") setDpAccountFilter("all");
    if (dpCollapsedAccounts.has(dp.account_id)) {
      const next = new Set(dpCollapsedAccounts);
      next.delete(dp.account_id);
      persistDpCollapsed(next);
    }
    setDpHighlightDomainId(dp.id);
  };

  // 定位高亮（DigitalPlat）：逻辑与 cfHighlightZoneId 的 effect 一致
  useEffect(() => {
    if (dpHighlightDomainId === null || activeTab !== "digitalplat") return;
    const scrollTimer = window.setTimeout(() => {
      document.getElementById(`dp-domain-card-${dpHighlightDomainId}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    }, 150);
    const clearTimer = window.setTimeout(() => setDpHighlightDomainId(null), 4000);
    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [dpHighlightDomainId, activeTab]);

  return { dpHighlightDomainId, gotoDpDomain };
}
