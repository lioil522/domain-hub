import type { ReactNode } from "react";
import {
  UserCheck,
  Search,
  RefreshCw,
  Globe,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Key,
} from "lucide-react";
import { CustomSelect } from "../../../components/form/CustomSelect";
import type { Domain } from "../../../types/domain";
import type { Account } from "../../../types/account";

/**
 * DomainsPage —— DNSHE 域名列表标签页
 *
 * JSX 从 App.tsx 逐字搬运（Phase 12）。状态与分组逻辑分别来自 App 与
 * features/domains/hooks/useDnsheDomains；卡片渲染由 App 传入的 renderDomainCard
 * （一个「App 闭包 → DomainCard props」适配器）负责 —— 因为它依赖高亮、三点菜单、
 * CF 交叉判据等跨卡片共享状态，留在 App 组装最省事。
 */
export interface DomainsPageGroup {
  accountId: number;
  alias: string;
  seq: number;
  domains: Domain[];
}

export interface DomainsPageProps {
  // 账号筛选
  selectedAccountFilter: string;
  onSelectAccountFilter: (v: string) => void;
  dnsheAccounts: Account[];
  /** 触发域名拉取（带可选账号过滤） */
  fetchDomains: (accountIdFilter?: string) => void;

  // 顶部横幅
  globalSearch: string;
  onClearSearch: () => void;
  searchHitCount: number;
  domainsCount: number;

  // 同步 / 折叠
  actionLoading: string | null;
  onSyncDnsheDomains: () => void;
  collapsedAccounts: Set<number>;
  onToggleAllAccounts: () => void;

  // 列表
  loadingDomains: boolean;
  groupedDomains: DomainsPageGroup[];
  checkHasDns: (d: Domain) => boolean;
  onToggleAccountCollapse: (accountId: number) => void;
  onSyncAccount: (accountId: number, provider: "dnshe") => void;
  /** 单张域名卡片的渲染适配器（App 内组装） */
  renderDomainCard: (dom: Domain) => ReactNode;
}

export function DomainsPage(props: DomainsPageProps) {
  const {
    selectedAccountFilter,
    onSelectAccountFilter,
    dnsheAccounts,
    fetchDomains,
    globalSearch,
    onClearSearch,
    searchHitCount,
    domainsCount,
    actionLoading,
    onSyncDnsheDomains,
    collapsedAccounts,
    onToggleAllAccounts,
    loadingDomains,
    groupedDomains,
    checkHasDns,
    onToggleAccountCollapse,
    onSyncAccount,
    renderDomainCard,
  } = props;

  return (
    <div className="space-y-8 pt-5 md:pt-6">
      {/* 账号与 DNS 筛选控制器 */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 md:gap-4 bg-surface border border-border-base p-3 sm:p-4 rounded-xl">
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3 sm:gap-4 w-full md:w-auto">
          {/* NOTE: 下拉框原先是 min-w-[180px]，配上 whitespace-nowrap 的标签在手机上是
              硬溢出（不是"挤"）。窄屏改为占满行宽并允许收缩，≥md 才恢复最小宽度。 */}
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-content-secondary flex items-center gap-1.5 whitespace-nowrap flex-shrink-0">
              <UserCheck className="w-4 h-4 text-accent" /> 选择账号:
            </span>
            <CustomSelect
              value={selectedAccountFilter}
              onChange={(v) => {
                onSelectAccountFilter(v);
                fetchDomains(v);
              }}
              ariaLabel="选择账号"
              options={[
                { value: "all", label: "全部账号 (按账号独立分组)" },
                ...dnsheAccounts.map((acc) => ({ value: String(acc.id), label: `账号: ${acc.alias}` })),
              ]}
              className="px-3 py-2 rounded-lg text-sm text-content-secondary flex-1 min-w-0 md:flex-none md:min-w-[180px]"
            />
          </div>
        </div>

        {/* NOTE: 这一组原先没有 flex-wrap，却装着三个 whitespace-nowrap 的元素 */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 w-full md:w-auto">
          {globalSearch.trim() && (
            <div className="flex items-center gap-1.5 text-xs bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/60 px-2.5 py-1 rounded-full whitespace-nowrap">
              <Search className="w-3 h-3 shrink-0" />
              <span className="font-mono">
                搜索「{globalSearch.trim()}」· 命中 {searchHitCount} 个
              </span>
              <button
                onClick={onClearSearch}
                className="ml-0.5 font-semibold underline decoration-dotted hover:text-amber-900 dark:hover:text-amber-100 transition-colors"
              >
                清除
              </button>
            </div>
          )}
          <div className="text-xs text-content-muted font-mono whitespace-nowrap">
            已绑定账户: <span className="text-accent font-bold">{dnsheAccounts.length}</span> |
            托管域名: <span className="text-emerald-400 font-bold">{domainsCount}</span> 个
          </div>
          <button
            onClick={onSyncDnsheDomains}
            disabled={dnsheAccounts.length === 0 || actionLoading === "sync"}
            className="px-4 py-2 sm:py-1.5 text-xs font-semibold bg-accent-gradient hover:shadow-accent rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed ml-auto sm:ml-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${actionLoading === "sync" ? "animate-spin" : ""}`} />
            同步域名
          </button>
          {domainsCount > 0 && (
            <button
              onClick={onToggleAllAccounts}
              className="px-3 py-2 sm:py-1.5 text-xs font-semibold text-content-secondary hover:text-content-primary bg-elevated hover:bg-hovered border border-border-base rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap ml-auto sm:ml-0"
            >
              {collapsedAccounts.size > 0 ? (
                <>
                  <ChevronsUpDown className="w-3.5 h-3.5" />
                  展开全部
                </>
              ) : (
                <>
                  <ChevronsDownUp className="w-3.5 h-3.5" />
                  收起全部
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* 域名列表展示 */}
      {loadingDomains ? (
        <div className="flex flex-col items-center justify-center py-20 text-content-muted">
          <RefreshCw className="w-8 h-8 animate-spin text-accent mb-2" />
          <span>正在加载 DNSHE 域名...</span>
        </div>
      ) : domainsCount === 0 ? (
        <div className="text-center py-20 border border-dashed border-border-base rounded-xl bg-surface">
          <Globe className="w-12 h-12 text-content-muted mx-auto mb-3" />
          <h3 className="text-lg font-bold text-content-secondary">未找到域名记录</h3>
          <p className="text-content-muted text-sm mt-1 max-w-md mx-auto">
            {selectedAccountFilter !== "all"
              ? "当前选中账号下没有绑定任何域名。"
              : "尚未绑定账号或本地缓存中没有域名。请前往「账号管理」添加 API 密钥，然后点击本页右上角「同步域名」。"}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groupedDomains.map((group) => {
            const defaultDomains = group.domains.filter(checkHasDns);
            const externalDomains = group.domains.filter((d) => !checkHasDns(d));

            const isCollapsed = collapsedAccounts.has(group.accountId);

            return (
              <div
                key={group.accountId}
                className={`bg-hovered p-3 sm:p-4 md:p-6 rounded-2xl border border-border-base ${
                  isCollapsed ? "" : "space-y-4 md:space-y-6"
                }`}
              >
                {/* 账号大标题（可点击展开/收起）；收起时去掉分隔线与下边距，保持上下留白对称。
                    展开时头部 sticky 吸顶，域名多时往下滚也能随时点它收起，不必翻回顶部。
                    NOTE: 外层用 div 而非 button —— 右侧的单账号同步按钮不能嵌在 button 内，
                    折叠热区因此收窄为左侧标题那个 button。 */}
                <div
                  className={`w-full flex items-center justify-between gap-2 z-20 ${
                    isCollapsed
                      ? ""
                      : "sticky top-0 bg-transparent border-b border-border-base/50 py-3 backdrop-blur-sm"
                  }`}
                >
                  <button
                    onClick={() => onToggleAccountCollapse(group.accountId)}
                    aria-expanded={!isCollapsed}
                    aria-controls={`account-panel-${group.accountId}`}
                    className={`flex-1 min-w-0 flex items-center text-left transition-opacity ${
                      isCollapsed ? "hover:opacity-80" : ""
                    }`}
                  >
                    <h3 className="text-base md:text-lg font-bold text-content-primary flex items-center gap-2 flex-wrap min-w-0">
                      {isCollapsed ? (
                        <ChevronRight className="w-5 h-5 text-accent shrink-0" />
                      ) : (
                        <ChevronDown className="w-5 h-5 text-accent shrink-0" />
                      )}
                      <Key className="w-4 h-4 text-accent shrink-0" />
                      {group.seq > 0 && (
                        <>
                          <span className="text-emerald-400">账号 {group.seq}</span>
                          <span className="text-content-muted">·</span>
                        </>
                      )}
                      <span className="text-accent-strong dark:text-accent truncate max-w-full">{group.alias}</span>
                      <span className="text-[11px] md:text-xs bg-accent-soft text-accent border border-accent/20 px-2 md:px-2.5 py-0.5 rounded-full font-normal">
                        共 {group.domains.length} 个域名（系统默认: {defaultDomains.length} | 外部DNS: {externalDomains.length}）
                      </span>
                    </h3>
                  </button>
                  {/* 单账号同步：只拉这一个账号的域名，避开全量同步的 Worker 子请求上限。
                      seq === 0 是已解绑账号遗留的历史域名，账号已不存在，同步按钮不给出。 */}
                  {group.seq > 0 && (
                    <button
                      onClick={() => onSyncAccount(group.accountId, "dnshe")}
                      disabled={actionLoading === `sync-account-${group.accountId}`}
                      className="p-2 rounded-lg text-content-muted hover:text-sky-500 hover:bg-surface transition-colors disabled:opacity-50 shrink-0"
                      title="仅同步该账号的域名"
                    >
                      <RefreshCw
                        className={`w-4 h-4 ${
                          actionLoading === `sync-account-${group.accountId}` ? "animate-spin" : ""
                        }`}
                      />
                    </button>
                  )}
                </div>

                {/* 域名内容区（收起时隐藏） */}
                {!isCollapsed && (
                <div id={`account-panel-${group.accountId}`}>
                {/* 子分块 1：系统默认 DNS 域名 */}
                {defaultDomains.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-sm font-bold text-content-secondary">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block shrink-0" />
                      <span>系统默认 DNS 域名 ({defaultDomains.length})</span>
                      <span className="hidden sm:inline text-xs text-content-muted font-normal">—— 支持直接在线管理 DNS 解析记录</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 md:gap-6">
                      {defaultDomains.map(renderDomainCard)}
                    </div>
                  </div>
                )}

                {/* 子分块 2：外部 DNS 委派域名 */}
                {externalDomains.length > 0 && (
                  <div className="space-y-3 pt-2">
                    <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-sm font-bold text-content-secondary">
                      <span className="w-2.5 h-2.5 rounded-full bg-sky-400 inline-block shrink-0" />
                      <span>外部 DNS 委派域名 ({externalDomains.length})</span>
                      <span className="hidden sm:inline text-xs text-content-muted font-normal">—— 已托管至 Cloudflare 等第三方服务商</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 md:gap-6">
                      {externalDomains.map(renderDomainCard)}
                    </div>
                  </div>
                )}
                </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
