import { useEffect, useState } from "react";
import type { Domain } from "../../../types/domain";
import { domainKeyCandidates } from "../../../lib/domain-keys";

/** `useCfZoneHighlight` 的外部依赖 —— 由 `App.tsx` 注入 */
export interface UseCfZoneHighlightOptions {
  /**
   * 当前标签页。仅用于与 `"cloudflare"` 比较，故取 `string`，
   * 避免把 `App` 内部的 `TabKey` 联合类型导出（会牵动大量无关类型）。
   */
  activeTab: string;
  /** CF zones（按域名键定位目标 zone） */
  cfZones: Domain[];
  /** 已收起的分组账号 id（跳转前需展开目标分组） */
  cfCollapsedAccounts: Set<number>;
  /** 折叠状态落盘（useCfZones 返回，保证与折叠按钮共用同一套持久化） */
  persistCfCollapsed: (next: Set<number>) => void;
  /** 切换标签页 */
  setActiveTab: (tab: "cloudflare") => void;
}

/**
 * Cloudflare「跨来源跳转 + 跳转后定位高亮」
 *
 * 从 `App.tsx` 抽出（Phase 5-4d）。**纯搬运**：
 *   - `gotoCfZone(fullDomain)`：按域名键找到同名 zone，切到 CF 标签页，
 *     必要时展开其账号分组，并设置高亮 id；
 *   - 定位高亮 effect：等标签页与分组展开渲染完成后平滑滚动到目标卡片
 *     （`#cf-zone-card-{id}`），停留 4 秒自动清除。
 *
 * NOTE: 高亮 effect 只依赖 `(cfHighlightZoneId, activeTab)`，**不 import 任何页面**；
 * 跳转只通过「设置 activeTab + 设置 highlightId」这组中立信号完成
 * （见任务书 §6.3）。
 */
export function useCfZoneHighlight({
  activeTab,
  cfZones,
  cfCollapsedAccounts,
  persistCfCollapsed,
  setActiveTab,
}: UseCfZoneHighlightOptions) {
  // 从 DNSHE 域名页交叉提示跳转过来时待定位的 zone（domains_cache id），短暂高亮后自动清除
  const [cfHighlightZoneId, setCfHighlightZoneId] = useState<number | null>(null);

  // 交叉提示跳转：切到 Cloudflare 标签页并定位到同名 zone 的卡片
  const gotoCfZone = (fullDomain: string) => {
    const keys = domainKeyCandidates(String(fullDomain || ""));
    const zone = cfZones.find((z) =>
      domainKeyCandidates(String(z.full_domain || "")).some((k) => keys.includes(k))
    );
    setActiveTab("cloudflare");
    if (!zone) return;
    // 展开该 zone 所在的账号分组，否则卡片不可见、无从滚动定位
    if (cfCollapsedAccounts.has(zone.account_id)) {
      const next = new Set(cfCollapsedAccounts);
      next.delete(zone.account_id);
      persistCfCollapsed(next);
    }
    setCfHighlightZoneId(zone.id);
  };

  // 定位高亮：等标签页与分组展开渲染完成后平滑滚动到目标卡片，停留数秒自动清除
  useEffect(() => {
    if (cfHighlightZoneId === null || activeTab !== "cloudflare") return;
    const scrollTimer = window.setTimeout(() => {
      document.getElementById(`cf-zone-card-${cfHighlightZoneId}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    }, 150);
    const clearTimer = window.setTimeout(() => setCfHighlightZoneId(null), 4000);
    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [cfHighlightZoneId, activeTab]);

  return { cfHighlightZoneId, gotoCfZone };
}
