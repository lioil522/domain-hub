import { useState, useEffect } from "react";

/**
 * useAppLayout —— 应用外壳（侧栏 / 抽屉 / 断点）状态
 *
 * WHY 抽成 hook：
 * 侧栏在 <md 是「fixed 抽屉 + 遮罩」，在 ≥md 是「常驻可折叠侧栏（rail）」，
 * 两种形态共用同一个 <aside>。控制它的一整套状态 —— 抽屉开关、断点判定、
 * 图标条模式、折叠持久化、Esc 关闭 —— 原先散落在 App 顶部（约 60 行）。
 * 抽出来后 App 只消费一个扁平对象，AppLayout 组件也只依赖这个对象。
 *
 * 关键不变量：
 * - 断点值必须与 Tailwind 的 `md`（768px）保持一致，否则 <aside> 的
 *   `md:static` 归位时机与 isDesktop 判定会错位，出现「已归位但仍被当作抽屉」。
 * - `railMode`（图标条）只在「桌面 + 已折叠」时成立：折叠态是持久化的，
 *   若不叠加 isDesktop，从桌面带过来的 collapsed=1 会让手机抽屉也只剩图标。
 */
export function useAppLayout() {
  // 手机端侧栏抽屉开关（仅 <md 生效；≥md 侧栏常驻，这个状态用不上）
  const [sidebarOpen, setSidebarOpen] = useState(false);

  /**
   * 是否处于 md 及以上宽度 —— 手机抽屉与桌面常驻侧栏的分界
   *
   * NOTE: 断点值必须与 Tailwind 的 md (768px) 保持一致：同一个 <aside> 既要在
   * ≥md 作为常驻侧栏参与布局流，又要在 <md 作为 fixed 抽屉，而"折叠成图标条"
   * 这件事只在桌面有意义 —— 折叠态是持久化的，若不区分宽度，从桌面带过来的
   * sidebarCollapsed=1 会让手机抽屉也只剩图标，没有文字标签。
   */
  const [isDesktop, setIsDesktop] = useState<boolean>(
    () => window.matchMedia("(min-width: 768px)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = (e: MediaQueryListEvent) => {
      setIsDesktop(e.matches);
      // 升到桌面宽度时顺手关掉抽屉，避免旋转屏幕后遗留一个打开状态
      if (e.matches) setSidebarOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // 侧栏折叠（仅桌面图标条模式；持久化到 DNSHE_SIDEBAR_COLLAPSED）
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem("DNSHE_SIDEBAR_COLLAPSED") === "1"
  );
  // 持久化侧栏折叠
  useEffect(() => {
    localStorage.setItem("DNSHE_SIDEBAR_COLLAPSED", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  // 图标条模式：只有桌面 + 已折叠时才成立
  const railMode = isDesktop && sidebarCollapsed;

  // 抽屉打开时支持 Esc 关闭
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  return {
    sidebarOpen,
    setSidebarOpen,
    isDesktop,
    setIsDesktop,
    sidebarCollapsed,
    setSidebarCollapsed,
    railMode,
  };
}

export type UseAppLayoutReturn = ReturnType<typeof useAppLayout>;
