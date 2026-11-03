import { useMemo, useState } from "react";
import { useAppData } from "../../../state/AppDataContext";
import { sleep } from "../../../lib/utils";
import type { Account } from "../../../types/account";
import type { Domain } from "../../../types/domain";

/** `useDpDomains` 的外部依赖 —— 由 `App.tsx` 注入 */
export interface UseDpDomainsOptions {
  /** 动作级 loading 标记（App 的 `actionLoading` setter） */
  setActionLoading: (v: string | null) => void;
  /** 账号域名指纹查询（App 的 `readAccountDomainFingerprint`，供同步等待比对用） */
  readAccountDomainFingerprint: (accountId: number, provider?: string) => Promise<string | null>;
  /** 等待账号域名在后端落库后再刷新（App 的 `waitForAccountDomainSync`，换 Key 时用） */
  waitForAccountDomainSync: (
    accountIds: number[],
    label: string,
    baseline?: Map<number, string>,
    providerLookup?: (id: number) => string | undefined
  ) => Promise<void>;
}

/**
 * DigitalPlat 域名的列表状态、账号筛选、折叠、分组与同步动作
 *
 * 从 `App.tsx` 抽出（Phase 6-2），结构与 `useCfZones` 同构。**纯搬运**：
 * 请求路径、loading 键、本地存储键、指纹比对逻辑与全部注释逐字保留。
 *
 * 内容：
 *   - `dpDomains` / `loadingDpDomains` / `dpAccountFilter` 状态
 *   - `dpCollapsedAccounts` 折叠状态（localStorage 持久化）
 *   - `dpAccountList`（从 accounts 过滤）/ `groupedDpDomains`（按账号分组）
 *   - `fetchDpDomains` / `handleDpSyncDomains`
 *   - `dpToggleAccountCollapse` / `dpToggleAllAccounts`
 *
 * NOTE: 与 `useCfZones` 不同，`readAccountDomainFingerprint` 由 App 注入而非私有复制，
 * 避免出现第三份拷贝（遵守「禁止重复实现」）。DP 账号的删/改（handleDpDeleteAccount /
 * handleDpUpdateAccount）仍留在 App（账号管理域，Phase 6-3 再收）。
 */
export function useDpDomains({ setActionLoading, readAccountDomainFingerprint, waitForAccountDomainSync }: UseDpDomainsOptions) {
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
    try {
      const res = await apiFetch("/api/providers/digitalplat/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (!data.success) {
        showToast("error", data.message || "同步任务启动失败");
        return;
      }

      showToast("info", "同步任务已启动，域名落库后自动刷新…");

      // 以当前各账号的域名指纹为基线，落库后自动刷新（与 Cloudflare 页的等待逻辑同构）
      const accStats = new Map<number, { count: number; newest: string }>();
      dpDomains.forEach((d) => {
        const cur = accStats.get(d.account_id) || { count: 0, newest: "" };
        cur.count += 1;
        const updated = String((d as unknown as { updated_at?: string }).updated_at || "");
        if (updated > cur.newest) cur.newest = updated;
        accStats.set(d.account_id, cur);
      });
      const baseline = new Map<number, string>();
      accStats.forEach((v, k) => baseline.set(k, `${v.count}:${v.newest}`));
      const accountIds = (dpAccountList.length > 0
        ? dpAccountList.map((a) => a.id)
        : Array.from(baseline.keys()));
      const deadline = Date.now() + 10_000 + accountIds.length * 5_000;
      const pending = new Set(accountIds);

      while (pending.size > 0 && Date.now() < deadline) {
        await sleep(1500);
        for (const id of [...pending]) {
          const fingerprint = await readAccountDomainFingerprint(id, "digitalplat");
          if (fingerprint !== null && fingerprint !== (baseline.get(id) ?? "0:")) {
            pending.delete(id);
          }
        }
      }

      await fetchDpDomains();
      showToast("success", pending.size === 0 ? "域名同步完成" : "同步仍在后台进行，稍后可再次点击刷新");
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
          await waitForAccountDomainSync([accountId], "Key 已更新", undefined, () => "digitalplat");
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
