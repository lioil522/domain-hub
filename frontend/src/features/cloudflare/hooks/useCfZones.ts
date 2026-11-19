import { useMemo, useState } from "react";
import { useAppData } from "../../../state/AppDataContext";
import { observeSyncAction, type WaitForAccountSync } from "../../domains/utils/sync-action";
import type { Account } from "../../../types/account";
import type { Domain } from "../../../types/domain";
import type { DomainPageSource } from "../../domains/hooks/useDomainCatalog";

/** `useCfZones` 的外部依赖 —— 由 `App.tsx` 注入 */
export interface UseCfZonesOptions {
  page: DomainPageSource;
  /** 动作级 loading 标记（App 的 `actionLoading` setter） */
  setActionLoading: (v: string | null) => void;
  /** 等待账号域名在后端落库后再刷新（App 的 `waitForAccountDomainSync`） */
  waitForAccountDomainSync: WaitForAccountSync;
}

/**
 * Cloudflare zones 的列表状态、账号筛选、折叠、分组与同步动作
 *
 * 从 App 抽出（Phase 5-2），保留账号筛选与本地 UI 状态；
 * 同步等待使用后端操作状态，不再下载域名列表计算完成指纹。
 *
 * 内容：
 *   - `cfZones` / `loadingCfZones` / `cfAccountFilter` 状态
 *   - `cfCollapsedAccounts` 折叠状态（localStorage 持久化）
 *   - `cfAccountList`（从 accounts 过滤）/ `groupedCfZones`（按账号分组）
 *   - `cfEditingAccount`（编辑账号弹窗状态）
 *   - `fetchCfZones` / `handleCfDeleteAccount` / `handleCfSyncZones` / `handleCfUpdateAccount`
 *   - `cfToggleAccountCollapse` / `cfToggleAllAccounts`
 *
 * NOTE: 必须在 `accounts`（AppDataProvider）之后调用；App 侧对 `cfZones` 的
 * 只读消费点很多，均通过解构取得，故调用点需尽量靠前（放在账号域初始化之后）。
 */
export function useCfZones({ setActionLoading, waitForAccountDomainSync, page }: UseCfZonesOptions) {
  const { apiFetch, showToast, accounts, fetchAccounts } = useAppData();

  // zones 列表与账号筛选
  const cfZones = page.domains;
  const loadingCfZones = page.loading;
  const [cfAccountFilter, setCfAccountFilter] = useState<string>("all");

  // zones 分组的收起状态（独立于 DNSHE 域名页的 collapsedAccounts，持久化于本地，
  // 刷新 / 重开浏览器后保持上次布局）
  const [cfCollapsedAccounts, setCfCollapsedAccounts] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem("DNSHE_CF_COLLAPSED_ACCOUNTS");
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  });

  // 折叠状态落盘
  const persistCfCollapsed = (next: Set<number>) => {
    setCfCollapsedAccounts(next);
    localStorage.setItem("DNSHE_CF_COLLAPSED_ACCOUNTS", JSON.stringify([...next]));
  };

  // 编辑 Cloudflare 账号（换 Token / 改别名）
  const [cfEditingAccount, setCfEditingAccount] = useState<Account | null>(null);

  // Cloudflare 账号列表（从账号列表中过滤，绑定/解绑后随 accounts 一起刷新）
  const cfAccountList = useMemo(
    () => accounts.filter((a) => a.provider === "cloudflare"),
    [accounts]
  );

  // CF zones 按账号分组。选择特定账号时只生成该账号的分组（其余隐藏，与域名列表页
  // 的账号筛选行为一致）；选中的账号若还没有 zone 数据，保留分组提示用户去同步
  const groupedCfZones = useMemo(() => {
    const groups: Array<{ accountId: number; alias: string; zones: Domain[] }> = [];
    const byId = new Map<number, { accountId: number; alias: string; zones: Domain[] }>();
    cfAccountList.forEach((acc) => {
      if (cfAccountFilter !== "all" && String(acc.id) !== cfAccountFilter) return;
      const group = { accountId: acc.id, alias: acc.alias, zones: [] as Domain[] };
      byId.set(acc.id, group);
      groups.push(group);
    });
    cfZones.forEach((z) => {
      const group = byId.get(z.account_id);
      if (group) group.zones.push(z);
    });
    return groups.filter(group => group.zones.length || cfAccountFilter !== "all" || page.total === 0);
  }, [cfAccountList, cfZones, cfAccountFilter, page.total]);

  // 2.4 获取 Cloudflare 账号的 zone 列表（后端默认排除这些行，需显式传 provider）
  const fetchCfZones = async (accountIdFilter?: string) => {
    await page.refresh(accountIdFilter ?? cfAccountFilter);
  };

  // 解绑 Cloudflare 账号（后端级联清理该账号的 zones 缓存）
  const handleCfDeleteAccount = async (acc: Account) => {
    if (!confirm(`确定要解绑 Cloudflare 账号 [${acc.alias}] 吗？\n其名下的 zones 缓存会被一并清理（不影响 Cloudflare 上的实际数据）。`)) {
      return;
    }
    setActionLoading(`cf-delete-account-${acc.id}`);
    try {
      const res = await apiFetch(`/api/accounts/${acc.id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        showToast("success", "账号已解绑");
        await fetchAccounts();
        await fetchCfZones();
      } else {
        showToast("error", data.message || "解绑失败");
      }
    } catch (e) {
      showToast("error", "解绑请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 手动同步 Cloudflare 账号的 zone 列表
  //
  // NOTE: 走 provider 级接口而不是 /api/domains/sync —— 后者是全量同步所有账号，
  // 在 CF 页点它会连带同步 DNSHE / DP，语义不符且容易撞免费计划的 50 次子请求上限。
  const handleCfSyncZones = async () => {
    setActionLoading("cf-sync");
    try {
      const res = await apiFetch("/api/providers/cloudflare/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (!data.success) {
        showToast("error", data.message || "同步任务启动失败");
        return;
      }

      await observeSyncAction(apiFetch, data.action_id, showToast);
      await fetchCfZones();
    } catch (e) {
      showToast("error", "同步请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  const handleCfUpdateAccount = async (fields: { alias: string; primary: string; secondary: string }) => {
    const { alias: cfEditAlias, secondary: cfEditToken } = fields;
    if (!cfEditingAccount) return;
    setActionLoading(`cf-update-account-${cfEditingAccount.id}`);
    try {
      const body: Record<string, string> = { alias: cfEditAlias.trim() };
      if (cfEditToken.trim()) body.api_token = cfEditToken.trim();
      const res = await apiFetch(`/api/accounts/${cfEditingAccount.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.success) {
        setCfEditingAccount(null);
        await fetchAccounts();
        if (cfEditToken.trim() && data.account?.id) {
          // 换 Token 后重新同步该账号的 zones
          await waitForAccountDomainSync([data.account.id], "Token 已更新", undefined, () => "cloudflare", data.action_id);
        } else {
          await fetchCfZones();
        }
      } else {
        showToast("error", data.message || "更新账号失败");
      }
    } catch (e) {
      showToast("error", "更新账号请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  const cfToggleAccountCollapse = (accountId: number) => {
    const next = new Set(cfCollapsedAccounts);
    if (next.has(accountId)) next.delete(accountId);
    else next.add(accountId);
    persistCfCollapsed(next);
  };

  // 展开/收起全部账号分组（与域名列表页的 toggleAllAccounts 同构：
  // 存在收起的分组 → 全部展开；否则全部收起）
  const cfToggleAllAccounts = () => {
    if (cfCollapsedAccounts.size > 0) {
      persistCfCollapsed(new Set());
    } else {
      persistCfCollapsed(new Set(groupedCfZones.map((g) => g.accountId)));
    }
  };

  return {
    cfZones,
    loadingCfZones,
    cfAccountFilter,
    setCfAccountFilter,
    cfCollapsedAccounts,
    // 供 App 侧 `gotoCfZone`（跨源跳转时展开目标分组）复用同一套落盘逻辑
    persistCfCollapsed,
    cfAccountList,
    groupedCfZones,
    cfEditingAccount,
    setCfEditingAccount,
    fetchCfZones,
    handleCfDeleteAccount,
    handleCfSyncZones,
    handleCfUpdateAccount,
    cfToggleAccountCollapse,
    cfToggleAllAccounts,
  };
}
