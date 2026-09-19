import { useEffect, useRef, type KeyboardEvent } from "react";

/**
 * 容器内「可聚焦元素」的选择器。
 *
 * NOTE: 与 `components/Field.tsx` 里 `Modal` 基座**共用这一个常量**（Modal 从这里 import）——
 * 两边若出现差异，同一批弹窗在不同基座下会得到不同的 Tab 走位。
 * 但 `Modal` 的陷阱仍保留它自己的 `document` 级实现（那里还兼管 Esc、点遮罩关闭），
 * 并未改用本 hook；共用范围仅限这个常量。
 */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 取容器内当前可见、可聚焦的元素（顺序即 DOM 顺序，也就是 Tab 顺序） */
function listFocusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    // `display: none` 的元素拿不到 offsetParent，借此排除被隐藏的分支
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

/**
 * useFocusTrap —— 把键盘焦点关在一个容器里（对话框的「焦点陷阱」）
 *
 * 解决什么：弹窗打开后，Tab 能一路跑到背后的页面上 —— 键盘用户会「走出」弹窗，
 * 之后既看不到焦点在哪，也回不来（读屏用户更糟：仍在念背景内容）。
 *
 * ### 为什么挂在容器自身的 onKeyDown 上，而不是 document 级监听
 * 本项目唯一的复合下拉（`CustomSelect` / `ProviderPicker`）把面板 **portal 到 body**，
 * 也就是挂在弹窗容器**之外**的 DOM 里。若把陷阱挂到 document：
 * - 下拉面板里的一切按键都会先过一遍陷阱；
 * - 而这些组件有自己的键盘处理（↑↓ 高亮、Esc 收起、Tab 收起并放行），
 *   两套逻辑一旦同时生效就会互相打架，且**只在「弹窗内的下拉」这一种组合下复现**。
 *
 * 挂在容器上时，事件路径不经过容器外的 portal 节点 —— 陷阱天然只作用于弹窗内部，
 * 与下拉零耦合。副作用还有一个好处：同时挂载两个弹窗时，各自只处理自己子树里的
 * Tab（事件只会经过「真正含有焦点」的那一棵），不需要额外的层级栈。
 *
 * ### 刻意不做的事
 * - **不处理 Esc**：`ModalOverlay` 的既有语义是「只做遮罩与居中」，Esc 属于各弹窗
 *   自己的交互；在这里加会让「有没有 Esc」变成隐式行为。
 * - **不声明 `aria-modal="true"`**：声明之后辅助技术会把「对话框之外」视为惰性，
 *   而 portaled 的下拉面板正好在对话框之外 —— 会把读屏用户的下拉选项挡掉。
 *   想加它，前提是先把下拉面板移进对话框子树。
 *
 * ### 前提假设
 * 容器存在期间 = 弹窗打开。因此本 hook 不做 `enabled` 开关，而在挂载时接管、
 * 卸载时归还 —— 现有 11 个弹窗都是「关闭即 `return null`」卸载 `ModalOverlay`，
 * 满足该假设。
 */
export function useFocusTrap<T extends HTMLElement>() {
  const containerRef = useRef<T | null>(null);
  /** 打开前的焦点元素 —— 关闭后归还，否则焦点会掉回 <body>，键盘用户得重新 Tab 一遍 */
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    // 把初始焦点移进弹窗。
    // NOTE: 不少弹窗在输入框上写了 `autoFocus`，React 在 commit 阶段就已经调用过
    // focus() —— 那时本 effect 还没跑。所以要**先判断焦点是否已经在容器内**，
    // 已经在就什么都不做，否则会把它从预期的输入框抢到「关闭」按钮上。
    if (!root.contains(document.activeElement)) {
      const first = listFocusables(root)[0];
      // 无任何可聚焦元素时退化为聚焦容器本身（容器须可聚焦；ModalOverlay 未加
      // tabIndex，此时 focus() 是 no-op，不报错）。现存 11 个弹窗都有「关闭」按钮，
      // 不会走到这一支。
      (first ?? root).focus();
    }

    return () => {
      const prev = previouslyFocused.current;
      // 触发元素可能已随列表刷新被卸载（比如刚被删掉的那一行），此时不强求归还
      if (prev && prev.isConnected) prev.focus?.();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<T>) => {
    if (e.key !== "Tab") return;
    const root = containerRef.current;
    if (!root) return;
    const nodes = listFocusables(root);
    if (nodes.length === 0) return;

    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;

    // 只在两端回绕，中间一律交给浏览器（保持原生 Tab 顺序与 :focus-visible 行为）
    if (e.shiftKey) {
      if (active === first || active === root) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || active === root) {
      e.preventDefault();
      first.focus();
    }
  };

  return { containerRef, onKeyDown };
}
