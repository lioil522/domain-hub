import React from "react";
import { cn } from "./cn";

/**
 * Badge —— 状态与来源标签
 *
 * WHY 需要它：
 * 存量代码里状态徽章的配色直接写死在调用处，例如：
 *   "bg-emerald-50 text-emerald-700 border border-emerald-200
 *    dark:bg-emerald-950/80 dark:text-emerald-400 dark:border-emerald-900/60"
 * 明暗两套共 6 个 class 重复出现在多处，且暗色档位靠人工配对 ——
 * 配对错误不会报错，只会静默显示成错误配色（日志区 bg-red-950 就是实例）。
 * 收敛为 tone 之后，调用处只表达语义，明暗由令牌自动切换。
 *
 * 设计约定：
 * - tone 是语义名（ok/warn/danger/info/idle），不是颜色名
 *   这样「主色改版」时只需改 index.css，所有徽章一起变
 * - source 是服务商专用快捷方式，保证四个服务商在全站用同一套色
 */

/** 状态语义 */
export type BadgeTone = "ok" | "warn" | "danger" | "info" | "idle";

/** 服务商来源：与跨源搜索、侧栏 badge 共用一套映射 */
export type BadgeSource = "dnshe" | "cloudflare" | "digitalplat" | "custom";

export type BadgeSize = "sm" | "md";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** 传入服务商名则自动套用来源色，优先级高于 tone */
  source?: BadgeSource;
  size?: BadgeSize;
  /** 左侧状态点，用于列表里快速扫读 */
  dot?: boolean;
  /** 徽章内左侧的图标元素 */
  icon?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

const TONE_STYLES: Record<BadgeTone, string> = {
  ok: "bg-state-ok-bg text-state-ok-fg border-state-ok-border",
  warn: "bg-state-warn-bg text-state-warn-fg border-state-warn-border",
  danger: "bg-state-danger-bg text-state-danger-fg border-state-danger-border",
  info: "bg-state-info-bg text-state-info-fg border-state-info-border",
  idle: "bg-state-idle-bg text-state-idle-fg border-state-idle-border"
};

/*
 * 服务商来源色 —— 与服务商页面的主色一致，让「这条数据来自哪」可扫读。
 * NOTE: 这里的键名刻意和 TabKey 的来源部分对齐（dnshe / cloudflare /
 * digitalplat / custom），调用处可以直接把 provider 字符串映射进来。
 */
const SOURCE_STYLES: Record<BadgeSource, string> = {
  dnshe: "bg-source-dnshe-bg text-source-dnshe-fg border-transparent",
  cloudflare: "bg-source-cf-bg text-source-cf-fg border-transparent",
  digitalplat: "bg-source-dp-bg text-source-dp-fg border-transparent",
  custom: "bg-source-custom-bg text-source-custom-fg border-transparent"
};

const SIZE_STYLES: Record<BadgeSize, string> = {
  sm: "text-[11px] px-2 py-0.5",
  md: "text-xs px-2.5 py-0.5"
};

/**
 * 把后端的 status 字符串映射为语义 tone。
 *
 * WHY 单独抽出来：三态文案（正常 / 待删除 / 已过期 / 未知）在域名卡片、
 * DP 列表、日志页出现了三套各自实现的判断，映射规则一旦调整容易改漏。
 * 统一到这里后，新增状态只需改这一个函数。
 */
export function statusTone(status: string): BadgeTone {
  const s = String(status || "").toLowerCase();
  if (s === "active" || s === "ok" || s === "正常" || s === "已解析") return "ok";
  if (s.includes("expire") || s.includes("过期") || s.includes("suspended")) return "danger";
  if (s.includes("delete") || s.includes("待删除") || s.includes("pending")) return "warn";
  if (s.includes("委派") || s.includes("delegate")) return "info";
  return "idle";
}

/**
 * 把到期剩余天数映射为语义 tone。
 * 阈值与后端的 renew_threshold_days 默认值（90）保持一致的语义分层：
 *   已过期 → danger；≤30 天 → warn；≤90 天 → info；其余 → ok
 */
export function expiryTone(remainingDays: number): BadgeTone {
  if (!Number.isFinite(remainingDays)) return "idle";
  if (remainingDays < 0) return "danger";
  if (remainingDays <= 30) return "warn";
  if (remainingDays <= 90) return "info";
  return "ok";
}

export function Badge(props: BadgeProps) {
  const {
    tone = "idle",
    source,
    size = "sm",
    dot = false,
    icon,
    className,
    children,
    ...rest
  } = props;

  return (
    <span
      className={cn(
        "ui-badge",
        SIZE_STYLES[size],
        source ? SOURCE_STYLES[source] : TONE_STYLES[tone],
        className
      )}
      {...rest}
    >
      {dot && <span className="ui-dot" aria-hidden="true" />}
      {icon}
      {children}
    </span>
  );
}
