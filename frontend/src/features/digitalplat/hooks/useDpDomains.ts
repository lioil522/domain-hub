import { useMemo, useState } from "react";
import { useAppData } from "../../../state/AppDataContext";
import { finishSyncAction, type WaitForAccountDomainSync } from "../../../lib/sync-action";
import { domainsApi } from "../../../api/endpoints/domains";
import { readSessionToken } from "../../../api/client";
import type { Account } from "../../../types/account";
import type { Domain } from "../../../types/domain";

/** `useDpDomains` 的外部依赖 —— 由 `App.tsx` 注入 */
export interface UseDpDomainsOptions {
  /** 动作级 loading 标记（App 的 `actionLoading` setter） */
  setActionLoading: (v: string | null) => void;
  /** 等待账号域名在后端落库后再刷新（App 的 `waitForAccountDomainSync`，换 Key 时用） */
  waitForAccountDomainSync: WaitForAccountDomainSync;
}

/**
 * DigitalPlat 域名的列表状态、账号筛选、折叠、分组与同步动作
 *
 * 从 `App.tsx` 抽出；保留页面状态与路由，同步结果由 Action 确认。
 *
 * 内容：
 *   - `dpDomains` / `loadingDpDomains` / `dpAccountFilter` 状态
 *   - `dpCollapsedAccounts` 折叠状态（localStorage 持久化）
 *   - `dpAccountList`（从 accounts 过滤）/ `groupedDpDomains`（按账号分组）
 *   - `fetchDpDomains` / `handleDpSyncDomains`
 *   - `dpToggleAccountCollapse` / `dpToggleAllAccounts`
 *
 */
export function useDpDomains({ setActionLoading, waitForAccountDomainSync }: UseDpDomainsOptions) {
  const { apiFetch, showToast, accounts, fetchAccounts } = useAppData();

  // 域名列表与账号筛选
  const [dpDomains, setDpDomains] = useState<Domain[]>([]);
  const [loadingDpDomains, setLoadingDpDomains] = useState(false);
  const [dpAccountFilter, setDpAccountFilter] = useState<string>("all");
  // 域名分组的收起状态（独立持久化键，刷新 / 重开浏览器后保持上次布局）
  const [dpCollapsedAccounts, setDpCollapsedAccounts] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem("DNSHE_DP_COLLAPSED_ACCOUNTS");
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  });

  // 折叠状态落盘
  const persistDpCollapsed = (next: Set<number>) => {
    setDpCollapsedAccounts(next);
    localStorage.setItem("DNSHE_DP_COLLAPSED_ACCOUNTS", JSON.stringify([...next]));
  };

  // DigitalPlat 账号列表
  const dpAccountList = useMemo(
    () => accounts.filter((a) => a.provider === "digitalplat"),
    [accounts]
  );

  // DigitalPlat 域名按账号分组（行为与 CF zones 分组一致）
  const groupedDpDomains = useMemo(() => {
    const groups: Array<{ accountId: number; alias: string; domains: Domain[] }> = [];
    const byId = new Map<number, { accountId: number; alias: string; domains: Domain[] }>();
    dpAccountList.forEach((acc) => {
      if (dpAccountFilter !== "all" && String(acc.id) !== dpAccountFilter) return;
      const group = { accountId: acc.id, alias: acc.alias, domains: [] as Domain[] };
      byId.set(acc.id, group);
      groups.push(group);
    });
    dpDomains.forEach((d) => {
      const group = byId.get(d.account_id);
      if (group) group.domains.push(d);
    });
    return groups;
  }, [dpAccountList, dpDomains, dpAccountFilter]);

  // 2.4.1 获取 DigitalPlat 账号的域名列表（后端默认排除这些行，需显式传 provider）
  const fetchDpDomains = async (accountIdFilter?: string) => {
    setLoadingDpDomains(true);
    try {
      const targetAcc = accountIdFilter ?? dpAccountFilter;
      const accParam = targetAcc && targetAcc !== "all" ? `&account_id=${targetAcc}` : "";
      const res = await apiFetch(`/api/domains?provider=digitalplat${accParam}`);
      const data = await res.json();
      if (data.success) {
        setDpDomains(data.domains || []);
      } else {
        showToast("error", data.message || "拉取 DigitalPlat 域名失败");
      }
    } catch (e) {
      showToast("error", "网络连接异常，无法获取 DigitalPlat 域名");
    } finally {
      setLoadingDpDomains(false);
    }
  };

  // 手动同步 DigitalPlat 账号的域名列表
  //
  // NOTE: 走 provider 级接口而不是 /api/domains/sync —— 后者是全量同步所有账号，
  // 在 DP 页点它会连带同步 DNSHE / CF，语义不符。
  const handleDpSyncDomains = async () => {
    setActionLoading("dp-sync");
    const session = readSessionToken();
    try {
      const data = await domainsApi.syncProvider(apiFetch, "digitalplat");
      await finishSyncAction(apiFetch, data, fetchDpDomains, showToast, session);
    } catch (e) {
      showToast("error", "同步请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 展开/收起 DigitalPlat 账号分组
  const dpToggleAccountCollapse = (accountId: number) => {
    const next = new Set(dpCollapsedAccounts);
    if (next.has(accountId)) next.delete(accountId);
    else next.add(accountId);
    persistDpCollapsed(next);
  };

  const dpToggleAllAccounts = () => {
    if (dpCollapsedAccounts.size > 0) {
      persistDpCollapsed(new Set());
    } else {
      persistDpCollapsed(new Set(groupedDpDomains.map((g) => g.accountId)));
    }
  };

  // 编辑 DigitalPlat 账号（换 Key / 改别名）
  const [dpEditingAccount, setDpEditingAccount] = useState<Account | null>(null);

  // 解绑 DigitalPlat 账号
  const handleDpDeleteAccount = async (acc: Account) => {
    if (!confirm(`确定要解绑 DigitalPlat 账号 [${acc.alias}] 吗？其名下的域名缓存将被级联清理。`)) return;
    setActionLoading(`dp-delete-account-${acc.id}`);
    try {
      const res = await apiFetch(`/api/accounts/${acc.id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        showToast("success", `已解绑账号 [${acc.alias}]`);
        await fetchAccounts();
        await fetchDpDomains();
      } else {
        showToast("error", data.message || "解绑失败");
      }
    } catch (e) {
      showToast("error", "解绑请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  const handleDpUpdateAccount = async (fields: { alias: string; primary: string; secondary: string }) => {
    const { alias: dpEditAlias, secondary: dpEditKey } = fields;
    if (!dpEditingAccount) return;
    setActionLoading(`dp-update-account-${dpEditingAccount.id}`);
    const session = readSessionToken();
    try {
      const res = await apiFetch(`/api/accounts/${dpEditingAccount.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: dpEditAlias.trim(), api_token: dpEditKey.trim() || undefined })
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", "DigitalPlat 账号已更新");
        const accountId = dpEditingAccount.id;
        setDpEditingAccount(null);
        await fetchAccounts();
        if (dpEditKey.trim()) {
          // 换了 Key：等后台重新同步完成后刷新
          await waitForAccountDomainSync([accountId], "Key 已更新", data.actionId, () => "digitalplat", session, data.syncWarning);
        } else {
          await fetchDpDomains();
        }
      } else {
        showToast("error", data.message || "更新失败");
      }
    } catch (e) {
      showToast("error", "更新请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  return {
    dpDomains,
    loadingDpDomains,
    dpAccountFilter,
    setDpAccountFilter,
    dpCollapsedAccounts,
    persistDpCollapsed,
    dpAccountList,
    groupedDpDomains,
    fetchDpDomains,
    handleDpSyncDomains,
    dpToggleAccountCollapse,
    dpToggleAllAccounts,
    dpEditingAccount,
    setDpEditingAccount,
    handleDpDeleteAccount,
    handleDpUpdateAccount,
  };
}
