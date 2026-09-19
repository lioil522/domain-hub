import type { ReactNode } from "react";
import {
  RefreshCw,
  ChevronsUpDown,
  ChevronsDownUp,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderPlus,
  ExternalLink,
  UserPlus,
  UserCheck,
  Plus,
  Trash2,
  Globe,
} from "lucide-react";
import { CustomSelect } from "../../../components/form/CustomSelect";
import type { Account } from "../../../types/account";
import type { CustomAccount, CustomDomain } from "../../../types/custom";
import type { CustomGroup } from "../hooks/useCustomProviders";
import type { DomainWithDays } from "../hooks/useCustomProviders";

/**
 * 自定义服务商标签页（无 API 的社区公益域名，三层：分组 → 账号 → 域名）
 *
 * 从 `App.tsx` 抽出（Phase 8）。**纯搬运**：DOM 结构、className、文案、可访问性
 * 属性（aria-label / title）与折叠/筛选行为逐字保留，仅做「App 闭包 → props」适配：
 *   - `setCustomNewGroupOpen(true)` → `onOpenNewGroup()`
 *   - 分组 / 账号 / 域名的「打开弹窗」动作 → `onAddAccount(group)` /
 *     `onAddDomain(group, account, editing)`（App 侧仍持有弹窗状态）
 *   - 单卡渲染交给 `renderDomainCard`（App 侧薄适配器，注入 cfZoneFullDomainSet /
 *     gotoCfZone 等跨卡状态）
 *
 * 三态：加载中 → 无分组（引导新建）→ 分组列表（可折叠，含未归属账号的域名块）。
 */
export interface CustomProvidersPageProps {
  /** 分组筛选（"all" 或分组 id 字符串） */
  customGroupFilter: string;
  setCustomGroupFilter: (v: string) => void;
  /** 分组列表（provider === "custom" 的账号） */
  customGroupList: Account[];
  /** 账号总数（用于顶部计数） */
  customAccountCount: number;
  /** 域名总数（用于顶部计数） */
  customDomainCount: number;
  loadingCustomDomains: boolean;
  /** 归组后的分组（含账号与域名） */
  groupedCustomDomains: CustomGroup[];
  /** 已收起的分组 id */
  customCollapsedGroups: Set<number>;
  /** 刷新 */
  onRefresh: () => void;
  /** 展开 / 收起全部分组 */
  onToggleAllGroups: () => void;
  /** 切换单个分组的折叠态 */
  onToggleGroupCollapse: (groupId: number) => void;
  /** 打开「新建分组」弹窗 */
  onOpenNewGroup: () => void;
  /** 打开「添加账号」弹窗 */
  onAddAccount: (group: Account) => void;
  /** 打开「添加 / 编辑域名」弹窗（account 为空 = 直接挂在分组下；editing 有值 = 编辑） */
  onAddDomain: (group: Account, account: CustomAccount | null, editing?: CustomDomain) => void;
  /** 请求删除分组（App 侧弹确认框） */
  onRequestDeleteGroup: (group: Account) => void;
  /** 请求删除账号（App 侧弹确认框） */
  onRequestDeleteAccount: (acc: CustomAccount) => void;
  /** 分组 / 账号下的单个域名卡片（App 侧薄适配器，注入 expiryBadge / cfManaged / 动作） */
  renderDomainCard: (
    groupId: number,
    groupAlias: string,
    account: CustomAccount | null,
    dom: DomainWithDays
  ) => ReactNode;
}

export function CustomProvidersPage(props: CustomProvidersPageProps) {
  const {
    customGroupFilter,
    setCustomGroupFilter,
    customGroupList,
    customAccountCount,
    customDomainCount,
    loadingCustomDomains,
    groupedCustomDomains,
    customCollapsedGroups,
    onRefresh,
    onToggleAllGroups,
    onToggleGroupCollapse,
    onOpenNewGroup,
    onAddAccount,
    onAddDomain,
    onRequestDeleteGroup,
    onRequestDeleteAccount,
    renderDomainCard,
  } = props;

  /** 把分组的 id/alias 包成一个只含这两项的 Account，供弹窗状态下传（与旧内联 cast 等价） */
  const groupAsAccount = (groupId: number, alias: string): Account =>
    ({ id: groupId, alias, api_key: "", created_at: "" } as Account);

  return (
    <div className="space-y-8 pt-5 md:pt-6">
      {/* 顶部：分组筛选与操作按钮 */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 md:gap-4 bg-surface border border-border-base p-3 sm:p-4 rounded-xl">
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3 sm:gap-4 w-full md:w-auto">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-content-secondary flex items-center gap-1.5 whitespace-nowrap flex-shrink-0">
              <Folder className="w-4 h-4 text-emerald-400" /> 选择分组:
            </span>
            <CustomSelect
              value={customGroupFilter}
              onChange={setCustomGroupFilter}
              ariaLabel="选择分组"
              options={[
                { value: "all", label: "全部分组" },
                ...customGroupList.map((g) => ({ value: String(g.id), label: g.alias })),
              ]}
              className="px-3 py-2 rounded-lg text-sm text-content-secondary flex-1 min-w-0 md:flex-none md:min-w-[180px]"
            />
          </div>
          <div className="text-xs text-content-muted font-mono whitespace-nowrap">
            分组: <span className="text-emerald-400 font-bold">{customGroupList.length}</span> |
            账号: <span className="text-sky-400 font-bold">{customAccountCount}</span> |
            域名: <span className="text-accent font-bold">{customDomainCount}</span> 个
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto md:justify-end">
          <button
            onClick={onRefresh}
            disabled={loadingCustomDomains}
            className="px-4 py-2 sm:py-1.5 text-xs font-semibold text-content-secondary hover:text-content-primary bg-elevated hover:bg-hovered border border-border-base rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingCustomDomains ? "animate-spin" : ""}`} />
            刷新
          </button>
          {groupedCustomDomains.length > 0 && (
            <button
              onClick={onToggleAllGroups}
              className="px-3 py-2 sm:py-1.5 text-xs font-semibold text-content-secondary hover:text-content-primary bg-elevated hover:bg-hovered border border-border-base rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap"
            >
              {customCollapsedGroups.size > 0 ? (
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
          <button
            onClick={onOpenNewGroup}
            className="px-4 py-2 sm:py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500 shadow-lg shadow-emerald-900/30 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            新建分组
          </button>
        </div>
      </div>

      {/* 分组 → 账号 → 域名 列表 */}
      {loadingCustomDomains && customDomainCount === 0 && customAccountCount === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-content-muted">
          <RefreshCw className="w-8 h-8 animate-spin text-emerald-500 mb-2" />
          <span>正在加载...</span>
        </div>
      ) : customGroupList.length === 0 ? (
        <div className="text-center py-20 border border-dashed border-border-base rounded-xl bg-surface">
          <Folder className="w-12 h-12 text-content-muted mx-auto mb-3" />
          <h3 className="text-lg font-bold text-content-secondary">还没有自定义服务商分组</h3>
          <p className="text-content-muted text-sm mt-1 max-w-md mx-auto">
            社区公益域名（如 eu.org、pp.ua 等）通常没有 API 接口。创建一个分组，在分组下添加账号，再为每个账号录入域名与到期时间，到期前会通过通知渠道提醒你。
          </p>
          <button
            onClick={onOpenNewGroup}
            className="mt-4 px-4 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500 shadow-lg shadow-emerald-900/40 rounded-lg transition-all inline-flex items-center gap-1.5"
          >
            <FolderPlus className="w-3.5 h-3.5" /> 新建分组
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {groupedCustomDomains.map((group) => {
            const isCollapsed = customCollapsedGroups.has(group.groupId);
            return (
              <div
                key={group.groupId}
                className="bg-hovered p-3 sm:p-4 md:p-6 rounded-2xl border border-border-base"
              >
                {/* 分组头部：展开时 sticky 吸顶，域名多时滚下去也能随时收起/操作 */}
                <div className={`flex items-center justify-between gap-3 z-20 ${
                  isCollapsed
                    ? ""
                    : "sticky top-0 bg-transparent border-b border-border-base/50 py-3 backdrop-blur-sm"
                }`}>
                  <button
                    onClick={() => onToggleGroupCollapse(group.groupId)}
                    className={`flex items-center gap-2 transition-opacity text-left min-w-0 flex-1 ${isCollapsed ? "hover:opacity-80" : ""}`}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="w-5 h-5 text-accent shrink-0" />
                    ) : (
                      <ChevronDown className="w-5 h-5 text-accent shrink-0" />
                    )}
                    <Folder className="w-4 h-4 text-accent shrink-0" />
                    <span className="text-base md:text-lg font-bold text-content-primary truncate">{group.alias}</span>
                    {group.website && (
                      <a
                        href={group.website.startsWith("http") ? group.website : `https://${group.website}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        title={`前往官网：${group.website}`}
                        className="inline-flex items-center gap-1 text-[11px] md:text-xs font-medium text-sky-600 dark:text-sky-400 hover:text-sky-500 dark:hover:text-sky-300 flex-shrink-0 px-2 py-0.5 rounded-md border border-sky-200 dark:border-sky-900/60 hover:bg-sky-50 dark:hover:bg-sky-950/40 transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" />
                        官网
                      </a>
                    )}
                    <span className="text-[11px] md:text-xs bg-accent-soft text-accent border border-accent/20 px-2 md:px-2.5 py-0.5 rounded-full font-normal flex-shrink-0">
                      {group.accounts.length} 个账号
                    </span>
                    {/* 域名总数（含未归属账号的）：只看账号数会让「0 个账号但有域名」的分组像是空的 */}
                    <span className="text-[11px] md:text-xs bg-accent-soft text-accent border border-accent/20 px-2 md:px-2.5 py-0.5 rounded-full font-normal flex-shrink-0">
                      {group.domainCount} 个域名
                    </span>
                  </button>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => onAddAccount(groupAsAccount(group.groupId, group.alias))}
                      className="p-1.5 text-content-muted hover:text-accent hover:bg-accent-soft rounded-lg transition-colors"
                      title="添加账号"
                    >
                      <UserPlus className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => onAddDomain(groupAsAccount(group.groupId, group.alias), null)}
                      className="p-1.5 text-content-muted hover:text-accent hover:bg-accent-soft rounded-lg transition-colors"
                      title="直接添加域名（不挂账号）"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => onRequestDeleteGroup(groupAsAccount(group.groupId, group.alias))}
                      className="p-1.5 text-content-muted hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg transition-colors"
                      title="删除分组"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {!isCollapsed && (
                  <div className="space-y-4 mt-4">
                    {/* 直接挂在分组下的域名（无账号） */}
                    {group.unassignedDomains.length > 0 && (
                      <div className="bg-surface border border-border-base rounded-xl p-3 sm:p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <Globe className="w-4 h-4 text-accent shrink-0" />
                          <span className="text-sm font-semibold text-content-primary">分组域名（未归属账号）</span>
                          <span className="text-[11px] bg-accent-soft text-accent border border-accent/20 px-2 py-0.5 rounded-full font-normal flex-shrink-0">
                            {group.unassignedDomains.length} 个
                          </span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                          {group.unassignedDomains.map((dom) =>
                            renderDomainCard(group.groupId, group.alias, null, dom)
                          )}
                        </div>
                      </div>
                    )}

                    {/* 各账号及其域名 */}
                    {group.accounts.map((acc) => (
                      <div key={acc.id} className="bg-surface border border-border-base rounded-xl p-3 sm:p-4">
                        <div className="flex items-center justify-between gap-3 mb-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <UserCheck className="w-4 h-4 text-sky-400 shrink-0" />
                            <span className="text-sm font-semibold text-content-primary truncate">{acc.name}</span>
                            <span className="text-[11px] bg-sky-50 text-sky-700 border border-sky-200 dark:bg-sky-950/80 dark:text-sky-300 dark:border-sky-900/60 px-2 py-0.5 rounded-full font-normal flex-shrink-0">
                              {acc.domains.length} 个域名
                            </span>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={() => onAddDomain(groupAsAccount(acc.group_id, ""), acc)}
                              className="p-1.5 text-content-muted hover:text-accent hover:bg-accent-soft rounded-lg transition-colors"
                              title="添加域名"
                            >
                              <Plus className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => onRequestDeleteAccount(acc)}
                              className="p-1.5 text-content-muted hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg transition-colors"
                              title="删除账号"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>

                        {acc.domains.length === 0 ? (
                          <div className="text-center py-4 text-content-muted text-xs">
                            该账号下还没有域名，点击「+」添加。
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            {acc.domains.map((dom) =>
                              renderDomainCard(acc.group_id, "", acc, dom)
                            )}
                          </div>
                        )}
                      </div>
                    ))}

                    {/* 空状态 */}
                    {group.unassignedDomains.length === 0 && group.accounts.length === 0 && (
                      <div className="text-center py-8 text-content-muted text-sm">
                        该分组下还没有内容。点击右上角「账号」图标添加账号，或「+」图标直接添加域名。
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
