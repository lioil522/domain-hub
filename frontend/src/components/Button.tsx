import React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "./cn";

/**
 * Button —— 全站统一按钮
 *
 * WHY 需要它：
 * 存量 App.tsx 里同一个「删除」按钮的样式串（`hover:bg-red-50 text-red-600
 * dark:hover:bg-red-950/40 dark:text-red-400`）在文件里出现了多次，一旦调整
 * 视觉就要全文件搜索替换。本组件把这些组合固化为 variant，调用处只描述意图。
 *
 * 设计约定：
 * - variant 描述「重要性」而非「颜色」，颜色由语义决定 → 换皮不动调用处
 * - 六个 variant 覆盖全站现有按钮类型，没有新增视觉语言
 * - loading 态自动禁用点击并保留原有宽度（图标位置占位），避免点击后布局跳动
 */

export type ButtonVariant =
  | "primary"   // 主操作：保存、确认、登录（品牌渐变）
  | "secondary" // 次操作：取消、返回（描边中性）
  | "ghost"     // 弱操作：工具栏图标按钮、行内链接
  | "danger"    // 破坏性：删除、解绑
  | "warn"      // 需谨慎：恢复自动查询、重置
  | "success";  // 正向确认：启用、通过

export type ButtonSize = "xs" | "sm" | "md" | "lg";

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 左侧图标。传入 JSX 元素，如 <Plus className="w-4 h-4" /> */
  icon?: React.ReactNode;
  /** 右侧图标。用于「前往 ↗」这类指向性操作 */
  trailingIcon?: React.ReactNode;
  /** 图标按钮模式：方形、无内边距扩张，用于工具栏。此时不渲染 children */
  iconOnly?: boolean;
  /** 加载中：显示旋转图标并禁用交互 */
  loading?: boolean;
  /** 占满容器宽度 */
  block?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/* ── 变体样式表 ──────────────────────────────────────────────────
 * NOTE: 每个变体都必须显式写出 hover / active / disabled 三态。
 * 特别地，danger / warn 的中性态不能用 text-red-600 这类硬编码 ——
 * 它们走 state-* 语义令牌，暗色主题下自动换成亮色前景，不会出现
 * 「暗底深红字」这种对比度不足的组合。
 *
 * NOTE: primary 的底色走 .bg-accent-gradient（index.css 组件层），
 * 不再写 from-indigo-500 这类色阶名 —— 那是把主题焊死在调用点，
 * 换主题时要全量搜索替换。辉光用 shadow-accent，它内部是
 * rgb(var(--accent-rgb) / …)，自动跟随主题色。
 */
const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary: cn(
    "font-semibold",
    "bg-accent-gradient",
    "hover:shadow-accent",
    "active:shadow-none active:brightness-95",
    "disabled:shadow-none"
  ),
  secondary: cn(
    "font-semibold bg-elevated text-content-secondary border border-border-base",
    "hover:bg-hovered hover:text-content-primary hover:border-border-base",
    "active:bg-hovered"
  ),
  ghost: cn(
    "font-medium bg-transparent text-content-secondary",
    "hover:bg-hovered hover:text-content-primary",
    "active:bg-hovered"
  ),
  danger: cn(
    "font-semibold bg-state-danger-bg text-state-danger-fg border border-state-danger-border",
    "hover:brightness-[0.97] dark:hover:brightness-125",
    "active:brightness-95 dark:active:brightness-110"
  ),
  warn: cn(
    "font-semibold bg-state-warn-bg text-state-warn-fg border border-state-warn-border",
    "hover:brightness-[0.97] dark:hover:brightness-125",
    "active:brightness-95 dark:active:brightness-110"
  ),
  success: cn(
    "font-semibold bg-state-ok-bg text-state-ok-fg border border-state-ok-border",
    "hover:brightness-[0.97] dark:hover:brightness-125",
    "active:brightness-95 dark:active:brightness-110"
  )
};

/* ── 尺寸样式表 ──────────────────────────────────────────────────
 * 三档字号 + 三档高度，均落在 4px 栅格上：
 *   xs → 28px 高 / 12px 字（密集表格行内）
 *   sm → 34px 高 / 12px 字（卡片操作区，全站默认）
 *   md → 38px 高 / 14px 字（表单页主操作）
 *   lg → 44px 高 / 14px 字（登录页、空状态主按钮，同时满足触控 44px）
 */
const SIZE_STYLES: Record<ButtonSize, string> = {
  xs: "text-xs px-2.5 h-7 gap-1",
  sm: "text-xs px-3.5 h-[34px] gap-1.5",
  md: "text-sm px-4 h-[38px] gap-2",
  lg: "text-sm px-5 h-11 gap-2"
};

const ICON_ONLY_SIZE_STYLES: Record<ButtonSize, string> = {
  xs: "w-7 h-7",
  sm: "w-[34px] h-[34px]",
  md: "w-[38px] h-[38px]",
  lg: "w-11 h-11"
};

const SPINNER_SIZE: Record<ButtonSize, string> = {
  xs: "w-3 h-3",
  sm: "w-3.5 h-3.5",
  md: "w-4 h-4",
  lg: "w-4 h-4"
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(props, ref) {
    const {
      variant = "secondary",
      size = "sm",
      icon,
      trailingIcon,
      iconOnly = false,
      loading = false,
      block = false,
      className,
      children,
      disabled,
      type = "button",
      ...rest
    } = props;

    // 图标按钮必须有可访问名称，否则读屏软件只念出「按钮」。
    // 调用方应传 title 或 aria-label；这里在 dev 下提示，不阻断运行。
    const hasAccessibleName = iconOnly
      ? Boolean(rest["aria-label"] || rest.title)
      : true;

    // NOTE: 用 hostname 判断开发环境而非 import.meta.env.DEV —— 这个项目
    // 未引入 vite/client 类型声明（tsconfig 的 types 未包含），访问
    // import.meta.env 会直接报 TS2339。改判 hostname 既不需要新增类型依赖，
    // 也与 Vite 开发服务器的默认地址一致；生产域名下这段提示不会触发。
    if (!hasAccessibleName) {
      const isDevHost =
        typeof window !== "undefined" &&
        (window.location.hostname === "localhost" ||
          window.location.hostname === "127.0.0.1");
      if (isDevHost) {
        console.warn("[Button] iconOnly 模式需要 aria-label 或 title 以提供可访问名称");
      }
    }

    const isDisabled = disabled || loading;

    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        className={cn(
          // 基础：flex 居中 + 圆角 + 动效 + 禁止选中
          "inline-flex items-center justify-center select-none whitespace-nowrap",
          "rounded-md transition-all duration-fast ease-out",
          // 禁用态统一处理：降低不透明度 + 禁止指针。
          // 不隐藏元素，保留布局占位，避免禁用时周围元素跳动。
          "disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none",
          // 焦点态由 index.css 的全局 :focus-visible 兜底，此处不重复定义
          VARIANT_STYLES[variant],
          iconOnly ? ICON_ONLY_SIZE_STYLES[size] : SIZE_STYLES[size],
          block && "w-full",
          className
        )}
        {...rest}
      >
        {loading ? (
          <Loader2 className={cn(SPINNER_SIZE[size], "animate-spin flex-shrink-0")} aria-hidden="true" />
        ) : (
          icon
        )}
        {!iconOnly && children}
        {!iconOnly && trailingIcon}
      </button>
    );
  }
);
