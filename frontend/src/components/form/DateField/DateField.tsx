import React, { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import {
  WEEKDAY_LABELS,
  buildDateValue,
  monthStartOf,
  splitDateValue,
  toLocalDateValue
} from "./dateUtils";

/**
 * 只显示当月日期的日期选择器
 *
 * 原生 <input type="date"> 的下拉面板属于浏览器 chrome，CSS 干预不到 —— Chromium
 * 会用灰色的上月末 / 下月初日期把网格补满 6 行，很容易误点到邻月的同号日期。
 * 这里自绘面板：网格只排当月的天，首行前面的空档留白。
 *
 * value / onChange 仍走 "YYYY-MM-DD" 字符串，与原生 input 取值一致，调用处和
 * 后端校验都不用改；清空时给空串。
 *
 * NOTE: 必须定义在 App() 外面，理由同 PasswordInput —— 写成内部组件会在每次
 * App 重渲染时被当作新组件类型卸载重挂载，面板会自己关掉。
 *
 * NOTE: 面板用 position: fixed + 实测坐标，而不是 absolute。调用处的弹窗内容区
 * 是 overflow-y-auto，absolute 面板会被它裁掉下半截。
 */
export const DateField: React.FC<{
  value: string;
  onChange: (value: string) => void;
  className: string;
  /** 年份下拉的可选下界 / 上界（含）；不传时按「当年 ±」的默认范围。
      注册时间用 [1986, 当年]，到期时间用 [当年, 2999]。 */
  minYear?: number;
  maxYear?: number;
  /** 无障碍组名（a11y）：本组件是「年 / 月 / 日」三段复合控件，
      外层可见 <label> 的 for 属性无法指向非 labelable 的 div，
      因此改用 role="group" + aria-label 把 label 文字传进来，
      读屏器会把三段当作一个名为「注册时间」的组来播报。 */
  ariaLabel?: string;
}> = ({ value, onChange, className, minYear, maxYear, ariaLabel }) => {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => monthStartOf(value));
  const [panelPos, setPanelPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [seg, setSeg] = useState(() => splitDateValue(value));
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const yearRef = useRef<HTMLInputElement | null>(null);
  const monthRef = useRef<HTMLInputElement | null>(null);
  const dayRef = useRef<HTMLInputElement | null>(null);

  /**
   * 三段的最新值（与 seg 状态同步写入）
   *
   * NOTE: 失焦补齐这类回调可能在同一次按键里、setSeg 还没重渲染时就被触发，
   * 此时闭包里的 seg 还是按键前的旧值。凡是要读「当前三段」的地方都读这个 ref。
   */
  const segRef = useRef(seg);
  const writeSeg = (next: { y: string; m: string; d: string }) => {
    segRef.current = next;
    setSeg(next);
  };

  const PANEL_W = 272;
  const PANEL_H = 320;

  // 外部改了 value（打开弹窗时回填、面板选日期、清除）时同步三段显示。
  //
  // NOTE: 用户敲到一半时 commit 会把拼好的完整值抛给 onChange，value 随之变化又回到这里。
  // 若「当前三段」本就构成这个 value，就别用补零后的标准形态盖回去 —— 否则刚敲的 "1"
  // 会被刷成 "01"，接着敲的第二位被 slice(0,2) 丢掉，这正是「日」段还在跳的根因。
  // 只在 value 真的来自外部（与当前三段不一致）时才回填。
  useEffect(() => {
    if (value && buildDateValue(segRef.current) === value) return;
    writeSeg(splitDateValue(value));
  }, [value]);

  /**
   * 把三段拼回 "YYYY-MM-DD" 交给调用处
   *
   * 三段都空 → 空串（未填）。凑不齐完整日期时不上报（buildDateValue 给空串），
   * 让用户接着敲，否则每敲一位都会往上抛一个非法值。
   */
  const commit = (next: { y: string; m: string; d: string }) => {
    if (!next.y && !next.m && !next.d) {
      if (value) onChange("");
      return;
    }
    const built = buildDateValue(next);
    if (built && built !== value) onChange(built);
  };

  const setSegment = (key: "y" | "m" | "d", raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, key === "y" ? 4 : 2);
    const next = { ...segRef.current, [key]: digits };
    writeSeg(next);
    commit(next);
    // 年份满 4 位、月份满 2 位就自动跳到下一段，省掉手动 Tab / 点击
    if (key === "y" && digits.length === 4) monthRef.current?.select();
    // 月份首位 >= 2 只可能是个位月（2-9 月），补 0 后直接进日
    else if (key === "m" && (digits.length === 2 || Number(digits) >= 2)) dayRef.current?.select();
  };

  /** 失焦时补齐并夹到合法范围：月 1-12，日不超过当月天数 */
  const normalizeSegments = () => {
    const cur = segRef.current;
    if (!cur.y && !cur.m && !cur.d) return;
    const y = cur.y.length === 4 ? cur.y : String(new Date().getFullYear());
    const monthNum = cur.m ? Math.min(12, Math.max(1, Number(cur.m))) : 1;
    const maxDay = new Date(Number(y), monthNum, 0).getDate();
    const dayNum = cur.d ? Math.min(maxDay, Math.max(1, Number(cur.d))) : 1;
    const next = { y, m: String(monthNum).padStart(2, "0"), d: String(dayNum).padStart(2, "0") };
    writeSeg(next);
    commit(next);
  };

  /**
   * 三段共用的失焦处理：只有焦点真的离开整个日期框时才补齐
   *
   * NOTE: 年份满 4 位后会 select() 月份段，这次组件内部的跳段同样会让年份段失焦。
   * 早先无条件补齐，于是敲完年份立刻被「补」成 1 月 1 日：月份段带着 01 且光标停在
   * 其后，接着敲月份会因为已满 2 位而被丢掉；补齐读到的又是本次按键前的旧三段
   * （年份只有 3 位，被当成不完整值换成当年），输入 2027 就变成了 2026。
   * 判断 relatedTarget（即将获得焦点的元素）在不在本组件内即可跳过这类内部跳转，
   * 顺带也让「点日历按钮」不再触发补齐。
   */
  const handleSegmentBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    if (wrapRef.current?.contains(e.relatedTarget as Node | null)) return;
    normalizeSegments();
  };

  /** 空段上按退格 → 退回上一段，行为对齐原生日期框 */
  const onSegmentKeyDown = (key: "m" | "d") => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !e.currentTarget.value) {
      e.preventDefault();
      (key === "m" ? yearRef : monthRef).current?.select();
    }
  };

  // 打开时把面板翻到已选日期所在月，并按输入框的位置摆放（下方空间不够则翻到上方）
  const openPanel = () => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) {
      const enoughBelow = window.innerHeight - rect.bottom > PANEL_H + 8;
      setPanelPos({
        top: enoughBelow ? rect.bottom + 4 : Math.max(8, rect.top - PANEL_H - 4),
        left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - PANEL_W - 8))
      });
    }
    // 已敲了年份但日期还不完整时，也让面板落到手输的年 / 月，而不是退回当前月
    const cur = segRef.current;
    if (cur.y.length === 4) {
      const monthNum = cur.m ? Math.min(12, Math.max(1, Number(cur.m))) : 1;
      setViewMonth(new Date(Number(cur.y), monthNum - 1, 1));
    } else {
      setViewMonth(monthStartOf(value));
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || wrapRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // 只吃掉 Esc 的冒泡，别让它顺手把外层弹窗一起关了
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    // 坐标是开面板那一刻实测的，页面一滚就失效，直接收起来
    const onReflow = () => setOpen(false);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onReflow);
    document.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onReflow);
      document.removeEventListener("scroll", onReflow, true);
    };
  }, [open]);

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // 首行留白格数：getDay() 的 0 = 周日，周一为首时要挪到末位
  const leadingBlanks = (new Date(year, month, 1).getDay() + 6) % 7;
  const todayValue = toLocalDateValue(new Date());

  /**
   * 年份下拉的候选范围
   *
   * 调用处按语义传范围：注册时间 [1986, 当年]，到期时间 [当年, 2999]，都够点。
   * 不传时退回「当年前 40 / 后 20 年」的中庸默认。再与当前查看的年份取并集：
   * 万一手输了范围外的年份，面板仍能正确显示该年，而不是被下拉框拽回边界。
   */
  const yearOptions = useMemo(() => {
    const nowYear = new Date().getFullYear();
    const from = Math.min(minYear ?? nowYear - 40, year);
    const to = Math.max(maxYear ?? nowYear + 20, year);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }, [year, minYear, maxYear]);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  // 三段共用的样式：定宽居中、去掉数字框的上下箭头、聚焦时只高亮当前段
  const segCls =
    "bg-transparent border-0 outline-none text-center tabular-nums p-0 focus:bg-accent/15 rounded [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

  return (
    <>
      <div
        ref={wrapRef}
        role="group"
        aria-label={ariaLabel}
        className={`${className} flex items-center gap-1`}
      >
        <input
          ref={yearRef}
          type="text"
          inputMode="numeric"
          value={seg.y}
          onChange={(e) => setSegment("y", e.target.value)}
          onBlur={handleSegmentBlur}
          onFocus={(e) => e.currentTarget.select()}
          placeholder="年"
          aria-label="年"
          className={`${segCls} w-10`}
        />
        <span className="text-content-muted select-none">/</span>
        <input
          ref={monthRef}
          type="text"
          inputMode="numeric"
          value={seg.m}
          onChange={(e) => setSegment("m", e.target.value)}
          onKeyDown={onSegmentKeyDown("m")}
          onBlur={handleSegmentBlur}
          onFocus={(e) => e.currentTarget.select()}
          placeholder="月"
          aria-label="月"
          className={`${segCls} w-6`}
        />
        <span className="text-content-muted select-none">/</span>
        <input
          ref={dayRef}
          type="text"
          inputMode="numeric"
          value={seg.d}
          onChange={(e) => setSegment("d", e.target.value)}
          onKeyDown={onSegmentKeyDown("d")}
          onBlur={handleSegmentBlur}
          onFocus={(e) => e.currentTarget.select()}
          placeholder="日"
          aria-label="日"
          className={`${segCls} w-6`}
        />
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : openPanel())}
          className="ml-auto p-0.5 text-content-muted hover:text-content-primary rounded transition-colors flex-shrink-0"
          title="选择日期"
          aria-label="选择日期"
        >
          <CalendarDays className="w-4 h-4" />
        </button>
      </div>

      {open && (
        <div
          ref={panelRef}
          style={{ position: "fixed", top: panelPos.top, left: panelPos.left, width: PANEL_W }}
          className="z-dropdown bg-elevated border border-border-base rounded-xl shadow-2xl p-3"
        >
          <div className="flex items-center gap-1.5 mb-2">
            {/* 年 / 月直接用下拉选，跨年跨月不必一下一下点翻月箭头 */}
            <select
              value={year}
              onChange={(e) => setViewMonth(new Date(Number(e.target.value), month, 1))}
              className="form-input flex-1 min-w-0 text-xs font-semibold px-1.5 py-1 rounded-md cursor-pointer"
              aria-label="选择年份"
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y} 年
                </option>
              ))}
            </select>
            <select
              value={month}
              onChange={(e) => setViewMonth(new Date(year, Number(e.target.value), 1))}
              className="form-input flex-1 min-w-0 text-xs font-semibold px-1.5 py-1 rounded-md cursor-pointer"
              aria-label="选择月份"
            >
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i} value={i}>
                  {i + 1} 月
                </option>
              ))}
            </select>
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <button
                type="button"
                onClick={() => setViewMonth(new Date(year, month - 1, 1))}
                className="p-1 text-content-muted hover:text-content-primary hover:bg-hovered rounded transition-colors"
                title="上一月"
                aria-label="上一月"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setViewMonth(new Date(year, month + 1, 1))}
                className="p-1 text-content-muted hover:text-content-primary hover:bg-hovered rounded transition-colors"
                title="下一月"
                aria-label="下一月"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-0.5">
            {WEEKDAY_LABELS.map((w) => (
              <div key={w} className="text-[11px] text-content-muted text-center py-1">
                {w}
              </div>
            ))}
            {/* 当月 1 号之前的格子留白，不拿邻月日期补 */}
            {Array.from({ length: leadingBlanks }, (_, i) => (
              <div key={`blank-${i}`} />
            ))}
            {Array.from({ length: daysInMonth }, (_, i) => {
              const day = i + 1;
              const dayValue = toLocalDateValue(new Date(year, month, day));
              const selected = dayValue === value;
              const isToday = dayValue === todayValue;
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => pick(dayValue)}
                  className={`h-8 rounded-md text-xs font-medium transition-colors ${
                    selected
                      ? "bg-accent-gradient shadow-sm"
                      : isToday
                        ? "text-accent font-bold hover:bg-hovered"
                        : "text-content-secondary hover:bg-hovered"
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between mt-2 pt-2 border-t border-border-soft">
            <button
              type="button"
              onClick={() => pick("")}
              className="text-[11px] font-semibold text-content-muted hover:text-content-primary px-2 py-1 rounded hover:bg-hovered transition-colors"
            >
              清除
            </button>
            <button
              type="button"
              onClick={() => pick(todayValue)}
              className="text-[11px] font-semibold text-accent hover:opacity-80 px-2 py-1 rounded hover:bg-hovered transition-colors"
            >
              今天
            </button>
          </div>
        </div>
      )}
    </>
  );
};
