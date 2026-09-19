import { useMemo, useState } from "react";
import { useAppData } from "../../../state/AppDataContext";
import { sleep } from "../../../lib/utils";
import type { Account } from "../../../types/account";
import type { Domain } from "../../../types/domain";

/** `useCfZones` 的外部依赖 —— 由 `App.tsx` 注入 */
export interface UseCfZonesOptions {
  /** 动作级 loading 标记（App 的 `actionLoading` setter） */
  setActionLoading: (v: string | null) => void;
  /** 等待账号域名在后端落库后再刷新（App 的 `waitForAccountDomainSync`） */
  waitForAccountDomainSync: (
    accountIds: number[],
    label: string,
    baseline?: Map<number, string>,
    providerLookup?: (id: number) => string | undefined
  ) => Promise<void>;
}

/**
 * Cloudflare zones 的列表状态、账号筛选、折叠、分组与同步动作
 *
 * 从 `App.tsx` 抽出（Phase 5-2，Cloudflare 第一批「API 与状态」）。**纯搬运**：
 * 请求路径、loading 键、本地存储键、指纹比对逻辑与全部注释逐字保留。
 *
 * 内容：
 *   - `cfZones` / `loadingCfZones` / `cfAccountFilter` 状态
 *   - `cfCollapsedAccounts` 折叠状态（localStorage 持久化）
 *   - `cfAccountList`（从 accounts 过滤）/ `groupedCfZones`（按账号分组）
 *   - `cfEditingAccount`（编辑账号弹窗状态）
 *   - `fetchCfZones` / `handleCfDeleteAccount` / `handleCfSyncZones` / `handleCfUpdateAccount`
 *   - `cfToggleAccountCollapse` / `cfToggleAllAccounts`
 *
 * NOTE: `readAccountDomainFingerprint` 本 hook 内私有实现（仅供 handleCfSyncZones 用）。
 * App 内另有一份同名实现，供 `waitForAccountDomainSync` 与 DP/Multi 同步使用；
 * 二者逻辑一致但服务对象不同，暂不合并（合并会牵动 Multi/DP 的同步流程，超出本批范围）。
 *
 * NOTE: 必须在 `accounts`（AppDataProvider）之后调用；App 侧对 `cfZones` 的
 * 只读消费点很多，均通过解构取得，故调用点需尽量靠前（放在账号域初始化之后）。
 */
export function useCfZones({ setActionLoading, waitForAccountDomainSync }: UseCfZonesOptions) {
  const { apiFetch, showToast, accounts, fetchAccounts } = useAppData();

  // zones 列表与账号筛选
  const [cfZones, setCfZones] = useState<Domain[]>([]);
  const [loadingCfZones, setLoadingCfZones] = useState(false);
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
    return groups;
  }, [cfAccountList, cfZones, cfAccountFilter]);

  // 2.4 获取 Cloudflare 账号的 zone 列表（后端默认排除这些行，需显式传 provider）
  const fetchCfZones = async (accountIdFilter?: string) => {
    setLoadingCfZones(true);
    try {
      const targetAcc = accountIdFilter ?? cfAccountFilter;
      const accParam = targetAcc && targetAcc !== "all" ? `&account_id=${targetAcc}` : "";
      const res = await apiFetch(`/api/domains?provider=cloudflare${accParam}`);
      const data = await res.json();
      if (data.success) {
        setCfZones(data.domains || []);
      } else {
        showToast("error", data.message || "拉取 Cloudflare zones 失败");
      }
    } catch (e) {
      showToast("error", "网络连接异常，无法获取 Cloudflare zones");
    } finally {
      setLoadingCfZones(false);
    }
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

      showToast("info", "同步任务已启动，zones 落库后自动刷新…");

      // 以当前各账号的 zones 指纹为基线，落库后自动刷新（与 DNSHE 域名页的等待逻辑同构）
      const accStats = new Map<number, { count: number; newest: string }>();
      cfZones.forEach((z) => {
        const cur = accStats.get(z.account_id) || { count: 0, newest: "" };
        cur.count += 1;
        const updated = String((z as unknown as { updated_at?: string }).updated_at || "");
        if (updated > cur.newest) cur.newest = updated;
        accStats.set(z.account_id, cur);
      });
      const baseline = new Map<number, string>();
      accStats.forEach((v, k) => baseline.set(k, `${v.count}:${v.newest}`));
      const accountIds = (cfAccountList.length > 0
        ? cfAccountList.map((a) => a.id)
        : Array.from(baseline.keys()));

      const deadline = Date.now() + 10_000 + accountIds.length * 5_000;
      const pending = new Set(accountIds);

      while (pending.size > 0 && Date.now() < deadline) {
        await sleep(1500);
        for (const id of [...pending]) {
          const fingerprint = await readAccountDomainFingerprint(id, "cloudflare");
          if (fingerprint !== null && fingerprint !== (baseline.get(id) ?? "0:")) {
            pending.delete(id);
          }
        }
      }

      await fetchCfZones();
      showToast("success", pending.size === 0 ? "zones 同步完成" : "同步仍在后台进行，稍后可再次点击刷新");
    } catch (e) {
      showToast("error", "同步请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 账号域名指纹：`<条数>:<最新 updated_at>`。
  //
  // NOTE: 后端每个账号的域名是在一次 db.batch 里整批写入的，所以指纹一变
  //       就说明该账号这一轮后台同步已经落库。新绑定账号从「0 条」变为有域名，
  //       换 Key 重新同步则是 updated_at 被刷新，两种场景都能用同一个信号判断。
  const readAccountDomainFingerprint = async (accountId: number, provider?: string): Promise<string | null> => {
    try {
      // 非 DNSHE 托管商的域名默认被 /api/domains 排除（它们在独立标签页展示），
      // 指纹查询必须显式带上 provider，否则永远返回「0 条」，同步等待逻辑会失效
      const isNonDnshe =
        provider === "cloudflare" ||
        provider === "digitalplat" ||
        provider === "dnspod" ||
        provider === "alidns" ||
        provider === "huaweicloud" ||
        provider === "vercel";
      const providerParam = isNonDnshe ? `&provider=${provider}` : "";
      const res = await apiFetch(`/api/domains?account_id=${accountId}${providerParam}`);
      const data = await res.json();
      if (!data.success) return null;
      const list: Array<Record<string, unknown>> = data.domains || [];
      const newest = list.reduce((max, d) => {
        const v = String(d.updated_at || "");
        return v > max ? v : max;
      }, "");
      return `${list.length}:${newest}`;
    } catch (e) {
      return null;
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
          await waitForAccountDomainSync([data.account.id], "Token 已更新", undefined, () => "cloudflare");
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
