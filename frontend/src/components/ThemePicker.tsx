import React from "react";
import { Check } from "lucide-react";
import { cn } from "./cn";
import { THEMES, type ThemeId } from "../theme";

/**
 * ThemePicker —— 配色主题选择器（与明暗开关独立）
 *
 * WHY 用卡片列表而不是下拉框 / 分段控件：
 *   主题是「看一眼才知道要不要」的偏好项，用户没法从「墨玉 · 深青绿」
 *   这五个字判断它长什么样。所以每个选项必须自带配色预览 —— 下拉框做不到，
 *   分段控件（Segmented Control）在 3 个以上选项时会挤成小字。卡片网格让
 *   预览、名称、说明各占一行，扫一眼就能选。
 *
 * 无障碍要点：
 * - 用 role="radiogroup" + role="radio" 而非一组普通按钮 —— 语义上这就是
 *   「多选一」，读屏会念出「已选中 2 / 2」而不是「按钮 按钮」。
 * - 键盘遵循 roving tabindex：Tab 进组、方向键在组内移动、Home/End 跳首尾。
 *   这是 WAI-ARIA radiogroup 的标准交互，用户不需要逐项 Tab。
 * - 预览色块纯装饰，加 aria-hidden；名称与说明都在可访问名称内。
 */

export interface ThemePickerProps {
  value: ThemeId;
  onChange: (id: ThemeId) => void;
  className?: string;
}

export function ThemePicker({ value, onChange, className }: ThemePickerProps) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  /*
   * NOTE: 方向键移动后必须手动把焦点挪到新选项上 —— roving tabindex 的
   * 语义是「只有当前选中项 tabIndex=0」，若不移动焦点，焦点会留在原按钮上，
   * 而那个按钮的 tabIndex 已变成 -1，用户再按方向键就找不到枢轴了。
   */
  const moveTo = (index: number) => {
    const next = (index + THEMES.length) % THEMES.length;
    onChange(THEMES[next].id);
    refs.current[next]?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        moveTo(index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        moveTo(index - 1);
        break;
      case "Home":
        e.preventDefault();
        moveTo(0);
        break;
      case "End":
        e.preventDefault();
        moveTo(THEMES.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="配色主题"
      className={cn("grid grid-cols-1 sm:grid-cols-2 gap-3", className)}
    >
      {THEMES.map((theme, index) => {
        const selected = theme.id === value;
        return (
          <button
            key={theme.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            /* roving tabindex：选中项可 Tab 进入，其余靠方向键到达 */
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(theme.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cn(
              "group relative text-left rounded-lg p-3 border transition-all duration-fast ease-out",
              selected
                ? "border-accent bg-elevated shadow-sm"
                : "border-border-base bg-surface hover:border-accent/40 hover:bg-hovered"
            )}
          >
            {/* ── 配色预览条 ────────────────────────────────────────
                三个色块：亮色主色 / 暗色主色 / 亮色底。
                刻意不用「主题生效后的真实截图」做预览 —— 那需要在渲染时
                临时切换全局主题属性来采样，会造成可见的闪烁。三个色块足够
                传达色相与明度倾向，且零副作用。
                内联 style 读 theme.swatch（写死在 theme.ts），而非 CSS 变量。 */}
            <div className="flex items-center gap-2 mb-2.5" aria-hidden="true">
              <span
                className="h-7 flex-1 rounded-sm"
                style={{ backgroundColor: theme.swatch.light }}
              />
              <span
                className="h-7 flex-1 rounded-sm border border-border-soft"
                style={{ backgroundColor: theme.swatch.dark }}
              />
              <span
                className="h-7 flex-1 rounded-sm border border-border-soft"
                style={{ backgroundColor: theme.swatch.surface }}
              />
            </div>

            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div
                  className={cn(
                    "text-sm font-bold",
                    selected ? "text-accent" : "text-content-primary"
                  )}
                >
                  {theme.label}
                </div>
                <div className="text-[11px] text-content-muted leading-snug mt-0.5">
                  {theme.description}
                </div>
              </div>

              {/* 选中标记。用图标 + 边框双通道表达选中，不单靠颜色（色盲用户） */}
              <span
                className={cn(
                  "w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5",
                  selected ? "bg-accent" : "border border-border-base"
                )}
                aria-hidden="true"
              >
                {selected && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
