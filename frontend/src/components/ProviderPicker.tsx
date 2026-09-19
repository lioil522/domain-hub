import React, { useRef } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "./cn";
import { BrandLogo, type BrandKey } from "./BrandLogo";
import { useListbox } from "./form/useListbox";

/**
 * ProviderPicker —— 服务商选择器（点击展开）
 *
 * WHY 需要它：
 * 绑定弹窗里原先把 7 家托管商平铺成一行按钮（flex-wrap + min-w-[68px]）。
 * 这个写法有三个问题：
 * 1. **挤**：7 个中文/英文混排标签在窄屏必然换行，视觉上像两排碎块；
 * 2. **不可扩展**：再接第 8、9 家时这一行会彻底失控；
 * 3. **无品牌识别**：纯文字标签，与侧栏/账号卡片上的品牌图标体系脱节 ——
 *    用户在别处已经建立「那个蓝色方块 = DNSHE」的认知，到这里却只有文字。
 *
 * 改成「点击展开」后：收起时只占一行、显示当前选择；展开时纵向列出全部，
 * 每家带真实品牌图标，且纵向列表天然能容纳更多服务商。
 *
 * 无障碍：按 WAI-ARIA listbox 模式实现 —— 触发器带 aria-haspopup/aria-expanded，
 * 列表 role="listbox"，选项 role="option" + aria-selected。
 * 键盘：Enter/Space/↓ 打开，↑↓ 移动，Enter/Space 选中，Esc 关闭并归还焦点。
 */

export interface ProviderOption {
  /** 服务商 key，直接回传给 onChange（"dnshe" / MultiProviderKey 等） */
  key: string;
  /** 展示名 */
  label: string;
  /** 真实品牌图标 */
  brand: BrandKey;
  /**
   * 分组名。相邻组的变体之间会渲染一条分隔线 ——
   * 用来把「原有三家」与「新接入四家」在视觉上分段，避免 7 个选项糊成一片。
   */
  group?: string;
}

export interface ProviderPickerProps {
  options: ProviderOption[];
  /** 当前选中的 key */
  value: string;
  onChange: (key: string) => void;
  /** 触发器的可访问名称，同时用作列表 aria-label */
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

export function ProviderPicker(props: ProviderPickerProps) {
  const {
    options,
    value,
    onChange,
    ariaLabel = "账号提供商",
    disabled = false,
    className
  } = props;

  const wrapRef = useRef<HTMLDivElement | null>(null);

  const selectedIndex = options.findIndex((o) => o.key === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : options[0];

  /*
   * 交互内核统一来自 useListbox（与 CustomSelect 共用同一份 listbox 逻辑，
   * 避免两个下拉再次分叉）。差异：本组件是**内联展开**（撑开布局），且嵌在
   * 绑定弹窗里但自身不 portal，因此用 wrapRef 做外部点击判定、Esc 不阻止冒泡
   * （本组件在弹窗内，但原实现 Esc 只收起面板不 stopPropagation，逐字保留）。
   */
  const {
    open,
    activeIndex,
    setActiveIndex,
    listId,
    triggerRef,
    toggle,
    commitValue,
    handleKeyDown,
    optionId,
  } = useListbox({
    optionValues: options.map((o) => o.key),
    selectedIndex,
    onChange,
    disabled,
    insideRefs: [wrapRef],
    stopEscapePropagation: false,
  });

  const commit = (key: string) => {
    commitValue(key);
  };

  return (
    <div ref={wrapRef} className={className} onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => toggle()}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold",
          "bg-elevated border border-border-base text-content-primary",
          "transition-colors duration-fast",
          "hover:bg-hovered",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          /* 展开态用强调色描边指示「面板已打开」。
             NOTE: 只用 border-accent（已映射的令牌），不叠加带透明度修饰符的
             ring 类 —— accent 在 Tailwind 里是 var(--accent) 的纯字符串，
             透明度修饰符无法安全套用，会产出无效 CSS。 */
          open && "border-accent"
        )}
      >
        {selected && <BrandLogo brand={selected.brand} size={20} className="flex-shrink-0" />}
        <span className="flex-1 text-left truncate">{selected?.label ?? "请选择"}</span>
        <ChevronDown
          className={cn(
            "w-4 h-4 flex-shrink-0 text-content-muted transition-transform duration-fast",
            open && "rotate-180"
          )}
          aria-hidden="true"
        />
      </button>

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          /*
           * NOTE: 这里是**内联展开**（撑开布局、把下方内容往下推），
           * 而非常见的 float/absolute 浮层。原因是本组件固定用在绑定弹窗里，
           * 而弹窗内容区是 `overflow-y-auto` 的滚动容器 —— 绝对定位的浮层会被
           * 该容器裁掉（实测 7 项只能看见 4 项，且逼出容器滚动条）。
           * 内联展开没有裁剪问题、不需要测位置、不需要处理容器滚动时的重定位，
           * 也不产生「弹窗内再套一层滚动」的嵌套滚动 —— 手机上嵌套滚动最难受。
           * 代价是展开时下方表单项会下移，这是移动端弹窗里很常见且可接受的。
           *
           * 也因此**不设 max-h / overflow-y**：让 7 项完整呈现，由弹窗自身滚动。
           */
          className={cn(
            "mt-1 py-1 bg-surface border border-border-base rounded-lg shadow-lg"
          )}
        >
          {options.map((opt, i) => {
            const isSelected = opt.key === value;
            const isActive = i === activeIndex;
            // 与上一项不同组时插一条分隔线
            const showDivider = i > 0 && opt.group !== options[i - 1].group;

            return (
              <React.Fragment key={opt.key}>
                {showDivider && <li role="presentation" className="my-1 border-t border-border-base" />}
                <li
                  id={optionId(i)}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => commit(opt.key)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2.5 cursor-pointer text-sm",
                    isActive ? "bg-hovered" : "",
                    isSelected ? "font-semibold text-content-primary" : "text-content-secondary"
                  )}
                >
                  <BrandLogo brand={opt.brand} size={20} className="flex-shrink-0" />
                  <span className="flex-1 truncate">{opt.label}</span>
                  {isSelected && (
                    <Check className="w-4 h-4 flex-shrink-0 text-accent" aria-hidden="true" />
                  )}
                </li>
              </React.Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default ProviderPicker;
