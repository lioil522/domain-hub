import { useMemo, useState } from "react";
import { useAppData } from "../../../state/AppDataContext";
import type { Account } from "../../../types/account";
import type { Domain } from "../../../types/domain";
import type { MultiProviderKey } from "../../../types/provider";
import { MULTI_PROVIDER_META, MULTI_PROVIDER_ORDER, MULTI_PROVIDER_COLLAPSED_STORAGE } from "../providerMeta";

/** `useMultiProviders` 的外部依赖 —— 由 `App.tsx` 注入 */
export interface UseMultiProvidersOptions {
  /** 动作级 loading 标记（App 的 `actionLoading` setter） */
  setActionLoading: (v: string | null) => void;
  /** 等待账号域名在后端落库后再刷新（App 的 `waitForAccountDomainSync`） */
  waitForAccountDomainSync: (
    accountIds: number[],
    label: string,
    baseline?: Map<number, string>,
    providerLookup?: (id: number) => string | undefined
  ) => Promise<void>;
  /**
   * 同步单个账号（App 的 `handleSyncAccount`，来自 useDomainSync）。
   *
   * NOTE: 由外部注入而非本 hook 内实现 —— `handleSyncAccount` 支持完整的 7 家
   * provider 且同步后按 provider 刷新对应标签页，属于域名同步域的职责；此处只
   * 需要一个「传 key」的薄入口（见 multiSyncOneAccount）。
   */
  handleSyncAccount: (accountId: number, provider?: string) => Promise<void>;
}

/**
 * 四个新托管商（DNSPod / 阿里云 / 华为云 / Vercel）的列表状态与动作
 *
 * 从 `App.tsx` 抽出（Phase 7-2）。**纯搬运**：请求路径、loading 键、本地存储键、
 * 分组与折叠逻辑、全部注释逐字保留。四家共用一套函数 + 以 key 索引的 state 表，
 * 不复制四份。
 *
 * 内容：
 *   - `multiProviderData` / `multiProviderLoading` / `multiProviderFilter` 三张表
 *   - `multiProviderCollapsed` 折叠状态（按 key 独立持久化到 localStorage）
 *   - `multiEditingAccount`（编辑账号弹窗状态）
 *   - `multiProviderAccountLists` / `groupedMultiProviderDomains`（派生）
 *   - `fetchMultiProviderDomains` / `handleMultiProviderSync` / `multiSyncOneAccount`
 *   - `multiToggleAllAccounts` / `multiToggleAccountCollapse`
 *   - `handleMultiUpdateAccount` / `handleMultiDeleteAccount`
 *
 * NOTE: 必须在 `accounts`（AppDataProvider）与 `waitForAccountDomainSync`、
 * `handleSyncAccount` 之后调用；调用点需前置于所有只读消费点（跨来源搜索 /
 * 导航 badge / 页面渲染）。
 */
export function useMultiProviders({
  setActionLoading,
  waitForAccountDomainSync,
  handleSyncAccount,
}: UseMultiProvidersOptions) {
  const { apiFetch, showToast, accounts, fetchAccounts } = useAppData();

  // 四家的域名、加载态、账号筛选、分组折叠态，各以 key 索引成一张表。
  //
  // WHY 不是 4 × 5 个 useState：四家页面的结构、交互、数据形态完全一致，差异只有
  // 显示名、配色与凭据字段名。若各写一套 state（4 份 fetch + 4 份卡片渲染），光是
  // 同步维护就会失控（新增字段时改漏一个页面很常见）。收敛成表后四个页面共用同一
  // 段渲染代码。
  const [multiProviderData, setMultiProviderData] = useState<Record<MultiProviderKey, Domain[]>>({
    dnspod: [],
    alidns: [],
    huaweicloud: [],
    vercel: [],
  });
  const [multiProviderLoading, setMultiProviderLoading] = useState<Record<MultiProviderKey, boolean>>({
    dnspod: false,
    alidns: false,
    huaweicloud: false,
    vercel: false,
  });
  const [multiProviderFilter, setMultiProviderFilter] = useState<Record<MultiProviderKey, string>>({
    dnspod: "all",
    alidns: "all",
    huaweicloud: "all",
    vercel: "all",
  });
  // 各托管商域名分组的收起状态（按 provider 独立持久化，刷新后保持上次布局）
  const [multiProviderCollapsed, setMultiProviderCollapsed] = useState<Record<MultiProviderKey, Set<number>>>(() => {
    const load = (key: string): Set<number> => {
      try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(parsed) ? parsed : []);
      } catch {
        return new Set();
      }
    };
    return {
      dnspod: load(MULTI_PROVIDER_COLLAPSED_STORAGE.dnspod),
      alidns: load(MULTI_PROVIDER_COLLAPSED_STORAGE.alidns),
      huaweicloud: load(MULTI_PROVIDER_COLLAPSED_STORAGE.huaweicloud),
      vercel: load(MULTI_PROVIDER_COLLAPSED_STORAGE.vercel),
    };
  });

  const persistMultiProviderCollapsed = (key: MultiProviderKey, next: Set<number>) => {
    setMultiProviderCollapsed((prev) => ({ ...prev, [key]: next }));
    localStorage.setItem(MULTI_PROVIDER_COLLAPSED_STORAGE[key], JSON.stringify([...next]));
  };

  // 编辑账号（换凭据 / 改别名）
  const [multiEditingAccount, setMultiEditingAccount] = useState<Account | null>(null);

  /** 四家的账号列表（从账号总表过滤，绑定/解绑后随 accounts 一起刷新） */
  const multiProviderAccountLists = useMemo(() => {
    const lists = {} as Record<MultiProviderKey, Account[]>;
    MULTI_PROVIDER_ORDER.forEach((key) => {
      lists[key] = accounts.filter((a) => a.provider === key);
    });
    return lists;
  }, [accounts]);

  /** 按 provider 分组的域名（账号维度归组，行为与 CF / DP 一致） */
  const groupedMultiProviderDomains = useMemo(() => {
    const grouped = {} as Record<
      MultiProviderKey,
      Array<{ accountId: number; alias: string; domains: Domain[] }>
    >;
    MULTI_PROVIDER_ORDER.forEach((key) => {
      const groups: Array<{ accountId: number; alias: string; domains: Domain[] }> = [];
      const byId = new Map<number, { accountId: number; alias: string; domains: Domain[] }>();
      const filter = multiProviderFilter[key];
      multiProviderAccountLists[key].forEach((acc) => {
        if (filter !== "all" && String(acc.id) !== filter) return;
        const group = { accountId: acc.id, alias: acc.alias, domains: [] as Domain[] };
        byId.set(acc.id, group);
        groups.push(group);
      });
      multiProviderData[key].forEach((d) => {
        const group = byId.get(d.account_id);
        if (group) group.domains.push(d);
      });
      grouped[key] = groups;
    });
    return grouped;
  }, [multiProviderAccountLists, multiProviderData, multiProviderFilter]);

  // 2.4.2 获取四个新托管商账号的域名列表（后端默认排除这些行，需显式传 provider）
  //
  // NOTE: 四个页面共用这一个函数 —— 差异只有 provider 参数与显示名，靠 key 索引
  // 到 multiProviderData / multiProviderLoading 的对应槽位。
  const fetchMultiProviderDomains = async (key: MultiProviderKey, accountIdFilter?: string) => {
    const targetAcc = accountIdFilter ?? multiProviderFilter[key];
    const accParam = targetAcc && targetAcc !== "all" ? `&account_id=${targetAcc}` : "";
    setMultiProviderLoading((prev) => ({ ...prev, [key]: true }));
    try {
      const res = await apiFetch(`/api/domains?provider=${key}${accParam}`);
      const data = await res.json();
      if (data.success) {
        setMultiProviderData((prev) => ({ ...prev, [key]: data.domains || [] }));
      } else {
        showToast("error", data.message || `拉取 ${MULTI_PROVIDER_META[key].label} 域名失败`);
      }
    } catch (e) {
      showToast("error", `网络连接异常，无法获取 ${MULTI_PROVIDER_META[key].label} 域名`);
    } finally {
      setMultiProviderLoading((prev) => ({ ...prev, [key]: false }));
    }
  };

  /**
   * 同步某托管商的全部账号域名。
   *
   * WHY 逐账号串行调 /api/accounts/:id/sync：全量同步接口在 Worker 上有子请求上限，
   * 账号一多就会超时截断。逐账号发起后每个请求只处理一个账号，稳定得多；完成后
   * 由 handleSyncAccount 内部按 provider 刷新对应标签页。
   */
  const handleMultiProviderSync = async (key: MultiProviderKey) => {
    const list = multiProviderAccountLists[key];
    if (list.length === 0) {
      showToast("error", `尚未绑定任何 ${MULTI_PROVIDER_META[key].label} 账号`);
      return;
    }
    const loadingKey = `multi-sync-${key}`;
    setActionLoading(loadingKey);
    try {
      for (const acc of list) {
        await apiFetch(`/api/accounts/${acc.id}/sync`, { method: "POST" });
      }
      showToast("success", `已发起 ${list.length} 个 ${MULTI_PROVIDER_META[key].label} 账号的同步`);
      // 等待后端后台同步落库后再刷新列表
      setTimeout(() => fetchMultiProviderDomains(key), 3000);
    } catch (e) {
      showToast("error", `${MULTI_PROVIDER_META[key].label} 同步请求失败`);
    } finally {
      setActionLoading(null);
    }
  };

  /** 展开/收起某托管商的全部账号分组 */
  const multiToggleAllAccounts = (key: MultiProviderKey) => {
    const current = multiProviderCollapsed[key];
    if (current.size > 0) {
      persistMultiProviderCollapsed(key, new Set());
    } else {
      persistMultiProviderCollapsed(
        key,
        new Set(groupedMultiProviderDomains[key].map((g) => g.accountId))
      );
    }
  };

  /** 展开/收起某托管商的单个账号分组 */
  const multiToggleAccountCollapse = (key: MultiProviderKey, accountId: number) => {
    const next = new Set(multiProviderCollapsed[key]);
    if (next.has(accountId)) next.delete(accountId);
    else next.add(accountId);
    persistMultiProviderCollapsed(key, next);
  };

  /**
   * 同步单个账号。区别于 handleSyncAccount 的地方：本函数支持完整的 7 家 provider，
   * 且同步完成后只刷新该 provider 的域名列表（不触发全量刷新）。
   */
  const multiSyncOneAccount = (key: MultiProviderKey, accountId: number) => {
    void handleSyncAccount(accountId, key);
  };

  const handleMultiUpdateAccount = async (
    key: MultiProviderKey,
    fields: { alias: string; primary: string; secondary: string }
  ) => {
    const { alias: multiEditAlias, primary: multiEditPrimary, secondary: multiEditSecondary } = fields;
    if (!multiEditingAccount) return;
    const meta = MULTI_PROVIDER_META[key];
    const primary = meta.singleCredential ? "" : multiEditPrimary.trim();
    const secondary = multiEditSecondary.trim();
    const accountId = multiEditingAccount.id;

    setActionLoading(`multi-update-${accountId}`);
    try {
      const res = await apiFetch(`/api/accounts/${accountId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alias: multiEditAlias.trim(),
          api_key: primary || undefined,
          api_secret: secondary || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", `${meta.label} 账号已更新`);
        setMultiEditingAccount(null);
        await fetchAccounts();
        if (primary || secondary) {
          // 换了凭据：等后台重新同步完成后刷新
          await waitForAccountDomainSync([accountId], "凭据已更新", undefined, () => key);
        } else {
          await fetchMultiProviderDomains(key);
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

  /** 解绑新托管商账号 */
  const handleMultiDeleteAccount = async (key: MultiProviderKey, acc: Account) => {
    const meta = MULTI_PROVIDER_META[key];
    if (!confirm(`确定要解绑 ${meta.label} 账号 [${acc.alias}] 吗？其名下的域名缓存将被级联清理。`)) return;
    setActionLoading(`multi-delete-${acc.id}`);
    try {
      const res = await apiFetch(`/api/accounts/${acc.id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        showToast("success", `已解绑账号 [${acc.alias}]`);
        await fetchAccounts();
        await fetchMultiProviderDomains(key);
      } else {
        showToast("error", data.message || "解绑失败");
      }
    } catch (e) {
      showToast("error", "解绑请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  return {
    multiProviderData,
    multiProviderLoading,
    multiProviderFilter,
    setMultiProviderFilter,
    multiProviderCollapsed,
    multiProviderAccountLists,
    groupedMultiProviderDomains,
    multiEditingAccount,
    setMultiEditingAccount,
    fetchMultiProviderDomains,
    handleMultiProviderSync,
    multiSyncOneAccount,
    multiToggleAllAccounts,
    multiToggleAccountCollapse,
    handleMultiUpdateAccount,
    handleMultiDeleteAccount,
  };
}
