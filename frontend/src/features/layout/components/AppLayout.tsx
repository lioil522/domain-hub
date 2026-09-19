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
import type { LucideIcon } from "lucide-react";
import { NavItem, NavSubItem, type NavSource } from "../../../components/NavItem";
import type { BrandKey } from "../../../components/BrandLogo";
import { SearchResultGroups } from "../../../components/search/SearchResultGroups";
import type { CrossSourceResult } from "../../../types/search";
import type { JumpSource } from "../../../types/provider";
import type { AppLog } from "../../../types/log";

/**
 * AppLayout —— 应用外壳（左侧菜单 + 顶部栏 + 内容区）
 *
 * WHY 抽出来：
 * 原先 App.tsx 从 `return (` 到 `</main>` 之间约 270 行全是外壳 JSX ——
 * 抽屉遮罩、<aside>（双形态侧栏）、汉堡按钮、全局搜索框、通知铃铛、主题
 * 切换、退出登录、以及承载所有标签页的 <main>。它与「业务标签页」是两个
 * 完全不同的关注点：外壳管布局与全局导航，<main> 的内容由 App 决定。
 *
 * 因此这里把 <main> 做成 children 插槽：App 仍在自己体内渲染各
 * `{activeTab === ...}` 分支，只是把它们塞进 <AppLayout>…</AppLayout>。
 * 外壳与业务互不侵入，App 也不再被 270 行导航 JSX 淹没。
 *
 * 侧栏可折叠（rail）/ 手机抽屉的**状态**由 `useAppLayout` 管理，本组件
 * 通过 props 接收；导航项、告警、搜索等**数据**都来自 App（依赖 App 大量
 * 内部状态），以 props 注入，本组件保持无状态展示。
 */
export interface AppLayoutNavItem {
  key: string;
  label: string;
  badge?: number;
  source?: NavSource;
  brand?: BrandKey;
}

export interface AppLayoutProps {
  /** 当前标签页 key（用于导航高亮与搜索提交判定） */
  activeTab: string;
  /** 切换标签页 */
  setActiveTab: (tab: string) => void;

  // ── 侧栏 / 抽屉状态（来自 useAppLayout） ──
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  railMode: boolean;

  /** 实际渲染的侧栏菜单项（概览 + 动态服务商 + 自定义 + 管理项） */
  visibleNavItems: AppLayoutNavItem[];
  /** TabKey → 功能项 lucide 图标（服务商项走 brand，不用这张表） */
  navIcons: Record<string, LucideIcon>;
  /** DNSHE 子菜单是否展开 */
  dnsheMenuOpen: boolean;
  setDnsheMenuOpen: (v: boolean) => void;

  // ── 顶部全局搜索 ──
  globalSearch: string;
  setGlobalSearch: (v: string) => void;
  searchFocused: boolean;
  setSearchFocused: (v: boolean) => void;
  /** 跨来源聚合命中（无命中时为 null，不渲染下拉） */
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

  /** 主内容区（App 渲染的各标签页分支） */
  children: React.ReactNode;
}

export function AppLayout(props: AppLayoutProps) {
  const {
    activeTab,
    setActiveTab,
    sidebarOpen,
    setSidebarOpen,
    setSidebarCollapsed,
    railMode,
    visibleNavItems,
    navIcons,
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
    children,
  } = props;

  return (
    /*
      NOTE: 高度用 100dvh 而非 100vh —— 移动浏览器的 100vh 把地址栏高度也算进去，
      底部内容会被切掉一截。桌面上 dvh 与 vh 等价，渲染结果不变。
    */
    <div className="flex h-[100dvh] overflow-hidden bg-page text-content-primary">

      {/* 手机抽屉遮罩：点击关闭；≥md 侧栏常驻，不需要遮罩 */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm md:hidden"
          aria-hidden="true"
        />
      )}

      {/* ===== 左侧菜单：<md 为抽屉，≥md 为常驻可折叠侧栏 ===== */}
      {/*
        NOTE: 同一个 aside 兼任两种形态，导航项只写一份。
        <md：fixed 定位 + translate-x 滑入滑出，不占布局流（否则会吃掉 224px 中的一半屏宽）；
        ≥md：md:static 归位到布局流，宽度由 railMode 决定，与改造前完全一致。
        根容器是 h-[100dvh] overflow-hidden、页面本身不滚动（滚动在 main 内部），
        且抽屉是 fixed，所以不需要额外锁 body 滚动。
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
          {/* 折叠切换只在桌面有意义：手机上这个按钮所在的抽屉本身就是被汉堡唤出的 */}
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
          {/* 抽屉关闭按钮（仅手机） */}
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
            // DNSHE 项带子菜单（域名列表 / 注册·查重 / 账户配额 / 解析线路）
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
                        // 折叠态：点击直接进域名列表
                        setActiveTab("domains");
                        setSidebarOpen(false);
                      } else {
                        // 点击 DNSHE 父菜单：自动展开子菜单（而非切换）
                        setDnsheMenuOpen(true);
                        setActiveTab("domains");
                        setSidebarOpen(false);
                      }
                    }}
                  >
                    {/* 子菜单：域名列表 / 注册·查重 / 账户配额 / 解析线路 */}
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
                icon={navIcons[item.key] || Globe}
                brand={item.brand}
                source={item.source}
                active={activeTab === item.key}
                railMode={railMode}
                badge={item.badge}
                onClick={() => {
                  setActiveTab(item.key);
                  // 点击其它菜单时自动收起 DNSHE 子菜单
                  setDnsheMenuOpen(false);
                  // 手机上选完就收起抽屉，否则内容被遮住还得再点一次
                  setSidebarOpen(false);
                }}
              />
            );
          })}
        </nav>

        {/* 抽屉底部退出入口（仅手机）：头部横向空间紧张，退出按钮挪到这里 */}
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

      {/* ===== 右侧主区（顶部栏 + 内容） ===== */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* ===== 顶部栏 ===== */}
        <header className="relative z-30 h-16 flex-shrink-0 flex items-center gap-2 sm:gap-3 px-3 sm:px-4 md:px-6 border-b border-border-base bg-surface">
          {/* 汉堡按钮：唤出手机抽屉（≥md 侧栏常驻，折叠切换在侧栏内部） */}
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden p-2 -ml-1 rounded-lg text-content-muted hover:text-content-primary hover:bg-hovered transition-all flex-shrink-0"
            title="打开菜单"
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* 全局搜索框 */}
          {/* NOTE: min-w-0 是必需的 —— flex 子项默认 min-width:auto，没有它 flex-1 不会真的收缩 */}
          <div className="flex-1 min-w-0 max-w-md relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-content-muted pointer-events-none" />
            {/*
              NOTE: type="search" + autoComplete="off" 是为了挡住 Chrome 密码管理器。
              设置页的「修改登录密码」表单一旦被自动填充，Chrome 会去猜用户名字段，
              往前找到的第一个纯文本输入框就是这里，于是把用户名塞进搜索框、
              静默过滤掉域名列表（看起来像账号和域名凭空少了一大半）。
              Chrome 不会把 type="search" 的输入框当作用户名字段。
              原生清除按钮在 index.css 里隐藏，外观与改造前一致。
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
              placeholder="搜索域名…"
              className="form-input w-full pl-9 pr-3 py-2 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
            />
            {/* 跨来源聚合搜索下拉：输入关键词且聚焦时展示各来源命中 */}
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

          {/* 把右侧按钮推到最右；手机上让搜索框吃掉这部分空间 */}
          <div className="hidden sm:block flex-1" />

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
              /* NOTE: w-80 在 390px 屏上会顶出右边界，窄屏改用视口宽度减去两侧留白 */
              <div className="absolute right-0 mt-2 w-[calc(100vw-1.5rem)] sm:w-80 max-h-96 overflow-y-auto dropdown-panel p-2">
                <div className="px-2 py-1.5 text-xs font-bold text-content-muted flex items-center justify-between">
                  <span>最近告警</span>
                  <button
                    onClick={() => { markAlertsRead(); setActiveTab("logs"); setNotifOpen(false); }}
                    className="text-accent hover:opacity-80"
                  >
                    查看全部
                  </button>
                </div>
                {alertLogs.length === 0 ? (
                  <div className="px-2 py-6 text-center text-sm text-content-muted">暂无告警</div>
                ) : (
                  alertLogs.map((log) => (
                    <div key={log.id} className="px-2 py-2 rounded-lg hover:bg-hovered text-xs">
                      <div className={`font-semibold ${log.type === "error" ? "text-red-400" : "text-amber-400"}`}>
                        {log.type.toUpperCase()}
                      </div>
                      <div className="text-content-secondary mt-0.5 line-clamp-2">{log.message}</div>
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

          {/* 退出登录：手机上头部空间紧张，入口挪进抽屉底部 */}
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
