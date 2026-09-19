import React from "react";
import { cn } from "../cn";

/**
 * Input —— 受控文本输入框
 *
 * WHY 需要它：
 * 全站有 100+ 处 `<input className="form-input px-3 py-2.5 rounded-lg text-sm
 * text-content-secondary …">`，`form-input` 皮肤 + 尺寸 + 文本色 + placeholder
 * 色的组合在文件里反复出现。方案（§六 5.1）要求把这类重复收敛成组件，否则
 * 「改一次输入框内距」要在几十个文件里搜索替换。
 *
 * 设计约定（与 CustomSelect 一致，保证与存量 <input> 布局等价）：
 * - **宽度由调用处决定**：本组件不自带 w-full，调用处写 className="w-full …"，
 *   这样在 flex 行里放 `flex-1 min-w-0` 的场景不会因为组件强行撑满而漂移。
 * - 走 `.form-input` 皮肤（背景、边框、文字色、焦点环都在 index.css 里，随主题变）。
 *   NOTE: 本组件**不**内置文字色与 placeholder 色 —— `.form-input` 已把 color 设为
 *   --text-primary，存量里部分调用处追加 text-content-secondary 覆盖、部分不加。
 *   若组件强行注入某个默认色，会让「不加色的那些」静默改变观感。因此颜色由调用处
 *   继续用 className 表达（text-content-secondary / text-content-primary /
 *   placeholder:text-content-muted），迁移时逐字保留、零视觉漂移。
 * - size 只调「内距 + 字号 + 圆角」，三档与存量手写串对齐：
 *     sm → px-3 py-2   rounded-lg text-sm（密集表单、弹窗）
 *     md → px-3 py-2.5 rounded-lg text-sm（全站默认）
 *     lg → px-3.5 py-2.5 rounded-lg text-sm（登录/主表单，内距略大）
 * - mono 打开等宽字体（API Key / 域名等）。
 * - invalid 时加 danger 描边 + aria-invalid，配合 Field 的错误提示使用。
 *
 * NOTE: 这里刻意不接管 value/onChange 的受控模式 —— 直接透传原生 props，
 * 与替换前的 <input> 行为完全一致（含 type / inputMode / maxLength 等）。
 */

export type InputSize = "sm" | "md" | "lg";

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "className"> {
  size?: InputSize;
  /** 等宽字体（API Key、域名、密码原文等） */
  mono?: boolean;
  /** 校验失败态：danger 描边 + aria-invalid */
  invalid?: boolean;
  className?: string;
}

const SIZE_STYLES: Record<InputSize, string> = {
  sm: "px-3 py-2 rounded-lg text-sm",
  md: "px-3 py-2.5 rounded-lg text-sm",
  lg: "px-3.5 py-2.5 rounded-lg text-sm"
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(props, ref) {
  const { size = "md", mono = false, invalid = false, className, ...rest } = props;

  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "form-input",
        SIZE_STYLES[size],
        mono && "font-mono",
        invalid && "border-state-danger-border",
        className
      )}
      {...rest}
    />
  );
});
