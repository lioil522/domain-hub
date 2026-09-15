/**
 * Domain Hub 设计系统 · 组件出口
 *
 * 统一从此处导入，避免调用处散落多个相对路径：
 *   import { Button, Badge, Card, Field } from "../components";
 *
 * 设计约定（新增组件前请先读这里）：
 * 1. 颜色只用语义令牌：bg-surface / text-content-* / state-* / source-*
 *    不要在组件里写 emerald-500 / red-950 这类具体色阶 —— 它们在明暗主题下
 *    表现不一致，且换皮时要全量替换。
 * 2. 圆角只用 radius 令牌（rounded-sm/md/lg/xl），不要写 rounded-[10px]。
 * 3. 动效只用 duration-fast/base/slow + ease-out/spring。
 * 4. 交互元素三态齐全：hover / focus-visible / disabled。
 *    focus-visible 由 index.css 全局兜底，组件内不重复定义。
 * 5. 图标按钮必须给 aria-label 或 title。
 */

export { Button } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./Button";

export { Badge, statusTone, expiryTone } from "./Badge";
export type { BadgeProps, BadgeTone, BadgeSource, BadgeSize } from "./Badge";

export { Card, CardHeader, CardFooter, CardBody, Skeleton } from "./Card";
export type {
  CardProps,
  CardElevation,
  CardPadding,
  CardSectionProps,
  SkeletonProps
} from "./Card";

export { Field, Modal } from "./Field";
export type { FieldProps, ModalProps } from "./Field";

export { NavItem, NavSubItem } from "./NavItem";
export type { NavItemProps, NavSubItemProps, NavSource } from "./NavItem";

export { ThemePicker } from "./ThemePicker";
export type { ThemePickerProps } from "./ThemePicker";

export { DomainTimeline } from "./DomainTimeline";
export type {
  DomainTimelineProps,
  TimelineBucket,
  TimelineBucketItem
} from "./DomainTimeline";

export { cn } from "./cn";
