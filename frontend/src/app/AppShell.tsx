import React from "react";
import {
  Globe,
  Menu,
  X,
  Search,
  Bell,
  Sun,
  Moon,
  LogIn,
} from "lucide-react";
import { NavItem, NavSubItem } from "../components/NavItem";
import { SearchResultGroups } from "../components/search/SearchResultGroups";
import type { CrossSourceResult } from "../types/search";
import type { JumpSource } from "../types/provider";
import type { AppLog } from "../types/log";
import type { ApiFetch } from "../api/client";
import { ActionCenter } from "../components/patterns/ActionCenter";
import { useAppLayout } from "./useAppLayout";
import { NAV_ICONS, type NavigationItem, type TabKey } from "./navigation";

/**
 * AppShell —— 应用外壳(左侧菜单 + 顶部栏 + 内容区)
 *
 * WHY:
 *   原先外壳由 `features/layout/components/AppLayout` 渲染,但侧栏/抽屉的**状态**
 *   (`useAppLayout` 的 5 个返回值)却留在 App.tsx 顶部,再作为 props 传进来 ——
 *   这些状态在 App 里没有任何别的消费点,纯属白占决策面。收敛到本组件后:
 *     - App 不再调用 useAppLayout,也不再持有 sidebarOpen / sidebarCollapsed 等;
 *     - 外壳的状态与外壳的渲染同处一地(单一职责);
 *     - 布局从 `features/`(业务功能)移入 `app/`(应用组装),语义更准。
 *
 * 侧栏可折叠(rail)/ 手机抽屉的状态由内部 useAppLayout 管理;导航项、告警、
 * 搜索等**数据**仍由 App 注入(它们依赖 App 的大量业务状态),本组件保持展示职责。
 *
 * 依赖方向:app → components / types,不反向依赖 App.tsx。
 */
export interface AppShellProps {
  /** 当前标签页 key(用于导航高亮与搜索提交判定) */
  activeTab: TabKey;
  /** 切换标签页 */
  setActiveTab: (tab: TabKey) => void;

  /** 实际渲染的侧栏菜单项(概览 + 动态服务商 + 自定义 + 管理项) */
  visibleNavItems: NavigationItem[];
  /** DNSHE 子菜单是否展开 */
  dnsheMenuOpen: boolean;
  setDnsheMenuOpen: (v: boolean) => void;

  // ── 顶部全局搜索 ─
  globalSearch: string;
  setGlobalSearch: (v: string) => void;
  searchFocused: boolean;
  setSearchFocused: (v: boolean) => void;
  /** 跨来源聚合命中(无命中时为 null,不渲染下拉) */
  crossSourceSearch: CrossSourceResult | null;
  onGlobalSearchSubmit: () => void;
  onCrossSourceJump: (source: JumpSource, fullDomain: string) => void;

  // ── 通知铃铛 ──
  notifOpen: boolean;
  setNotifOpen: (v: boolean) => void;
  notifRef: React.MutableRefObject<HTMLDivElement | null>;
  alertLogs: AppLog[];
  unreadAlert: boolean;
  markAlertsRead: () => void;

  // ── 主题 / 登出 ──
  theme: "light" | "dark";
  setTheme: React.Dispatch<React.SetStateAction<"light" | "dark">>;
  onLogout: () => void;

  /** 后端 API 请求器，由 AppDataProvider 注入 */
  apiFetch: ApiFetch;
  /** 主内容区(App 渲染的当前标签页与覆盖层) */
  children: React.ReactNode;
}

export function AppShell(props: AppShellProps) {
  const {
    activeTab,
    setActiveTab,
    visibleNavItems,
    dnsheMenuOpen,
    setDnsheMenuOpen,
    globalSearch,
    setGlobalSearch,
    searchFocused,
    setSearchFocused,
    crossSourceSearch,
    onGlobalSearchSubmit,
    onCrossSourceJump,
    notifOpen,
    setNotifOpen,
    notifRef,
    alertLogs,
    unreadAlert,
    markAlertsRead,
    theme,
    setTheme,
    onLogout,
    apiFetch,
    children,
  } = props;

  // 侧栏 / 抽屉 / 断点状态 —— 外壳自持,不再由 App 透传
  const {
    sidebarOpen,
    setSidebarOpen,
    setSidebarCollapsed,
    railMode,
  } = useAppLayout();

  return (
    /*
      NOTE: 高度用 100dvh 而非 100vh —— 移动浏览器的 100vh 把地址栏高度也算进去,
      底部内容会被切掉一截。桌面上 dvh 与 vh 等价,渲染结果不变。
    */
    <div className="flex h-[100dvh] overflow-hidden bg-page text-content-primary">

      {/* 手机抽屉遮罩:点击关闭;≥md 侧栏常驻,不需要遮罩 */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm md:hidden"
          aria-hidden="true"
        />
      )}

      {/* ===== 左侧菜单:<md 为抽屉,≥md 为常驻可折叠侧栏 ===== */}
      {/*
        NOTE: 同一个 aside 兼任两种形态,导航项只写一份。
        <md:fixed 定位 + translate-x 滑入滑出,不占布局流(否则会吃掉 224px 中的一半屏宽);
        ≥md:md:static 归位到布局流,宽度由 railMode 决定,与改造前完全一致。
        根容器是 h-[100dvh] overflow-hidden、页面本身不滚动(滚动在 main 内部),
        且抽屉是 fixed,所以不需要额外锁 body 滚动。
      */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 flex flex-col border-r border-border-base bg-surface transition-transform duration-300 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } md:static md:z-auto md:translate-x-0 md:flex-shrink-0 md:transition-all ${
          railMode ? "md:w-16" : "md:w-56"
        }`}
      >
        {/* LOGO + 折叠按钮 */}
        <div className="h-16 flex items-center gap-2 px-3 border-b border-border-base">
          {/* 折叠切换只在桌面有意义:手机上这个按钮所在的抽屉本身就是被汉堡唤出的 */}
          <button
            onClick={() => setSidebarCollapsed((v) => !v)}
            className="hidden md:flex p-2 rounded-lg text-content-muted hover:text-content-primary hover:bg-hovered transition-all flex-shrink-0"
            title={railMode ? "展开菜单" : "折叠菜单"}
          >
            <Menu className="w-5 h-5" />
          </button>
          {!railMode && (
            <div className="flex items-center gap-1.5 font-black text-content-primary whitespace-nowrap overflow-hidden">
              <Globe className="w-5 h-5 text-accent flex-shrink-0" />
              <span className="truncate">Domain Hub</span>
            </div>
          )}
          {/* 抽屉关闭按钮(仅手机) */}
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden ml-auto p-2 rounded-lg text-content-muted hover:text-content-primary hover:bg-hovered transition-all"
            title="关闭菜单"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 菜单项 */}
        <nav className="flex-1 py-4 px-2 space-y-1 overflow-y-auto">
          {visibleNavItems.map((item) => {
            // DNSHE 项带子菜单(域名列表 / 注册·查重 / 账户配额 / 解析线路)
            if (item.key === "domains") {
              const isActive = activeTab === "domains" || activeTab === "register" || activeTab === "quota" || activeTab === "line-settings";
              return (
                <div key={item.key} className="relative">
                  <NavItem
                    label={item.label}
                    brand="dnshe"
                    source={item.source}
                    active={isActive}
                    railMode={railMode}
                    badge={item.badge}
                    hasSubmenu
                    expanded={dnsheMenuOpen}
                    onClick={() => {
                      if (railMode) {
                        // 折叠态:点击直接进域名列表
                        setActiveTab("domains");
                        setSidebarOpen(false);
                      } else {
                        // 点击 DNSHE 父菜单:自动展开子菜单(而非切换)
                        setDnsheMenuOpen(true);
                        setActiveTab("domains");
                        setSidebarOpen(false);
                      }
                    }}
                  >
                    {/* 子菜单:域名列表 / 注册·查重 / 账户配额 / 解析线路 */}
                    {!railMode && dnsheMenuOpen && (
                      <div className="mt-1 ml-4 pl-3 border-l border-border-base space-y-0.5">
                        <NavSubItem
                          label="域名列表"
                          active={activeTab === "domains"}
                          onClick={() => { setActiveTab("domains"); setSidebarOpen(false); }}
                        />
                        <NavSubItem
                          label="注册 / 查重"
                          active={activeTab === "register"}
                          onClick={() => { setActiveTab("register"); setSidebarOpen(false); }}
                        />
                        <NavSubItem
                          label="账户配额"
                          active={activeTab === "quota"}
                          onClick={() => { setActiveTab("quota"); setSidebarOpen(false); }}
                        />
                        <NavSubItem
                          label="解析线路"
                          active={activeTab === "line-settings"}
                          onClick={() => { setActiveTab("line-settings"); setSidebarOpen(false); }}
                        />
                      </div>
                    )}
                  </NavItem>
                </div>
              );
            }
            return (
              <NavItem
                key={item.key}
                label={item.label}
                icon={NAV_ICONS[item.key] || Globe}
                brand={item.brand}
                source={item.source}
                active={activeTab === item.key}
                railMode={railMode}
                badge={item.badge}
                onClick={() => {
                  setActiveTab(item.key);
                  // 点击其它菜单时自动收起 DNSHE 子菜单
                  setDnsheMenuOpen(false);
                  // 手机上选完就收起抽屉,否则内容被遮住还得再点一次
                  setSidebarOpen(false);
                }}
              />
            );
          })}
        </nav>

        {/* 抽屉底部退出入口(仅手机):头部横向空间紧张,退出按钮挪到这里 */}
        <div className="md:hidden border-t border-border-base p-2">
          <button
            onClick={onLogout}
            className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-semibold text-content-secondary hover:text-content-primary hover:bg-hovered transition-all"
          >
            <LogIn className="w-5 h-5 text-amber-400 flex-shrink-0" />
            退出登录
          </button>
        </div>
      </aside>

      {/* ===== 右侧主区(顶部栏 + 内容) ===== */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* ===== 顶部栏 ===== */}
        <header className="relative z-30 h-16 flex-shrink-0 flex items-center gap-2 sm:gap-3 px-3 sm:px-4 md:px-6 border-b border-border-base bg-surface">
          {/* 汉堡按钮:唤出手机抽屉(≥md 侧栏常驻,折叠切换在侧栏内部) */}
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden p-2 -ml-1 rounded-lg text-content-muted hover:text-content-primary hover:bg-hovered transition-all flex-shrink-0"
            title="打开菜单"
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* 全局搜索框 */}
          {/* NOTE: min-w-0 是必需的 —— flex 子项默认 min-width:auto,没有它 flex-1 不会真的收缩 */}
          <div className="flex-1 min-w-0 max-w-md relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-content-muted pointer-events-none" />
            {/*
              NOTE: type="search" + autoComplete="off" 是为了挡住 Chrome 密码管理器。
              设置页的「修改登录密码」表单一旦被自动填充,Chrome 会去猜用户名字段,
              往前找到的第一个纯文本输入框就是这里,于是把用户名塞进搜索框、
              静默过滤掉域名列表(看起来像账号和域名凭空少了一大半)。
              Chrome 不会把 type="search" 的输入框当作用户名字段。
              原生清除按钮在 index.css 里隐藏,外观与改造前一致。
            */}
            <input
              type="search"
              name="domain-search"
              autoComplete="off"
              value={globalSearch}
              onChange={(e) => setGlobalSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onGlobalSearchSubmit(); }}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => window.setTimeout(() => setSearchFocused(false), 150)}
              placeholder="搜索域名..."
              className="form-input w-full pl-9 pr-3 py-2 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
            />
            {/* 跨来源聚合搜索下拉:输入关键词且聚焦时展示各来源命中 */}
            {searchFocused && globalSearch.trim() && crossSourceSearch && (
              <div
                className="!absolute left-0 right-0 top-full mt-1.5 max-h-80 overflow-y-auto dropdown-panel"
                onMouseDown={(e) => e.preventDefault()}
              >
                <SearchResultGroups
                  result={crossSourceSearch}
                  onJump={onCrossSourceJump}
                />
              </div>
            )}
          </div>

          {/* 把右侧按钮推到最右;手机上让搜索框吃掉这部分空间 */}
          <div className="hidden sm:block flex-1" />

          {/* 操作中心 */}
          <ActionCenter apiFetch={apiFetch} />

          {/* 通知铃铛 */}
          <div className="relative flex-shrink-0" ref={notifRef}>
            <button
              onClick={() => {
                const next = !notifOpen;
                setNotifOpen(next);
                if (next) markAlertsRead();
              }}
              className="relative p-2 rounded-lg text-content-muted hover:text-content-primary hover:bg-hovered transition-all"
              title="告警通知"
            >
              <Bell className="w-5 h-5" />
              {unreadAlert && (
                <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              )}
            </button>
            {notifOpen && (
              /* NOTE: w-80 在 390px 屏上会顶出右边界,窄屏改用视口宽度减去两侧留白 */
              <div className="absolute right-0 mt-2 w-[calc(100vw-1.5rem)] sm:w-80 max-h-96 overflow-y-auto overscroll-contain dropdown-panel p-3 z-modal scrollbar-thin">
                <div className="flex items-center justify-between pb-2 mb-1.5 border-b border-border-base/60">
                  <span className="text-xs font-bold text-content-primary">最近告警</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { markAlertsRead(); setActiveTab("logs"); setNotifOpen(false); }}
                      className="text-xs text-accent hover:opacity-80 font-medium"
                    >
                      查看全部
                    </button>
                    <button
                      onClick={() => setNotifOpen(false)}
                      className="p-1 rounded-lg hover:bg-hovered text-content-muted hover:text-content-primary transition-colors"
                      title="关闭"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                {alertLogs.length === 0 ? (
                  <div className="py-6 text-center text-xs text-content-muted">暂无告警</div>
                ) : (
                  alertLogs.map((log) => (
                    <div key={log.id} className="p-2.5 my-1.5 rounded-xl bg-surface/60 hover:bg-surface/90 border border-border-base/40 hover:border-accent/30 text-xs transition-all">
                      <div className={`font-semibold ${log.type === "error" ? "text-[var(--state-danger-fg)]" : "text-[var(--state-warn-fg)]"}`}>
                        {log.type.toUpperCase()}
                      </div>
                      <div className="text-content-secondary mt-1 line-clamp-2 leading-relaxed">{log.message}</div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* 主题切换 */}
          <button
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            className="p-2 rounded-lg text-content-muted hover:text-content-primary hover:bg-hovered transition-all flex-shrink-0"
            title={theme === "dark" ? "切换到亮色" : "切换到暗色"}
          >
            {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>

          {/* 退出登录:手机上头部空间紧张,入口挪进抽屉底部 */}
          <button
            onClick={onLogout}
            className="hidden md:flex bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-3 py-2 rounded-lg text-sm font-semibold items-center gap-2 transition-all flex-shrink-0"
            title="退出登录"
          >
            <LogIn className="w-4 h-4 text-amber-400" />
            <span className="hidden md:inline">退出登录</span>
          </button>
        </header>

        {/* 主面板内容 */}
        <main className="flex-1 overflow-y-auto px-3 sm:px-4 md:px-6 pb-5 md:pb-6">
          {children}
        </main>
      </div>
    </div>
  );
}
