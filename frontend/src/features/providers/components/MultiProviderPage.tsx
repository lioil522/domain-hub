import type { ReactNode } from "react";
import {
  UserCheck,
  RefreshCw,
  ChevronsUpDown,
  ChevronsDownUp,
  ChevronRight,
  ChevronDown,
  Globe,
  Key,
  Plus,
} from "lucide-react";
import { CustomSelect } from "../../../components/form/CustomSelect";
import type { Account } from "../../../types/account";
import type { Domain } from "../../../types/domain";
import type { MultiProviderKey } from "../../../types/provider";
import { MULTI_PROVIDER_META } from "../providerMeta";

/**
 * 新托管商标签页（DNSPod / 阿里云 / 华为云 / Vercel 四家共用）
 *
 * 从 `App.tsx` 的 `renderMultiProviderPage` 抽出（Phase 7-1）。**纯搬运**：DOM
 * 结构、className、文案与折叠/筛选行为逐字保留，仅做「App 闭包 → props」适配：
 *   - `setActiveTab("accounts")` → `onGotoAccounts()`
 *   - 单卡渲染交给 `renderDomainCard`（仍由 App 提供的薄适配器，因为它依赖解析
 *     面板回调等跨卡状态）
 *
 * WHY 仍然是**一个**组件而不是拆成四个页面：四家的结构、交互、数据形态完全
 * 一致，差异只有 `MULTI_PROVIDER_META[key]` 里的 label / 配色 / 凭据字段名。
 * 拆成四份后新增字段极易改漏一个页面，故保持 `key` 驱动的表驱动写法 —— 与
 * `MULTI_PROVIDER_ORDER.map(...)` 的调用点天然对齐。
 *
 * 页面三态：加载中 → 未绑定账号 → 按账号分组的域名卡片网格。
 */
export interface MultiProviderPageProps {
  /** 当前托管商 key（决定 label 与数据槽位） */
  providerKey: MultiProviderKey;
  /** 账号筛选（"all" 或账号 id 字符串） */
  accountFilter: string;
  setAccountFilter: (v: string) => void;
  /** 已绑定的该托管商账号 */
  accountList: Account[];
  /** 当前筛选下的域名 */
  domains: Domain[];
  loading: boolean;
  /** 动作级 loading 标记 */
  actionLoading: string | null;
  /** 同步该托管商的全部账号域名 */
  onSyncAll: () => void;
  /** 添加域名回调（可指定预选账号 ID） */
  onAddDomain?: (accountId?: number) => void;
  /** 展开 / 收起全部分组 */
  onToggleAllAccounts: () => void;
  /** 已收起的分组账号 id */
  collapsedAccounts: Set<number>;
  /** 按账号分组后的域名 */
  groupedDomains: Array<{ accountId: number; alias: string; domains: Domain[] }>;
  /** 切换单个分组的折叠态 */
  onToggleAccountCollapse: (accountId: number) => void;
  /** 同步单个账号（provider = 当前 key） */
  onSyncAccount: (accountId: number) => void;
  /** 拉取域名（可传账号筛选） */
  onFetchDomains: (accountIdFilter?: string) => Promise<void>;
  /** 单个域名卡片（App 侧薄适配器） */
  renderDomainCard: (dom: Domain) => ReactNode;
  /** 跳到「账号管理」标签页 */
  onGotoAccounts: () => void;
}

export function MultiProviderPage(props: MultiProviderPageProps) {
  const {
    providerKey,
    accountFilter,
    setAccountFilter,
    accountList,
    domains,
    loading,
    actionLoading,
    onSyncAll,
    onAddDomain,
    onToggleAllAccounts,
    collapsedAccounts,
    groupedDomains,
    onToggleAccountCollapse,
    onSyncAccount,
    onFetchDomains,
    renderDomainCard,
    onGotoAccounts,
  } = props;

  const meta = MULTI_PROVIDER_META[providerKey];

  return (
    <div className="space-y-8 pt-5 md:pt-6">
      {/* 顶部：账号筛选与操作按钮 */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 md:gap-4 bg-surface border border-border-base p-3 sm:p-4 rounded-xl">
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3 sm:gap-4 w-full md:w-auto">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-content-secondary flex items-center gap-1.5 whitespace-nowrap flex-shrink-0">
              <UserCheck className="w-4 h-4 text-accent" /> 选择账号:
            </span>
            <CustomSelect
              value={accountFilter}
              onChange={(v) => {
                setAccountFilter(v);
                void onFetchDomains(v);
              }}
              ariaLabel={`选择 ${meta.label} 账号`}
              options={[
                { value: "all", label: `全部 ${meta.label} 账号` },
                ...accountList.map((acc) => ({ value: String(acc.id), label: `账号: ${acc.alias}` })),
              ]}
              className="px-3 py-2 rounded-lg text-sm text-content-secondary flex-1 min-w-0 md:flex-none md:min-w-[180px]"
            />
          </div>
          <div className="text-xs text-content-muted font-mono whitespace-nowrap">
            已绑定账号: <span className="text-accent font-bold">{accountList.length}</span> |
            域名: <span className="text-emerald-400 font-bold">{domains.length}</span> 个
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto md:justify-end">

          <button
            onClick={onSyncAll}
            disabled={accountList.length === 0 || actionLoading === `multi-sync-${providerKey}`}
            className="px-4 py-2 sm:py-1.5 text-xs font-semibold bg-accent-gradient hover:shadow-accent rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${actionLoading === `multi-sync-${providerKey}` ? "animate-spin" : ""}`}
            />
            同步域名
          </button>
          {domains.length > 0 && (
            <button
              onClick={onToggleAllAccounts}
              className="px-3 py-2 sm:py-1.5 text-xs font-semibold text-content-secondary hover:text-content-primary bg-elevated hover:bg-hovered border border-border-base rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap"
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

      {/* 域名列表（按账号分组） */}
      {loading && domains.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-content-muted">
          <RefreshCw className="w-8 h-8 animate-spin text-accent mb-2" />
          <span>正在加载 {meta.label} 域名...</span>
        </div>
      ) : accountList.length === 0 ? (
        <div className="text-center py-20 border border-dashed border-border-base rounded-xl bg-surface">
          <Globe className="w-12 h-12 text-content-muted mx-auto mb-3" />
          <h3 className="text-lg font-bold text-content-secondary">尚未绑定 {meta.label} 账号</h3>
          <p className="text-content-muted text-sm mt-1 max-w-md mx-auto">
            请前往「账号管理」绑定 {meta.label} 的 API 凭据，绑定后在这里管理域名与解析记录。
          </p>
          <button
            onClick={onGotoAccounts}
            className="mt-4 px-4 py-2 text-xs font-semibold bg-accent-gradient hover:shadow-accent rounded-lg transition-all inline-flex items-center gap-1.5"
          >
            <Key className="w-3.5 h-3.5" /> 前往账号管理
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {groupedDomains.map((group) => {
            const isCollapsed = collapsedAccounts.has(group.accountId);
            return (
              <div
                key={group.accountId}
                className={`bg-hovered p-3 sm:p-4 md:p-6 rounded-2xl border border-border-base ${
                  isCollapsed ? "" : "space-y-4 md:space-y-6"
                }`}
              >
                {/* NOTE: 外层用 div 而非 button —— 右侧的单账号同步按钮不能嵌在 button 内 */}
                <div
                  className={`w-full flex items-center justify-between gap-2 z-20 ${
                    isCollapsed ? "" : "sticky top-0 bg-transparent border-b border-border-base/50 py-3 backdrop-blur-sm"
                  }`}
                >
                  <button
                    onClick={() => onToggleAccountCollapse(group.accountId)}
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
                      <Globe className="w-4 h-4 text-accent shrink-0" />
                      <span className="text-accent-strong dark:text-accent truncate max-w-full">{group.alias}</span>
                      <span className="text-[11px] md:text-xs bg-accent-soft text-accent border border-accent/20 px-2 md:px-2.5 py-0.5 rounded-full font-normal">
                        {group.domains.length} 个域名
                      </span>
                    </h3>
                  </button>
                  <div className="flex items-center gap-1 shrink-0">
                    {onAddDomain && (
                      <button
                        onClick={() => onAddDomain(group.accountId)}
                        className="p-2 rounded-lg text-content-muted hover:text-accent hover:bg-surface transition-colors shrink-0"
                        title="在此账号下添加域名"
                        aria-label="添加域名"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    )}
                    {/* 单账号同步：只拉这一个账号的域名，避开全量同步的子请求上限 */}
                    <button
                      onClick={() => onSyncAccount(group.accountId)}
                      disabled={actionLoading === `sync-account-${group.accountId}`}
                      className="p-2 rounded-lg text-content-muted hover:text-accent hover:bg-surface transition-colors disabled:opacity-50 shrink-0"
                      title="仅同步该账号的域名"
                    >
                      <RefreshCw
                        className={`w-4 h-4 ${
                          actionLoading === `sync-account-${group.accountId}` ? "animate-spin" : ""
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {!isCollapsed &&
                  (group.domains.length === 0 ? (
                    <div className="text-center py-8 text-content-muted text-sm">
                      该账号下暂无域名数据，点击右上角「同步域名」从 {meta.label} 拉取。
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 md:gap-6">
                      {group.domains.map(renderDomainCard)}
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
