import type { ReactNode } from "react";
import { cn } from "./cn";
import { useFocusTrap } from "./useFocusTrap";

/**
 * ModalOverlay —— 模态框的遮罩 + 居中容器（统一浮层基础设施）
 *
 * WHY 需要它：
 * 全站有十余个模态框各自手写同一行遮罩类名
 * `fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md`，
 * 带来两个问题：
 * 1) z-index 写死 50，与下拉浮层、Toast 同值，层序不可控 —— 弹窗里再开下拉、
 *    或弹窗与 Toast 同时出现时，谁压谁只能靠数值硬碰；
 * 2) 任何一处想调整遮罩浓度 / 模糊度 / 内距，都要逐个文件改，必然漏改。
 *
 * 收敛为一个组件后：遮罩走 --z-modal 令牌 —— 下拉面板用 calc(--z-modal + 10)
 * 稳定盖在弹窗之上、Toast 用 --z-toast 稳定盖在最上层，层序关系一目了然。
 *
 * NOTE: 本组件负责遮罩、居中，以及**焦点陷阱**（`useFocusTrap`）——
 * 十一个手写弹窗共用这一个外壳，陷阱放在这里等于一次性全部生效。
 *
 * 仍然刻意不做「点击遮罩关闭」与「Esc 关闭」：那是各弹窗自己的交互习惯
 * （存量弹窗大多没有），在这里加会改变既有行为（铁律 3：行为不变）。
 * 语义方面：`role="dialog"` + `aria-labelledby` 由各弹窗的面板自己声明
 * （`ModalOverlay` 拿不到标题）。**不声明 `aria-modal`**，原因见 `useFocusTrap` 的注释
 * （会把 portal 到 body 的下拉面板判为「对话框之外」而挡掉）。
 */
export function ModalOverlay({
  children,
  className,
}: {
  children: ReactNode;
  /** 额外类名（一般不需要；遮罩外观由令牌统一） */
  className?: string;
}) {
  // 陷阱挂在遮罩这层容器上：事件只会从弹窗内部冒泡到这里，
  // 因此不会干扰 portal 到 body 的下拉面板（详见 useFocusTrap 注释）。
  const { containerRef, onKeyDown } = useFocusTrap<HTMLDivElement>();

  return (
    <div
      ref={containerRef}
      onKeyDown={onKeyDown}
      className={cn(
        "fixed inset-0 z-modal flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md",
        className
      )}
    >
      {children}
    </div>
  );
}

export default ModalOverlay;
