import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "../cn";
import { useListbox } from "./useListbox";

export interface CustomSelectOption {
  value: string;
  label: string;
}

export interface CustomSelectProps {
  /** 当前选中的值 */
  value: string;
  /** 选项变更回调（直接回传 value，不再走事件对象） */
  onChange: (value: string) => void;
  /** 选项列表 */
  options: CustomSelectOption[];
  /** 占位符文本（无匹配项时展示） */
  placeholder?: string;
  /** 触发器样式类：宽度/内距/字号/颜色等（逐字保留调用处原值） */
  className?: string;
  /** 是否禁用 */
  disabled?: boolean;
  /** 点击触发器的附加回调（保留给「点击即刷新」之类的外部钩子） */
  onClick?: () => void;
  /** 触发器的可访问名称（无可见 label 时必填） */
  ariaLabel?: string;
  /** 触发器 title 提示（原 DnsLineSelect 用它解释「为何禁用」） */
  title?: string;
  /** 触发器 id（供 <Field> 的 htmlFor 关联 label 使用） */
  id?: string;
  /** 透传到触发器的键盘回调（保留 DnsLineSelect 的 Esc 退出行内编辑行为） */
  onKeyDown?: (e: React.KeyboardEvent) => void;
  /**
   * 是否去掉默认的 `form-input` 外观。
   * 默认 false —— 组件自带 form-input，调用处只需补充宽度与内距。
   * 少数使用「非 form-input 皮肤」的场景（如扫描页注册表单用 bg-elevated +
   * border-border-base 自绘输入框）置为 true，由 className 完全接管外观。
   */
  bare?: boolean;
  /** 下拉面板最大高度（px），超出则滚动。默认 240 */
  maxPanelHeight?: number;
}

/**
 * CustomSelect —— 现代风格自定义下拉选择
 *
 * WHY 需要它：
 * 项目里大量使用原生 <select>，但它有两个无法回避的问题：
 * 1) **外观由浏览器/操作系统决定**，在暗色主题与液态玻璃主题下与周围控件完全脱节
 *    （Windows 上展开的是灰色系统菜单，和设计系统毫无关系）；
 * 2) **无法统一交互细节**（圆角、hover、选中勾、键盘高亮都不受控）。
 *
 * 本组件按 WAI-ARIA listbox 模式实现，替换原生 select 的同时补齐无障碍：
 *   · 触发器 aria-haspopup="listbox" / aria-expanded / aria-controls；
 *   · 面板 role="listbox"，选项 role="option" + aria-selected；
 *   · 键盘：Enter/Space/↓/↑ 打开，↑↓ 移动高亮，Home/End 首尾，Enter/Space 选中，
 *     Esc 关闭并把焦点还给触发器，Tab 正常离开（先收起面板）。
 *
 * 布局：触发器本身即根元素（不再套一层 div），因此调用处写在 className 上的
 * 宽度 / flex 布局类与替换前的原生 <select> 完全等价 —— 不会出现「外层 div 撑满、
 * 内层控件变窄」之类的布局漂移。
 *
 * 浮层：下拉面板通过 createPortal 挂到 document.body，并以 position:fixed 定位。
 * WHY 必须 portal：弹窗的遮罩层带 backdrop-blur（backdrop-filter），而 backdrop-filter
 * 会为后代建立「包含块」，使 fixed 面板相对遮罩定位并被弹窗的 overflow 裁剪 ——
 * 表现就是「弹窗里的下拉只能看见前几项」。挂到 body 后彻底脱离弹窗，不受任何
 * 祖先 filter/transform/overflow 影响。
 */
export function CustomSelect({
  value,
  onChange,
  options,
  placeholder = "请选择...",
  className = "",
  disabled = false,
  onClick,
  ariaLabel,
  title,
  id,
  onKeyDown,
  bare = false,
  maxPanelHeight = 240,
}: CustomSelectProps) {
  /** 面板固定定位坐标（开面板那一刻实测；滚动/缩放会失效 → 直接收起） */
  const [panelPos, setPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selectedIndex = options.findIndex((opt) => opt.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  /**
   * 计算面板位置：优先向下展开，下方空间不足且上方更宽裕时向上翻转。
   * 面板是 fixed 且挂在 body 上，坐标相对视口，因此不受任何祖先滚动容器影响。
   */
  const placePanel = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const gap = 6;
    const panelH = Math.min(maxPanelHeight, options.length * 36 + 12);
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const openUp = spaceBelow < panelH && spaceAbove > spaceBelow;
    const width = rect.width;
    // 左右夹紧到视口内，避免窄屏或靠右控件把面板顶出屏幕
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    setPanelPos({
      top: openUp ? Math.max(8, rect.top - gap - Math.min(panelH, spaceAbove)) : rect.bottom + gap,
      left,
      width,
    });
  }, [maxPanelHeight, options.length]);

  /*
   * 交互内核（开合 / 键盘 / 外部点击 / 高亮滚动 / 焦点归还）统一来自 useListbox。
   * 这里传入 stopEscapePropagation=true —— 下拉常嵌在弹窗里，Esc 只收起面板、
   * 不能顺手关掉外层弹窗；onBeforeOpen 用于实测 portal 坐标。
   */
  const {
    open: isOpen,
    activeIndex,
    setActiveIndex,
    listId,
    close,
    toggle,
    commitValue,
    handleKeyDown,
    optionId,
  } = useListbox({
    optionValues: options.map((o) => o.value),
    selectedIndex,
    onChange,
    disabled,
    onBeforeOpen: placePanel,
    insideRefs: [panelRef],
    stopEscapePropagation: true,
    onKeyDown,
    triggerRef,
  });

  /* 面板坐标是打开那一刻实测的 —— 页面一滚 / 一缩放就失效，直接收起。
   * NOTE: 必须排除下拉面板自身的滚动！用户用滚轮浏览长选项列表时，
   * 捕获阶段的 scroll 事件不能误判为外部容器滚动而关闭菜单。
   */
  useEffect(() => {
    if (!isOpen) return;
    const onReflow = (e: Event) => {
      if (
        e.target &&
        panelRef.current &&
        (panelRef.current === e.target || panelRef.current.contains(e.target as Node))
      ) {
        return;
      }
      close();
    };
    window.addEventListener("resize", onReflow);
    document.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      document.removeEventListener("scroll", onReflow, true);
    };
  }, [isOpen, close]);

  const commit = (opt: CustomSelectOption) => {
    commitValue(opt.value);
  };

  return (
    <>
      {/* 触发器：根元素即按钮，className 上的宽度/布局类与原生 <select> 等价 */}
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          toggle();
          onClick?.();
        }}
        onKeyDown={handleKeyDown}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-activedescendant={isOpen ? optionId(activeIndex) : undefined}
        aria-label={ariaLabel}
        className={cn(
          "flex items-center justify-between gap-2 text-left select-none outline-none transition-all duration-200",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          !bare && "form-input",
          isOpen && "border-accent",
          className
        )}
      >
        <span className={cn("truncate", selectedOption ? "text-content-primary" : "text-content-muted")}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown
          className={cn(
            "w-4 h-4 flex-shrink-0 text-content-muted transition-transform duration-200",
            isOpen && "rotate-180 text-accent"
          )}
          aria-hidden="true"
        />
      </button>

      {/* 下拉面板：portal 到 body，fixed 定位，走 dropdown-panel 基类统一质感与层级。
          层级用 calc(--z-modal + 10)：弹窗内的下拉必须盖在弹窗（--z-modal）之上。 */}
      {isOpen &&
        panelPos &&
        createPortal(
          <div
            ref={panelRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              position: "fixed",
              top: panelPos.top,
              left: panelPos.left,
              width: panelPos.width,
              maxHeight: maxPanelHeight,
              zIndex: "calc(var(--z-modal) + 10)",
            }}
            className="dropdown-panel overflow-y-auto overscroll-contain p-1 scrollbar-thin"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {options.map((opt, i) => {
              const isSelected = opt.value === value;
              const isActive = i === activeIndex;
              return (
                <button
                  key={opt.value}
                  id={optionId(i)}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => commit(opt)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={cn(
                    "w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors text-left",
                    isActive ? "bg-hovered" : "",
                    isSelected ? "text-accent font-semibold" : "text-content-secondary"
                  )}
                >
                  <span className="truncate">{opt.label}</span>
                  {isSelected && <Check className="w-4 h-4 text-accent flex-shrink-0 ml-2" aria-hidden="true" />}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}

export default CustomSelect;
