import React, { useCallback, useEffect, useId, useRef, useState } from "react";

/**
 * useListbox —— 自定义下拉（listbox 模式）的共享交互内核
 *
 * WHY 需要它：
 * 项目里有两条各自实现的 listbox —— `form/CustomSelect`（portal 浮层）与
 * `ProviderPicker`（内联展开）。两者把同一套 WAI-ARIA 交互（开合、键盘导航、
 * 点击外部关闭、高亮滚动入视野、焦点归还）各写了一遍。方案（§三 2.2）明确警告：
 * 不要让 Select 再复制一份 ProviderPicker 的逻辑，否则两个下拉会再次分叉。
 * 因此把**纯交互**抽到这里，两个组件只保留各自的「长什么样 / 怎么定位」。
 *
 * 边界：本 hook 不含任何 DOM 结构与样式 —— 触发器/面板的渲染、portal、定位、
 * 内联展开全部由调用方决定。它只负责「状态 + 键盘 + 外部点击 + 焦点」。
 *
 * 行为差异通过参数表达（逐字保留原实现，不做统一）：
 *   · stopEscapePropagation —— 弹窗内的下拉置 true，避免 Esc 顺手关掉外层弹窗；
 *     ProviderPicker 内联展开、无此顾虑，置 false（与原实现一致）。
 *   · onBeforeOpen —— CustomSelect 用它计算 portal 坐标；ProviderPicker 不传。
 *   · insideRefs —— 命中即视为「内部点击、不关闭」。触发器 ref 由本 hook 自带，
 *     这里只需补面板 ref（CustomSelect 的 portal 面板）或包裹 ref（ProviderPicker）。
 */

export interface UseListboxOptions {
  /** 选项 value 列表（顺序即渲染顺序），键盘 Enter 用它提交高亮项 */
  optionValues: string[];
  /** 当前选中项下标（-1 表示无匹配） */
  selectedIndex: number;
  /** 选中项变更回调 */
  onChange: (value: string) => void;
  /** 禁用时忽略全部键盘交互 */
  disabled?: boolean;
  /** 打开面板前的副作用（CustomSelect 用它实测并写入 portal 定位坐标） */
  onBeforeOpen?: () => void;
  /**
   * 「内部点击」判定用的额外 refs。触发器 ref 由本 hook 自带，
   * 这里只需补面板/包裹层 ref；任一命中即不关闭。
   */
  insideRefs?: Array<React.RefObject<HTMLElement | null>>;
  /** Esc 是否阻止冒泡（弹窗内嵌下拉必须 true，避免误关外层弹窗） */
  stopEscapePropagation?: boolean;
  /** 外部键盘回调，先于内建处理；若其 preventDefault 则跳过内建（行内编辑场景） */
  onKeyDown?: (e: React.KeyboardEvent) => void;
  /**
   * 外部持有的触发器 ref。传入后本 hook 复用它，调用方可在 hook 调用前就
   * 引用它（如 CustomSelect 的定位函数需要读触发器几何）。
   */
  triggerRef?: React.RefObject<HTMLButtonElement>;
}

export interface UseListboxResult {
  open: boolean;
  activeIndex: number;
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  listId: string;
  triggerRef: React.RefObject<HTMLButtonElement>;
  /** 打开面板（先跑 onBeforeOpen） */
  openPanel: () => void;
  /** 关闭面板；returnFocus=true 时把焦点还给触发器 */
  close: (returnFocus?: boolean) => void;
  /** 触发器点击：开↔关切换 */
  toggle: () => void;
  /** 提交某个值：onChange + 关闭 + 焦点归还 */
  commitValue: (value: string) => void;
  /** 键盘处理器，挂在触发器（或包裹层）上 */
  handleKeyDown: (e: React.KeyboardEvent) => void;
  /** 第 i 个选项的 DOM id（供 aria-activedescendant / 滚动定位） */
  optionId: (i: number) => string;
}

export function useListbox(opts: UseListboxOptions): UseListboxResult {
  const {
    optionValues,
    selectedIndex,
    onChange,
    disabled = false,
    onBeforeOpen,
    insideRefs,
    stopEscapePropagation = false,
    onKeyDown,
    triggerRef: externalTriggerRef
  } = opts;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const internalTriggerRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = externalTriggerRef ?? internalTriggerRef;
  const listId = useId();

  const optionId = useCallback((i: number) => `${listId}-opt-${i}`, [listId]);

  /* 打开时把高亮定位到当前选中项，避免每次都从第一项开始按方向键 */
  useEffect(() => {
    if (open) setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, selectedIndex]);

  /* 高亮项滚动入视野（选项超过面板高度时才需要） */
  useEffect(() => {
    if (!open) return;
    const el = document.getElementById(`${listId}-opt-${activeIndex}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, listId]);

  const openPanel = useCallback(() => {
    onBeforeOpen?.();
    setOpen(true);
  }, [onBeforeOpen]);

  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const toggle = useCallback(() => {
    if (open) setOpen(false);
    else openPanel();
  }, [open, openPanel]);

  const commitValue = useCallback(
    (value: string) => {
      onChange(value);
      setOpen(false);
      // 关掉后把焦点还给触发器 —— 否则焦点落在被卸载的列表项上，会跳回 body，
      // 键盘用户就"失联"了
      triggerRef.current?.focus();
    },
    [onChange]
  );

  /* 点击组件外部任意位置关闭。
     NOTE: 用 mousedown 而非 click —— click 在「按下时在组件内、松开时在外部」
     的拖拽场景下会漏判；mousedown 与视觉预期一致。
     insideRefs 里的 ref 对象在生命周期内稳定，故只依赖 open 重订阅。 */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (insideRefs?.some((r) => r.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled) return;

      /*
       * 先让调用处的键盘回调处理（行内编辑场景：Enter 提交该行、Esc 退出编辑）。
       * 若其调用了 preventDefault，则本内核不再介入 —— 这样在 DnsLineSelect 这类
       * 行内编辑用法下，Enter/Esc 的语义与替换前的原生 <select> 完全一致。
       */
      onKeyDown?.(e);
      if (e.defaultPrevented) return;

      if (!open) {
        if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          openPanel();
        }
        return;
      }

      switch (e.key) {
        case "Escape":
          e.preventDefault();
          // 弹窗内嵌下拉：只吃掉 Esc 的冒泡，别让它顺手把外层弹窗一起关了
          if (stopEscapePropagation) e.stopPropagation();
          close(true);
          break;
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => (i + 1) % optionValues.length);
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => (i - 1 + optionValues.length) % optionValues.length);
          break;
        case "Home":
          e.preventDefault();
          setActiveIndex(0);
          break;
        case "End":
          e.preventDefault();
          setActiveIndex(optionValues.length - 1);
          break;
        case "Enter":
        case " ": {
          e.preventDefault();
          const v = optionValues[activeIndex];
          if (v !== undefined) commitValue(v);
          break;
        }
        case "Tab":
          // 允许 Tab 离开：先收起面板，浏览器继续处理正常的焦点转移
          setOpen(false);
          break;
        default:
          break;
      }
    },
    [
      disabled,
      onKeyDown,
      open,
      openPanel,
      stopEscapePropagation,
      close,
      optionValues,
      activeIndex,
      commitValue
    ]
  );

  return {
    open,
    activeIndex,
    setActiveIndex,
    listId,
    triggerRef,
    openPanel,
    close,
    toggle,
    commitValue,
    handleKeyDown,
    optionId
  };
}
