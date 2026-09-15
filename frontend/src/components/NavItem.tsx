import React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../components/cn";

/**
 * NavItem —— 侧栏导航项
 *
 * WHY 抽出来：
 * 侧栏原先有「DNSHE 带子菜单」和「普通项」两个几乎重复的 button 分支，
 * 两者的样式串（约 10 个 class）逐字复制，badge 的实现也各写一份。
 * 一旦调整选中态或 badge 视觉就要改两处、容易漏。
 *
 * 同时引入「来源色」：DNSHE 紫 / Cloudflare 橙 / DigitalPlat 绿 / 自定义琥珀，
 * 与跨源搜索、域名来源徽章共用同一套令牌，让用户扫侧栏就能建立
 * 「哪个色 = 哪个服务商」的认知，然后在域名卡片上直接复用这个认知。
 */

/** 与 TabKey 的来源部分对齐，便于把 provider 字符串直接映射进来 */
export type NavSource = "dnshe" | "cloudflare" | "digitalplat" | "custom";

const SOURCE_ICON_STYLES: Record<NavSource, string> = {
  dnshe: "text-source-dnshe-fg",
  cloudflare: "text-source-cf-fg",
  digitalplat: "text-source-dp-fg",
  custom: "text-source-custom-fg"
};

const SOURCE_DOT_STYLES: Record<NavSource, string> = {
  dnshe: "bg-source-dnshe-fg",
  cloudflare: "bg-source-cf-fg",
  digitalplat: "bg-source-dp-fg",
  custom: "bg-source-custom-fg"
};

export interface NavItemProps {
  label: string;
  icon: LucideIcon;
  active: boolean;
  /** 折叠为图标条模式（中等屏幕以下/用户收起侧栏） */
  railMode?: boolean;
  /** 右侧计数徽章。0 / undefined 不显示 */
  badge?: number;
  /** 服务商来源，决定图标与色带的颜色 */
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
    active,
    railMode = false,
    badge,
    source,
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
        <Icon
          className={cn(
            "w-5 h-5 flex-shrink-0",
            /* 选中态时图标统一用强调色对比前景（压在渐变底上），未选中时按来源着色。
               NOTE: 不能用 --accent-contrast 的类名 —— Tailwind 未映射该令牌，
               这里用 text-current 让图标继承按钮的 color（即 accent-contrast）。 */
            active ? "text-current" : source ? SOURCE_ICON_STYLES[source] : undefined
          )}
          aria-hidden="true"
        />

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
        "transition-colors duration-fast",
        active
          ? "text-source-dnshe-fg bg-source-dnshe-bg"
          : "text-content-muted hover:text-content-primary hover:bg-hovered"
      )}
    >
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full flex-shrink-0",
          active ? SOURCE_DOT_STYLES.dnshe : "bg-current opacity-40"
        )}
        aria-hidden="true"
      />
      {label}
    </button>
  );
}
