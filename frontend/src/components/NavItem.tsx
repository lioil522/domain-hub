import React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../components/cn";
import { BrandLogo, type BrandKey } from "./BrandLogo";

/**
 * NavItem —— 侧栏导航项
 *
 * WHY 抽出来：
 * 侧栏原先有「DNSHE 带子菜单」和「普通项」两个几乎重复的 button 分支，
 * 两者的样式串（约 10 个 class）逐字复制，badge 的实现也各写一份。
 * 一旦调整选中态或 badge 视觉就要改两处、容易漏。
 *
 * 图标分两套：
 * - `brand`  → 服务商项，渲染**真实品牌图标**（彩色），一眼认得出是哪家
 * - `icon`   → 功能项（概览/账号管理/日志…），继续用 lucide 线性图标
 *
 * 原先服务商项也走 lucide 通用图标 + 来源色，但 Cloudflare 与华为云都是
 * 「云」、DNSPod 与阿里云都是「服务器」，用户必须读文字才能分辨 ——
 * 服务商图标的首要职责是「一眼认得出」，通用图标做不到这件事。
 */

/** 与 TabKey 的来源部分对齐，便于把 provider 字符串直接映射进来 */
export type NavSource =
  | "dnshe"
  | "cloudflare"
  | "digitalplat"
  | "dnspod"
  | "alidns"
  | "huaweicloud"
  | "vercel"
  | "custom";



export interface NavItemProps {
  label: string;
  /** 功能项的 lucide 图标。与 `brand` 二选一，`brand` 优先 */
  icon?: LucideIcon;
  /** 服务商项的真实品牌图标。传了它就用品牌 logo 而非 lucide 图标 */
  brand?: BrandKey;
  active: boolean;
  /** 折叠为图标条模式（中等屏幕以下/用户收起侧栏） */
  railMode?: boolean;
  /** 右侧计数徽章。0 / undefined 不显示 */
  badge?: number;
  /** 服务商来源，决定色带颜色（品牌图标本身已带色，此项只影响 badge 等） */
  source?: NavSource;
  /** 展开的子元素（如 DNSHE 的子菜单） */
  children?: React.ReactNode;
  /** 该项是否展开子菜单，控制箭头方向 */
  expanded?: boolean;
  /** 该项是否含子菜单（决定是否渲染箭头） */
  hasSubmenu?: boolean;
  onClick: () => void;
}

export function NavItem(props: NavItemProps) {
  const {
    label,
    icon: Icon,
    brand,
    active,
    railMode = false,
    badge,
    children,
    expanded = false,
    hasSubmenu = false,
    onClick
  } = props;

  const showBadge = badge !== undefined && badge > 0;

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        /* railMode 下只剩图标，必须靠 title 提供名称，否则无法辨识 */
        title={railMode ? label : undefined}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group w-full flex items-center gap-3 px-3 py-3 md:py-2.5 rounded-lg",
          "text-sm font-semibold transition-all duration-fast ease-out",
          // 选中态：品牌渐变 + 轻辉光，与 Button primary 同源，强化「当前所在」的锚点。
          // NOTE: 走 .bg-accent-gradient + shadow-accent 令牌，不写 indigo 色阶 ——
          // 换主题时这里自动跟随，无需改动。
          active
            ? "bg-accent-gradient shadow-accent"
            : "text-content-muted hover:text-content-primary hover:bg-hovered",
          railMode && "justify-center"
        )}
      >
        {brand ? (
          /* 品牌图标：未选中时保留原色（这是品牌识别的一部分）；选中态压在
             品牌渐变上，彩色 logo 会与青绿/靛蓝底糊在一起，降为单色更清晰。
             NOTE: 这里不挂 text-* 类 —— mono 模式读的是 currentColor，
             而 currentColor 已由按钮的 active 态决定（即 accent-contrast）。 */
          <BrandLogo
            brand={brand}
            size={20}
            mono={active}
            className="flex-shrink-0"
          />
        ) : Icon ? (
          <Icon
            className={cn(
              "w-5 h-5 flex-shrink-0",
              /* 选中态时图标统一用强调色对比前景（压在渐变底上）。
                 NOTE: 不能用 --accent-contrast 的类名 —— Tailwind 未映射该令牌，
                 这里用 text-current 让图标继承按钮的 color（即 accent-contrast）。 */
              active ? "text-current" : undefined
            )}
            aria-hidden="true"
          />
        ) : null}

        {!railMode && (
          <>
            <span className="flex-1 text-left whitespace-nowrap">{label}</span>

            {showBadge && (
              <span
                className={cn(
                  "text-[11px] font-semibold px-1.5 py-0.5 rounded-full tabular-nums flex-shrink-0",
                  /* 选中态压渐变底上，用半透明白底 + 继承对比前景保证可读；
                     未选中态统一用中性底（原先两条分支输出完全相同，已收敛）。
                     NOTE: 这里刻意不用 accent 半透明 —— 墨玉主题暗色下
                     accent 是亮青绿，配白字只有 1.9:1。用「深底上的浅面」更稳。 */
                  active
                    ? "bg-black/15 text-current"
                    : "bg-elevated text-content-secondary border border-border-base"
                )}
              >
                {badge}
              </span>
            )}

            {hasSubmenu && (
              <svg
                className={cn(
                  "w-4 h-4 flex-shrink-0 transition-transform duration-base",
                  expanded && "rotate-180"
                )}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            )}
          </>
        )}
      </button>

      {children}
    </div>
  );
}

/**
 * NavSubItem —— 侧栏子菜单项
 * 用于 DNSHE 的「域名列表 / 注册·查重」。
 */
export interface NavSubItemProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

export function NavSubItem({ label, active, onClick }: NavSubItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold",
        "transition-all duration-fast",
        active
          ? "text-accent bg-accent-soft border border-accent/20 shadow-xs"
          : "text-content-muted hover:text-content-primary hover:bg-hovered border border-transparent"
      )}
    >
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full flex-shrink-0",
          active ? "bg-accent shadow-xs shadow-accent" : "bg-current opacity-40"
        )}
        aria-hidden="true"
      />
      {label}
    </button>
  );
}
