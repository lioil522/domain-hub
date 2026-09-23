import type { ReactNode } from "react";
import {
  UserCheck,
  RefreshCw,
  ChevronsUpDown,
  ChevronsDownUp,
  ChevronRight,
  ChevronDown,
  Cloud,
  Key,
  Plus,
} from "lucide-react";
import { CustomSelect } from "../../../components/form/CustomSelect";
import { CloudflareIcon } from "../../../components/icons/CloudflareIcon";
import type { Account } from "../../../types/account";
import type { Domain } from "../../../types/domain";

/**
 * Cloudflare 标签页（zone 列表页）
 *
 * 从 `App.tsx` 抽出（Phase 5-4c）。**纯搬运**：DOM 结构、className、文案与
 * 折叠/筛选行为逐字保留，仅做「App 闭包 → props」的适配：
 *   - `setActiveTab("accounts")` → `onGotoAccounts()`
 *   - 单卡渲染交给 `renderCfZoneCard`（仍由 App 提供的薄适配器，
 *     因为它依赖跨卡片的 cfHighlightZoneId / cfZoneDateInfo / 四个跳转回调）
 *
 * 页面三态：加载中 → 未绑定账号 → 按账号分组的 zone 卡片网格。
 */
export interface CfZonesPageProps {
  /** 账号筛选（"all" 或账号 id 字符串） */
  cfAccountFilter: string;
  setCfAccountFilter: (v: string) => void;
  /** 已绑定的 Cloudflare 账号 */
  cfAccountList: Account[];
  /** 当前筛选下的 zones */
  cfZones: Domain[];
  loadingCfZones: boolean;
  /** 动作级 loading 标记 */
  actionLoading: string | null;
  /** 打开「添加域名」弹窗（可指定预选账号 ID） */
  onAddDomain?: (accountId?: number) => void;
  /** 全量同步 zones */
  handleCfSyncZones: () => void;
  /** 展开 / 收起全部分组 */
  cfToggleAllAccounts: () => void;
  /** 已收起的分组账号 id */
  cfCollapsedAccounts: Set<number>;
  /** 按账号分组后的 zones */
  groupedCfZones: Array<{ accountId: number; alias: string; zones: Domain[] }>;
  /** 切换单个分组的折叠态 */
  cfToggleAccountCollapse: (accountId: number) => void;
  /** 同步单个账号（provider = "cloudflare"） */
  handleSyncAccount: (accountId: number, provider?: string) => Promise<void>;
  /** 拉取 zones（可传账号筛选） */
  fetchCfZones: (accountIdFilter?: string) => Promise<void>;
  /** 单个 zone 卡片（App 侧薄适配器，注入跨卡片状态与跳转回调） */
  renderCfZoneCard: (zone: Domain) => ReactNode;
  /** 跳到「账号管理」标签页 */
  onGotoAccounts: () => void;
}

export function CfZonesPage(props: CfZonesPageProps) {
  const {
    cfAccountFilter,
    setCfAccountFilter,
    cfAccountList,
    cfZones,
    loadingCfZones,
    actionLoading,
    onAddDomain,
    handleCfSyncZones,
    cfToggleAllAccounts,
    cfCollapsedAccounts,
    groupedCfZones,
    cfToggleAccountCollapse,
    handleSyncAccount,
    fetchCfZones,
    renderCfZoneCard,
    onGotoAccounts,
  } = props;

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
              value={cfAccountFilter}
              onChange={(v) => {
                setCfAccountFilter(v);
                fetchCfZones(v);
              }}
              ariaLabel="选择 Cloudflare 账号"
              options={[
                { value: "all", label: "全部 Cloudflare 账号" },
                ...cfAccountList.map((acc) => ({ value: String(acc.id), label: `账号: ${acc.alias}` })),
              ]}
              className="px-3 py-2 rounded-lg text-sm text-content-secondary flex-1 min-w-0 md:flex-none md:min-w-[180px]"
            />
          </div>
          <div className="text-xs text-content-muted font-mono whitespace-nowrap">
            已绑定账号: <span className="text-accent font-bold">{cfAccountList.length}</span> |
            托管 zones: <span className="text-emerald-400 font-bold">{cfZones.length}</span> 个
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto md:justify-end">

          <button
            onClick={handleCfSyncZones}
            disabled={cfAccountList.length === 0 || actionLoading === "cf-sync"}
            className="px-4 py-2 sm:py-1.5 text-xs font-semibold bg-accent-gradient hover:shadow-accent rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${actionLoading === "cf-sync" ? "animate-spin" : ""}`} />
            同步域名
          </button>
          {cfZones.length > 0 && (
            <button
              onClick={cfToggleAllAccounts}
              className="px-3 py-2 sm:py-1.5 text-xs font-semibold text-content-secondary hover:text-content-primary bg-elevated hover:bg-hovered border border-border-base rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap"
            >
              {cfCollapsedAccounts.size > 0 ? (
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

      {/* zones 列表（按账号分组） */}
      {loadingCfZones && cfZones.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-content-muted">
          <RefreshCw className="w-8 h-8 animate-spin text-accent mb-2" />
          <span>正在加载 Cloudflare zones...</span>
        </div>
      ) : cfAccountList.length === 0 ? (
        <div className="text-center py-20 border border-dashed border-border-base rounded-xl bg-surface">
          <Cloud className="w-12 h-12 text-content-muted mx-auto mb-3" />
          <h3 className="text-lg font-bold text-content-secondary">尚未绑定 Cloudflare 账号</h3>
          <p className="text-content-muted text-sm mt-1 max-w-md mx-auto">
            请前往「账号管理」使用 API Token（需 Zone.Read 与 Zone DNS Edit 权限）绑定，绑定后在这里管理 zones 与解析记录。
          </p>
          <button
            onClick={() => onGotoAccounts()}
            className="mt-4 px-4 py-2 text-xs font-semibold bg-accent-gradient hover:shadow-accent rounded-lg transition-all inline-flex items-center gap-1.5"
          >
            <Key className="w-3.5 h-3.5" /> 前往账号管理
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {groupedCfZones.map((group) => {
            const isCollapsed = cfCollapsedAccounts.has(group.accountId);
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
                    isCollapsed
                      ? ""
                      : "sticky top-0 bg-transparent border-b border-border-base/50 py-3 backdrop-blur-sm"
                  }`}
                >
                  <button
                    onClick={() => cfToggleAccountCollapse(group.accountId)}
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
                      <CloudflareIcon className="w-4 h-4 shrink-0" />
                      <span className="text-accent-strong dark:text-accent truncate max-w-full">{group.alias}</span>
                      <span className="text-[11px] md:text-xs bg-accent-soft text-accent border border-accent/20 px-2 md:px-2.5 py-0.5 rounded-full font-normal">
                        {group.zones.length} 个 zone
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
                    {/* 单账号同步：只拉这一个账号的 zones，避开全量同步的 Worker 子请求上限 */}
                    <button
                      onClick={() => handleSyncAccount(group.accountId, "cloudflare")}
                      disabled={actionLoading === `sync-account-${group.accountId}`}
                      className="p-2 rounded-lg text-content-muted hover:text-accent hover:bg-surface transition-colors disabled:opacity-50 shrink-0"
                      title="仅同步该账号的 zones"
                    >
                      <RefreshCw
                        className={`w-4 h-4 ${
                          actionLoading === `sync-account-${group.accountId}` ? "animate-spin" : ""
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {!isCollapsed && (
                  group.zones.length === 0 ? (
                    <div className="text-center py-8 text-content-muted text-sm">
                      该账号下暂无 zone 数据，点击右上角「同步 zones」从 Cloudflare 拉取。
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 md:gap-6">
                      {group.zones.map(renderCfZoneCard)}
                    </div>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
