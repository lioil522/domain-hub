import React from "react";
import { cn } from "../cn";

/**
 * Textarea —— 受控多行文本输入
 *
 * WHY 需要它：与 Input 同源。存量里批量导入 / 备注等文本框反复手写
 * `form-input px-3 py-2.5 rounded-lg text-sm resize-none …`（见 BindBatchForm、
 * WordBankModal、DpNameserverModal）。收敛为组件后皮肤与状态一处维护。
 *
 * 约定与 Input 一致：
 * - 宽度/高度由调用处 className 决定（不自带 w-full）。
 * - 默认 `resize-none`（存量批量文本框都是固定高度 + 内部滚动）；需要拖拽
 *   调整大小的场景传 `resizable`。
 * - 走 `.form-input` 皮肤，随主题变；mono / invalid 语义同 Input。
 * - 与 Input 相同，**不内置文字色/placeholder 色**，由调用处 className 表达，
 *   迁移时逐字保留、零视觉漂移。
 */

export type TextareaSize = "sm" | "md";

export interface TextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> {
  size?: TextareaSize;
  /** 等宽字体（批量粘贴的行式文本） */
  mono?: boolean;
  /** 校验失败态 */
  invalid?: boolean;
  /** 允许用户拖拽调整大小（默认禁止，与存量批量文本框一致） */
  resizable?: boolean;
  className?: string;
}

const SIZE_STYLES: Record<TextareaSize, string> = {
  sm: "px-3 py-2 rounded-lg text-sm",
  md: "px-3 py-2.5 rounded-lg text-sm"
};

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(props, ref) {
    const { size = "md", mono = false, invalid = false, resizable = false, className, ...rest } = props;

    return (
      <textarea
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          "form-input",
          SIZE_STYLES[size],
          mono && "font-mono",
          resizable ? "resize-y" : "resize-none",
          invalid && "border-state-danger-border",
          className
        )}
        {...rest}
      />
    );
  }
);
