import type { LucideIcon } from "lucide-react";
import {
  Globe,
  Cloud,
  Server,
  Triangle,
  Folder,
  Key,
  Plus,
  Database,
  ScrollText,
  Settings,
  LayoutDashboard,
} from "lucide-react";
import type { NavSource } from "../components/NavItem";
import type { BrandKey } from "../components/BrandLogo";
import type { Account } from "../types/account";
import { DNSHE_PROVIDERS } from "../constants/providers";

/**
 * app/navigation.ts —— 标签页标识与侧栏导航推导
 *
 * WHY 集中到这里:
 *   原先 TabKey / TAB_KEYS / tabFromHash / NAV_ICONS / visibleNavItems 的推导
 *   全部平铺在 App.tsx 内,合计约 100 行,且与页面组装、业务状态混在一起。
 *   导航是「应用导航」而非某个业务域,归入 app/ 层;推导逻辑做成纯函数后
 *   不依赖 React,可独立验证。
 *
 * 依赖方向:app → components / constants / types,不反向依赖 App.tsx。
 */

/** 全部标签页 key(与 URL hash、侧栏 key、页面分发共用一套字面量) */
export type TabKey =
  | "dashboard"
  | "domains"
  | "cloudflare"
  | "digitalplat"
  | "dnspod"
  | "alidns"
  | "huaweicloud"
  | "vercel"
  | "custom"
  | "accounts"
  | "register"
  | "quota"
  | "line-settings"
  | "logs"
  | "settings";

export const TAB_KEYS: TabKey[] = [
  "dashboard",
  "domains",
  "cloudflare",
  "digitalplat",
  "dnspod",
  "alidns",
  "huaweicloud",
  "vercel",
  "custom",
  "accounts",
  "register",
  "quota",
  "line-settings",
  "logs",
  "settings",
];

/** 从 URL hash 解析当前标签页;非法值回落到概览 */
export function tabFromHash(): TabKey {
  const h = window.location.hash.replace(/^#\/?/, "") as TabKey;
  return TAB_KEYS.includes(h) ? h : "dashboard";
}

/** 侧栏导航项(概览 / 服务商 / 自定义 / 管理项共用同一形状) */
export interface NavigationItem {
  key: TabKey;
  label: string;
  badge?: number;
  source?: NavSource;
  brand?: BrandKey;
}

/**
 * 侧栏图标映射 —— NavItem 接收的是组件本身而非 JSX 元素,
 * 这样才能把着色 class 直接挂在图标上(元素形式需要在调用处再包一层 span)。
 *
 * 四个新托管商暂用同一组通用图标 —— 侧栏已按 label 区分,图标只作视觉锚点。
 * (lucide 没有各云厂商的品牌图标,硬套 logo 反而不利于扫读一致性)
 */
export const NAV_ICONS: Record<TabKey, LucideIcon> = {
  dashboard: LayoutDashboard,
  domains: Globe,
  cloudflare: Cloud,
  digitalplat: Globe,
  dnspod: Server,
  alidns: Server,
  huaweicloud: Server,
  vercel: Triangle,
  custom: Folder,
  accounts: Key,
  register: Plus,
  quota: Database,
  // 解析线路只是 DNSHE 子项,不在一级菜单渲染;这里给个图标满足 TabKey 全覆盖
  "line-settings": Server,
  logs: ScrollText,
  settings: Settings,
};

/** 侧栏各项徽章所需的计数(由 App 从各数据源汇总) */
export interface ProviderNavCounts {
  dnshe: number;
  cloudflare: number;
  digitalplat: number;
  dnspod: number;
  alidns: number;
  huaweicloud: number;
  vercel: number;
}

/** provider key → 侧栏配置(顺序无关,最终顺序由最早绑定时间决定) */
const PROVIDER_NAV_META: Record<Exclude<keyof ProviderNavCounts, "dnshe"> | "dnshe", Omit<NavigationItem, "badge">> = {
  dnshe: { key: "domains", label: "DNSHE", source: "dnshe", brand: "dnshe" },
  cloudflare: { key: "cloudflare", label: "Cloudflare", source: "cloudflare", brand: "cloudflare" },
  digitalplat: { key: "digitalplat", label: "DigitalPlat", source: "digitalplat", brand: "digitalplat" },
  dnspod: { key: "dnspod", label: "DNSPod", source: "dnspod", brand: "dnspod" },
  alidns: { key: "alidns", label: "阿里云 DNS", source: "alidns", brand: "alidns" },
  huaweicloud: { key: "huaweicloud", label: "华为云 DNS", source: "huaweicloud", brand: "huaweicloud" },
  vercel: { key: "vercel", label: "Vercel", source: "vercel", brand: "vercel" },
};

/**
 * 动态服务商菜单项:按该服务商账号的「最早添加时间」升序排列
 *
 * 只有真正绑定了账号的服务商才会显示,且不再受 loadingAccounts 影响,
 * 杜绝刷新时一闪而过的闪烁。自定义(custom)为独立手动录入容器,不参与此排序。
 */
export function buildProviderNavItems(
  accounts: Account[],
  counts: ProviderNavCounts
): NavigationItem[] {
  // 统计每个服务商最早绑定的账号创建时间戳与 ID
  const providerEarliestMap = new Map<string, { time: number; id: number }>();

  accounts.forEach((a) => {
    const raw = a.provider || "dnshe";
    if (raw === "custom") return;
    const p = DNSHE_PROVIDERS.includes(raw) ? "dnshe" : raw;

    const parsed = a.created_at ? new Date(a.created_at).getTime() : 0;
    const t = !isNaN(parsed) && parsed > 0 ? parsed : a.id;

    const cur = providerEarliestMap.get(p);
    if (!cur || t < cur.time || (t === cur.time && a.id < cur.id)) {
      providerEarliestMap.set(p, { time: t, id: a.id });
    }
  });

  const sorted = Array.from(providerEarliestMap.entries()).sort((a, b) => {
    if (a[1].time !== b[1].time) return a[1].time - b[1].time;
    return a[1].id - b[1].id;
  });

  return sorted.flatMap(([p]) => {
    const providerKey = p as keyof ProviderNavCounts;
    const meta = PROVIDER_NAV_META[providerKey];
    if (!meta) return [];
    return [{ ...meta, badge: counts[providerKey] }];
  });
}

/** 实际渲染的侧栏菜单项:概览 + 动态排序的服务商 + 自定义 + 管理项 */
export function buildVisibleNavItems(
  providerItems: NavigationItem[],
  customDomainCount: number,
  accountCount: number
): NavigationItem[] {
  return [
    { key: "dashboard", label: "概览" },
    ...providerItems,
    { key: "custom", label: "自定义", badge: customDomainCount, source: "custom", brand: "custom" },
    { key: "accounts", label: "账号管理", badge: accountCount },
    { key: "logs", label: "运行日志" },
    { key: "settings", label: "设置" },
  ];
}
