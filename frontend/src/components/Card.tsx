import React from "react";
import { cn } from "./cn";

/**
 * Card —— 统一容器
 *
 * WHY 需要它：
 * 存量代码里卡片容器的手写串高度重复，且圆角档位不统一
 * （rounded-lg / rounded-xl / rounded-2xl 混用，没有规则可循）。
 * 这里把「表面 + 边框 + 圆角 + 阴影」四件事聚合为组件，
 * 并把圆角统一到 radius 令牌，全站换风格只改 index.css。
 *
 * elevation 三档语义：
 *   flat    无阴影，纯描边。用于「卡片里的卡片」等嵌套场景，避免阴影叠阴影
 *   default 默认档，轻微阴影。用于页面主体的信息容器
 *   raised  悬浮档。用于可点击的卡片（点击时下沉，给按下反馈）
 */

export type CardElevation = "flat" | "default" | "raised";
export type CardPadding = "none" | "sm" | "md" | "lg";

export interface CardProps extends React.HTMLAttributes<HTMLElement> {
  elevation?: CardElevation;
  padding?: CardPadding;
  /** 渲染为可聚焦的交互容器：自动补 role/tabIndex 与键盘触发 */
  interactive?: boolean;
  as?: "div" | "section" | "article" | "li";
  className?: string;
  children?: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLElement>;
}

const PADDING_STYLES: Record<CardPadding, string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-5 sm:p-6"
};

const ELEVATION_STYLES: Record<CardElevation, string> = {
  flat: "ui-card--flat",
  default: "ui-card--default",
  raised: "ui-card--raised"
};

export const Card = React.forwardRef<HTMLElement, CardProps>(function Card(props, ref) {
  const {
    elevation = "default",
    padding = "md",
    interactive = false,
    as: Tag = "div",
    className,
    children,
    onClick,
    ...rest
  } = props;

  /*
   * NOTE: 可点击的 div 对键盘用户是完全不可达的 —— 无法 Tab 聚焦，
   * 回车/空格也不会触发 onClick。这里在 interactive 模式下补齐
   * role="button" + tabIndex=0 + 键盘处理，让鼠标与键盘行为一致。
   * 若调用方已有更合适的语义（如包了一层 <a>），不要开启 interactive。
   */
  const keyboardProps = interactive
    ? {
        role: "button" as const,
        tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick?.(e as unknown as React.MouseEvent<HTMLElement>);
          }
        }
      }
    : {};

  return (
    <Tag
      ref={ref as never}
      onClick={onClick}
      className={cn(
        "ui-card",
        ELEVATION_STYLES[elevation],
        PADDING_STYLES[padding],
        interactive && "cursor-pointer",
        className
      )}
      {...keyboardProps}
      {...rest}
    >
      {children}
    </Tag>
  );
});

/* ── Card 的复合子组件 ────────────────────────────────────────────
 * 头部 / 底部带统一的内边距与分隔线，避免调用处每次都写
 * "px-4 py-3 border-b border-border-base flex items-center justify-between"
 */

export interface CardSectionProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
  children?: React.ReactNode;
}

export function CardHeader({ className, children, ...rest }: CardSectionProps) {
  return (
    <div
      className={cn(
        "px-4 py-3 flex items-center justify-between gap-3",
        "border-b border-border-base bg-elevated",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardFooter({ className, children, ...rest }: CardSectionProps) {
  return (
    <div
      className={cn(
        "px-4 py-3 flex items-center justify-between gap-3",
        "border-t border-border-base bg-elevated",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardBody({ className, children, ...rest }: CardSectionProps) {
  return (
    <div className={cn("px-4 py-4", className)} {...rest}>
      {children}
    </div>
  );
}

/**
 * Skeleton —— 加载占位
 *
 * WHY：域名列表一定会在 1-3 秒内加载完，期间给骨架屏而非 spinner。
 * 骨架屏保留了内容将要出现的位置与形状，感知等待更短，且能避免
 * 数据到达时内容突然撑开导致的布局跳动（CLS）。
 *
 * variant 对应常见形状，避免调用处各自调尺寸：
 *   text   单行文本（默认一行高度）
 *   title  标题行，略高
 *   block  矩形块，用于图表/卡片占位
 *   circle 圆形，用于头像
 */
export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "text" | "title" | "block" | "circle";
  width?: string | number;
  height?: string | number;
  /** 渲染 N 行文本骨架，行间距 8px */
  lines?: number;
  className?: string;
}

export function Skeleton(props: SkeletonProps) {
  const { variant = "text", width, height, lines = 1, className, style, ...rest } = props;

  const variantClass =
    variant === "title"
      ? "h-4"
      : variant === "block"
        ? "h-20 rounded-md"
        : variant === "circle"
          ? "h-10 w-10 rounded-full"
          : "h-3.5";

  // 多行文本：最后一行短一截，模拟真实段落收尾，比等长更像内容
  if (variant === "text" && lines > 1) {
    return (
      <div className={cn("flex flex-col gap-2", className)} aria-hidden="true" {...rest}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={cn("skeleton", variantClass)}
            style={{ width: i === lines - 1 ? "60%" : "100%" }}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn("skeleton", variantClass, className)}
      style={{ width, height, ...style }}
      aria-hidden="true"
      {...rest}
    />
  );
}
