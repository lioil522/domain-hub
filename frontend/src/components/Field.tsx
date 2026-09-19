import React, { useId } from "react";
import { AlertCircle, Info } from "lucide-react";
import { cn } from "./cn";
import { FOCUSABLE_SELECTOR } from "./useFocusTrap";

/**
 * Field —— 表单字段容器
 *
 * WHY 需要它：
 * 存量表单把 <label>、说明文字、错误提示各自手写，导致三个实际问题：
 * 1) label 与输入框没有 id 关联（htmlFor 缺失），点 label 无法聚焦输入框，
 *    读屏软件也读不出「这个框叫什么」；
 * 2) 错误提示只是视觉上的红字，没有 aria-describedby 接线，读屏用户
 *    完全听不到校验失败；
 * 3) 必填只靠「*」符号表示，没有 aria-required，辅助技术无从得知。
 *
 * 本组件把上述三件事做成默认行为：只要用 Field 包住输入框，
 * id 关联、描述接线、必填语义全部自动完成，调用处不需要记这些细节。
 *
 * 用法：
 *   <Field label="账号别名" required hint="用于在列表中区分账号" error={err}>
 *     <input className="form-input ..." value={v} onChange={...} />
 *   </Field>
 *
 * NOTE: 输入框自身仍需调用方写（因为类型差异太大：input / select / textarea /
 * 自定义 DateField），Field 只负责「外层的语义与排版」，通过 cloneElement
 * 把 id / aria-describedby / aria-invalid / aria-required 注入到子元素上。
 */

export interface FieldProps {
  label?: string;
  /** 字段说明，常驻显示在输入框下方 */
  hint?: string;
  /** 校验错误。有值时替换 hint 显示，并标记 aria-invalid */
  error?: string | null;
  /** 成功提示 */
  success?: string | null;
  required?: boolean;
  /** 视觉上隐藏 label 但保留给读屏（用于已经有明显上下文的位置） */
  hideLabel?: boolean;
  /** 覆盖自动生成的控件 id（一般不需要） */
  htmlFor?: string;
  className?: string;
  /** 应为单个表单控件元素 */
  children: React.ReactElement;
}

export function Field(props: FieldProps) {
  const {
    label,
    hint,
    error,
    success,
    required = false,
    hideLabel = false,
    htmlFor,
    className,
    children
  } = props;

  const generatedId = useId();
  const controlId = htmlFor || `field-${generatedId}`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;

  // 描述接线：错误优先于 hint（两者同时存在时读屏只念更紧急的那条）
  const describedBy = error ? errorId : hint ? hintId : undefined;

  /*
   * NOTE: 用 cloneElement 注入而非包一层 div —— 包 div 会破坏
   * 调用处的 flex/grid 布局（输入框旁常有并列的按钮）。
   * 这里只改属性、不动 DOM 结构，调用处完全无感知。
   */
  const control = React.cloneElement(children, {
    id: children.props.id || controlId,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined,
    "aria-required": required || undefined
  } as Record<string, unknown>);

  return (
    <div className={cn("flex flex-col", className)}>
      {label && (
        <label
          htmlFor={controlId}
          className={cn(
            "block text-xs font-semibold text-content-secondary mb-1.5",
            hideLabel && "sr-only"
          )}
        >
          {label}
          {required && (
            <span className="text-state-danger-fg ml-0.5" aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}

      {control}

      {error ? (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1.5 text-[11px] text-state-danger-fg mt-1.5 leading-snug"
        >
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-px" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : success ? (
        <p className="flex items-start gap-1.5 text-[11px] text-state-ok-fg mt-1.5 leading-snug">
          <Info className="w-3.5 h-3.5 flex-shrink-0 mt-px" aria-hidden="true" />
          <span>{success}</span>
        </p>
      ) : hint ? (
        <p id={hintId} className="text-[11px] text-content-muted mt-1.5 leading-snug">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Modal —— 无障碍弹窗容器
 *
 * WHY 需要它：
 * 存量弹窗（CF 到期编辑、DP NS 修改等）是直接铺一个 fixed 遮罩 + 内容块，
 * 存在三个可访问性问题：
 * 1) 没有 role="dialog" + aria-modal，读屏不知道进入了弹层，仍会念背景内容；
 * 2) Esc 无法关闭（用户肌肉记忆会按 Esc）；
 * 3) 焦点不进入弹窗，Tab 会跑到背后的页面上 —— 键盘用户可以「跑出」弹窗。
 *
 * 本组件处理这三件事，并保留调用处原有的视觉（它只加行为与语义、不换皮）。
 */

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** 弹窗标题，同时作为 aria-labelledby 的来源 */
  title: string;
  /** 无障碍描述，可选。用于需要额外解释的弹窗 */
  description?: string;
  /** 弹窗主体 */
  children: React.ReactNode;
  /** 底部操作区 */
  footer?: React.ReactNode;
  /** 最大宽度 class，默认 max-w-2xl */
  maxWidthClass?: string;
}

export function Modal(props: ModalProps) {
  const {
    open,
    onClose,
    title,
    description,
    children,
    footer,
    maxWidthClass = "max-w-2xl"
  } = props;

  const titleId = useId();
  const descId = useId();
  const panelRef = React.useRef<HTMLDivElement>(null);
  // 记录打开前的焦点元素，关闭后归还 —— 否则焦点会掉回 <body>，
  // 键盘用户要重新 Tab 一遍才能回到原来的位置
  const previouslyFocused = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    // 焦点移入弹窗第一个可聚焦元素（或面板本身）
    const panel = panelRef.current;
    if (panel) {
      const focusable = panel.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      (focusable || panel).focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      // 焦点陷阱：Tab 到边界时回绕，保证焦点不逃出弹窗
      if (e.key === "Tab" && panel) {
        const nodes = Array.from(
          panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
        ).filter((el) => el.offsetParent !== null);
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md"
      role="presentation"
    >
      {/* 点击遮罩关闭 —— 保留原有交互习惯 */}
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          "relative bg-surface border border-border-base w-full max-h-[90dvh]",
          "rounded-xl overflow-hidden flex flex-col shadow-lg outline-none",
          maxWidthClass
        )}
      >
        <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between gap-2 border-b border-border-base flex-shrink-0">
          <div className="min-w-0">
            <h3 id={titleId} className="text-base sm:text-lg font-bold text-content-primary">
              {title}
            </h3>
            {description && (
              <p id={descId} className="text-xs text-content-muted mt-0.5">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭弹窗"
            className="touch-target flex-shrink-0 p-2 rounded-md text-content-muted hover:text-content-primary hover:bg-hovered transition-colors"
          >
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto flex-1">{children}</div>

        {footer && (
          <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between gap-3 border-t border-border-base flex-shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
