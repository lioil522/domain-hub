import { useEffect, useMemo, useState } from "react";
import { useAppData } from "../../../state/AppDataContext";
import type { Account } from "../../../types/account";
import type { CustomAccount, CustomDomain } from "../../../types/custom";

/** 分组折叠状态的 localStorage 键（从 App.tsx 内联字符串上收，避免多处硬编码） */
const CUSTOM_CACHE_LS_KEY = "DOMAIN_HUB_CUSTOM_CACHE_V1";
const CUSTOM_COLLAPSED_LS_KEY = "DOMAIN_HUB_CUSTOM_COLLAPSED_GROUPS";

/**
 * 手动域名按「分组 → 账号」归组后的分组结构（含到期天数）
 *
 * `daysLeft` 由 `expires_at` 现算而非随数据落库：它是「相对现在」的量，
 * 缓存一整夜再用缓存渲染就会显示过期天数偏差。
 */
export type DomainWithDays = CustomDomain & { daysLeft: number };
export type AccountWithDomains = CustomAccount & { domains: DomainWithDays[] };
export interface CustomGroup {
  groupId: number;
  alias: string;
  website: string | null;
  /** 直接挂在分组下（account_id 为空）的域名 */
  unassignedDomains: DomainWithDays[];
  accounts: AccountWithDomains[];
  /** 分组下域名总数（各账号 + 未归属账号），分组头部徽标用 */
  domainCount: number;
}

/**
 * 自定义服务商（无 API，三层结构：分组 → 账号 → 域名）的状态与动作
 *
 * 从 `App.tsx` 抽出（Phase 8）。**纯搬运**：请求路径、localStorage 键、表单校验、
 * 分组归组逻辑与全部注释逐字保留。
 *
 * 内容：
 *   - `customGroupFilter` / `customAccounts` / `customDomains` / `loadingCustomDomains`
 *   - `customCollapsedGroups`（localStorage 持久化）
 *   - 新建分组弹窗（单体 / 批量两模式）、账号弹窗、域名弹窗、三个删除确认的全部状态
 *   - `customGroupList` / `groupedCustomDomains`（派生）
 *   - `fetchCustomDomains` 及其余全部增删改动作 + 折叠切换
 *
 * NOTE: `handleSaveCustomDomain` 的「永久」判断依赖调用方传入的 `isPermanentExpiry`
 * （App 侧为该逻辑的既有实现，与 expiryBadge 同源），故通过 options 注入而非在此重复。
 */
export interface UseCustomProvidersOptions {
  /** 判断到期时间是否为「永久」（App 的 `isPermanentExpiry`） */
  isPermanentExpiry: (v?: string | null) => boolean;
}

export function useCustomProviders({ isPermanentExpiry }: UseCustomProvidersOptions) {
  const { apiFetch, showToast, accounts, fetchAccounts } = useAppData();

  // 当前选中的分组筛选（"all" 或分组 id 字符串）
  const [customGroupFilter, setCustomGroupFilter] = useState<string>("all");

  /**
   * 账号 / 域名的本地兜底缓存
   *
   * 手动录入的数据以「天」为单位变化，首屏没必要空着等网络：先把上次的结果秒显出来，
   * 后台再拉最新覆盖。写不进去（隐私模式等）就当没有缓存，不影响功能。
   */
  const readCustomCache = (): { accounts: CustomAccount[]; domains: CustomDomain[] } => {
    try {
      const raw = localStorage.getItem(CUSTOM_CACHE_LS_KEY);
      if (!raw) return { accounts: [], domains: [] };
      const parsed = JSON.parse(raw) as { accounts?: CustomAccount[]; domains?: CustomDomain[] };
      return {
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        domains: Array.isArray(parsed.domains) ? parsed.domains : []
      };
    } catch {
      return { accounts: [], domains: [] };
    }
  };
  const persistCustomCache = (accounts: CustomAccount[], domains: CustomDomain[]) => {
    try {
      localStorage.setItem(CUSTOM_CACHE_LS_KEY, JSON.stringify({ ts: Date.now(), accounts, domains }));
    } catch {
      // 存储不可用：仅本次会话内有数据
    }
  };

  // 账号数据（按 group_id 归组）
  const [customAccounts, setCustomAccounts] = useState<CustomAccount[]>(() => readCustomCache().accounts);
  // 手动域名数据（按 account_id 归组）
  const [customDomains, setCustomDomains] = useState<CustomDomain[]>(() => readCustomCache().domains);
  const [loadingCustomDomains, setLoadingCustomDomains] = useState(false);
  // 分组折叠状态（key = 分组 account id；独立持久化键，刷新 / 重开浏览器后保持上次布局）
  const [customCollapsedGroups, setCustomCollapsedGroups] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem(CUSTOM_COLLAPSED_LS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  });

  // 折叠状态落盘
  const persistCustomCollapsed = (next: Set<number>) => {
    setCustomCollapsedGroups(next);
    try {
      localStorage.setItem(CUSTOM_COLLAPSED_LS_KEY, JSON.stringify([...next]));
    } catch {
      // 隐私模式等存储不可用：只保留本次会话的折叠状态
    }
  };
  // 新建分组弹窗
  const [customNewGroupOpen, setCustomNewGroupOpen] = useState(false);
  const [customNewGroupAlias, setCustomNewGroupAlias] = useState("");
  const [customNewGroupWebsite, setCustomNewGroupWebsite] = useState("");
  const [customNewGroupSaving, setCustomNewGroupSaving] = useState(false);
  // 新建分组模式："single" 单个 / "batch" 批量
  const [customNewGroupMode, setCustomNewGroupMode] = useState<"single" | "batch">("single");
  // 批量创建输入：行列表，每行 { alias 分组名, website 官网 }，点「+」动态增行
  const [customBatchRows, setCustomBatchRows] = useState<Array<{ alias: string; website: string }>>([{ alias: "", website: "" }]);
  // 批量结果回显
  const [customBatchResults, setCustomBatchResults] = useState<Array<{ alias: string; success: boolean; message: string }> | null>(null);
  // 添加/编辑账号弹窗
  const [customAccountModalOpen, setCustomAccountModalOpen] = useState(false);
  const [customAccountModalGroup, setCustomAccountModalGroup] = useState<Account | null>(null);
  const [customAccountName, setCustomAccountName] = useState("");
  const [customAccountSaving, setCustomAccountSaving] = useState(false);
  // 添加/编辑手动域名弹窗
  const [customDomainModalOpen, setCustomDomainModalOpen] = useState(false);
  const [customDomainModalGroup, setCustomDomainModalGroup] = useState<Account | null>(null);
  const [customDomainModalAccount, setCustomDomainModalAccount] = useState<CustomAccount | null>(null);
  const [customDomainModalEditing, setCustomDomainModalEditing] = useState<CustomDomain | null>(null);
  const [customDomainFull, setCustomDomainFull] = useState("");
  const [customDomainRegistered, setCustomDomainRegistered] = useState("");
  const [customDomainExpiry, setCustomDomainExpiry] = useState("");
  const [customDomainRemark, setCustomDomainRemark] = useState("");
  const [customDomainSaving, setCustomDomainSaving] = useState(false);
  // 删除分组确认
  const [customDeleteGroup, setCustomDeleteGroup] = useState<Account | null>(null);
  // 删除账号确认
  const [customDeleteAccount, setCustomDeleteAccount] = useState<CustomAccount | null>(null);
  // 删除域名确认
  const [customDeleteDomain, setCustomDeleteDomain] = useState<CustomDomain | null>(null);

  // 新建分组弹窗每次打开时重置表单（别名、官网、批量行、结果、模式），
  // 避免上次取消/失败残留的内容在下次打开时被误提交。
  useEffect(() => {
    if (!customNewGroupOpen) return;
    setCustomNewGroupAlias("");
    setCustomNewGroupWebsite("");
    setCustomBatchRows([{ alias: "", website: "" }]);
    setCustomBatchResults(null);
    setCustomNewGroupMode("single");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customNewGroupOpen]);

  // 自定义服务商分组列表（provider === "custom"）
  const customGroupList = useMemo(
    () => accounts.filter((a) => a.provider === "custom"),
    [accounts]
  );

  /**
   * 拉取所有自定义分组的账号与域名
   *
   * NOTE: 手动域名全在本地 D1，一次总览接口就能拉齐（见后端 /api/custom-groups/overview）。
   * 早先是「/api/accounts + 每个分组各两个接口」的串行循环，分组一多首屏要等好几秒。
   * 结果同时写入 localStorage，下次进页面先秒显缓存再后台刷新。
   */
  const fetchCustomDomains = async () => {
    setLoadingCustomDomains(true);
    try {
      const res = await apiFetch("/api/custom-groups/overview");
      const data = await res.json();
      if (!data.success) return;
      const accountsData: CustomAccount[] = Array.isArray(data.accounts) ? data.accounts : [];
      const domainsData: CustomDomain[] = Array.isArray(data.domains) ? data.domains : [];
      setCustomAccounts(accountsData);
      setCustomDomains(domainsData);
      persistCustomCache(accountsData, domainsData);
    } catch {
      // 网络异常：保留当前（可能来自缓存的）数据，不清空列表
    } finally {
      setLoadingCustomDomains(false);
    }
  };

  // 手动域名按「分组 → 账号」归组（含到期天数计算）；account_id 为空的域名直接挂在分组下
  const groupedCustomDomains = useMemo(() => {
    const groups: CustomGroup[] = [];
    const groupById = new Map<number, CustomGroup>();
    const accountById = new Map<number, AccountWithDomains>();

    const toDaysLeft = (d: CustomDomain): DomainWithDays => {
      const expiresTime = new Date(d.expires_at).getTime();
      const daysLeft = Number.isNaN(expiresTime) ? 0 : (expiresTime - Date.now()) / (1000 * 60 * 60 * 24);
      return { ...d, daysLeft };
    };

    customGroupList.forEach((g) => {
      if (customGroupFilter !== "all" && String(g.id) !== customGroupFilter) return;
      const group: CustomGroup = {
        groupId: g.id,
        alias: g.alias,
        website: g.website || null,
        unassignedDomains: [],
        accounts: [],
        domainCount: 0
      };
      groupById.set(g.id, group);
      groups.push(group);
    });
    customAccounts.forEach((a) => {
      const group = groupById.get(a.group_id);
      if (!group) return;
      const acc: AccountWithDomains = { ...a, domains: [] };
      accountById.set(a.id, acc);
      group.accounts.push(acc);
    });
    customDomains.forEach((d) => {
      if (d.account_id == null) {
        // 直接挂在分组下
        const group = groupById.get(d.group_id);
        if (!group) return;
        group.unassignedDomains.push(toDaysLeft(d));
        group.domainCount++;
        return;
      }
      const acc = accountById.get(d.account_id);
      if (!acc) return;
      acc.domains.push(toDaysLeft(d));
      const group = groupById.get(acc.group_id);
      if (group) group.domainCount++;
    });
    return groups;
  }, [customGroupList, customAccounts, customDomains, customGroupFilter]);

  // 新建自定义服务商分组（单个）
  const handleCreateCustomGroup = async () => {
    const alias = customNewGroupAlias.trim();
    const website = customNewGroupWebsite.trim();
    if (!alias) {
      showToast("error", "请填写分组名称");
      return;
    }
    // 官网链接：可选，若填写则校验格式（http/https 或裸域名）
    if (website && !/^(https?:\/\/)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+([\/?#].*)?$/i.test(website)) {
      showToast("error", "官网链接格式无效，请输入合法的网址（如 https://example.com）");
      return;
    }
    setCustomNewGroupSaving(true);
    try {
      const res = await apiFetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "custom", alias, website })
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", `分组 [${alias}] 已创建`);
        setCustomNewGroupOpen(false);
        setCustomNewGroupAlias("");
        setCustomNewGroupWebsite("");
        fetchAccounts();
      } else {
        showToast("error", data.message || "创建分组失败");
      }
    } catch {
      showToast("error", "创建分组请求失败，请检查网络");
    } finally {
      setCustomNewGroupSaving(false);
    }
  };

  // 批量创建分组（行列表：每行「分组名 | 官网」，官网可选）
  const handleBatchCreateCustomGroups = async () => {
    // 解析行：只保留填写了分组名的行；官网链接可空
    const groups: Array<{ alias: string; website: string }> = [];
    for (const row of customBatchRows) {
      const alias = row.alias.trim();
      const website = row.website.trim();
      if (!alias) continue;
      // 官网链接格式校验（http/https 或裸域名）
      if (website && !/^(https?:\/\/)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+([\/?#].*)?$/i.test(website)) {
        showToast("error", `分组「${alias}」的官网链接格式无效，请输入合法的网址`);
        return;
      }
      groups.push({ alias, website });
    }
    if (groups.length === 0) {
      showToast("error", "请至少填写一个分组名称");
      return;
    }
    if (groups.length > 50) {
      showToast("error", "单次最多批量创建 50 个分组");
      return;
    }

    setCustomNewGroupSaving(true);
    try {
      const res = await apiFetch("/api/custom-groups/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups })
      });
      const data = await res.json();
      if (data.success) {
        setCustomBatchResults(data.results || []);
        if (data.success_count > 0) {
          showToast("success", data.message || `成功创建 ${data.success_count} 个分组`);
          fetchAccounts();
        } else {
          showToast("error", data.message || "批量创建失败");
        }
      } else {
        showToast("error", data.message || "批量创建失败");
      }
    } catch {
      showToast("error", "批量创建请求失败，请检查网络");
    } finally {
      setCustomNewGroupSaving(false);
    }
  };

  // 打开「添加账号」弹窗
  const openCustomAccountModal = (group: Account) => {
    setCustomAccountModalGroup(group);
    setCustomAccountName("");
    setCustomAccountModalOpen(true);
  };

  // 保存账号（新增）
  const handleSaveCustomAccount = async () => {
    const group = customAccountModalGroup;
    if (!group) return;
    const name = customAccountName.trim();
    if (!name) {
      showToast("error", "请填写账号名称");
      return;
    }
    setCustomAccountSaving(true);
    try {
      const res = await apiFetch(`/api/custom-groups/${group.id}/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", "账号已添加");
        setCustomAccountModalOpen(false);
        setCustomAccountName("");
        fetchCustomDomains();
      } else {
        showToast("error", data.message || "添加账号失败");
      }
    } catch {
      showToast("error", "添加账号请求失败，请检查网络");
    } finally {
      setCustomAccountSaving(false);
    }
  };

  // 删除账号（级联删除其下域名）
  const handleDeleteCustomAccount = async () => {
    const acc = customDeleteAccount;
    if (!acc) return;
    try {
      const res = await apiFetch(`/api/custom-groups/${acc.group_id}/accounts/${acc.id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        showToast("success", "账号已删除");
        setCustomDeleteAccount(null);
        fetchCustomDomains();
      } else {
        showToast("error", data.message || "删除账号失败");
      }
    } catch {
      showToast("error", "删除账号请求失败，请检查网络");
    }
  };

  // 打开「添加域名」弹窗（group 必填；account 可选，为空表示直接挂在分组下）
  const openCustomDomainModal = (group: Account, account: CustomAccount | null, editing?: CustomDomain) => {
    setCustomDomainModalGroup(group);
    setCustomDomainModalAccount(account);
    setCustomDomainModalEditing(editing || null);
    setCustomDomainFull(editing ? editing.full_domain : "");
    setCustomDomainRegistered(editing ? (editing.registered_at || "").slice(0, 10) : "");
    // 永久域名（0000 占位）编辑时到期段回填为空，避免把占位符当成真实日期显示
    setCustomDomainExpiry(
      editing && !isPermanentExpiry(editing.expires_at) ? editing.expires_at.slice(0, 10) : ""
    );
    setCustomDomainRemark(editing ? (editing.remark || "") : "");
    setCustomDomainModalOpen(true);
  };

  // 保存手动域名（新增或更新）。account_id 为空则直接挂在分组下
  const handleSaveCustomDomain = async () => {
    const group = customDomainModalGroup;
    if (!group) return;
    const account = customDomainModalAccount;
    const full = customDomainFull.trim().toLowerCase().replace(/\.$/, "");
    const expiry = customDomainExpiry.trim();
    if (!full) {
      showToast("error", "请填写域名");
      return;
    }
    // 到期时间留空 = 永久（后端存 0000 占位）；不再强制必填
    setCustomDomainSaving(true);
    try {
      const res = await apiFetch(`/api/custom-groups/${group.id}/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // 编辑时带上行 id，后端按 id 原地更新（改域名不会留旧行，未挂账号的域名也不会重复插入）
          id: customDomainModalEditing ? customDomainModalEditing.id : undefined,
          full_domain: full,
          registered_at: customDomainRegistered.trim(),
          expires_at: expiry,
          remark: customDomainRemark,
          account_id: account ? account.id : null
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", customDomainModalEditing ? "域名已更新" : "域名已添加");
        setCustomDomainModalOpen(false);
        fetchCustomDomains();
      } else {
        showToast("error", data.message || "保存域名失败");
      }
    } catch {
      showToast("error", "保存域名请求失败，请检查网络");
    } finally {
      setCustomDomainSaving(false);
    }
  };

  // 删除手动域名
  const handleDeleteCustomDomain = async () => {
    const dom = customDeleteDomain;
    if (!dom) return;
    try {
      const res = await apiFetch(`/api/custom-groups/${dom.group_id}/domains/${dom.id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        showToast("success", "域名已删除");
        setCustomDeleteDomain(null);
        fetchCustomDomains();
      } else {
        showToast("error", data.message || "删除域名失败");
      }
    } catch {
      showToast("error", "删除域名请求失败，请检查网络");
    }
  };

  // 删除自定义服务商分组（复用解绑账号接口，级联删除账号与域名）
  const handleDeleteCustomGroup = async () => {
    const group = customDeleteGroup;
    if (!group) return;
    try {
      const res = await apiFetch(`/api/accounts/${group.id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        showToast("success", `分组 [${group.alias}] 已删除`);
        setCustomDeleteGroup(null);
        fetchAccounts();
        fetchCustomDomains();
      } else {
        showToast("error", data.message || "删除分组失败");
      }
    } catch {
      showToast("error", "删除分组请求失败，请检查网络");
    }
  };

  // 分组折叠
  const customToggleGroupCollapse = (groupId: number) => {
    const next = new Set(customCollapsedGroups);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    persistCustomCollapsed(next);
  };

  // 展开/收起全部分组（与其它标签页的 toggleAllAccounts 同构：
  // 存在收起的分组 → 全部展开；否则全部收起）
  const customToggleAllGroups = () => {
    if (customCollapsedGroups.size > 0) {
      persistCustomCollapsed(new Set());
    } else {
      persistCustomCollapsed(new Set(groupedCustomDomains.map((g) => g.groupId)));
    }
  };

  return {
    // 数据与派生
    customGroupFilter,
    setCustomGroupFilter,
    customGroupList,
    customAccounts,
    customDomains,
    loadingCustomDomains,
    groupedCustomDomains,
    customCollapsedGroups,
    fetchCustomDomains,
    customToggleGroupCollapse,
    customToggleAllGroups,
    // 新建分组弹窗
    customNewGroupOpen,
    setCustomNewGroupOpen,
    customNewGroupAlias,
    setCustomNewGroupAlias,
    customNewGroupWebsite,
    setCustomNewGroupWebsite,
    customNewGroupSaving,
    customNewGroupMode,
    setCustomNewGroupMode,
    customBatchRows,
    setCustomBatchRows,
    customBatchResults,
    setCustomBatchResults,
    handleCreateCustomGroup,
    handleBatchCreateCustomGroups,
    // 账号弹窗
    customAccountModalOpen,
    setCustomAccountModalOpen,
    customAccountModalGroup,
    customAccountName,
    setCustomAccountName,
    customAccountSaving,
    openCustomAccountModal,
    handleSaveCustomAccount,
    // 域名弹窗
    customDomainModalOpen,
    setCustomDomainModalOpen,
    customDomainModalGroup,
    customDomainModalAccount,
    customDomainModalEditing,
    customDomainFull,
    setCustomDomainFull,
    customDomainRegistered,
    setCustomDomainRegistered,
    customDomainExpiry,
    setCustomDomainExpiry,
    customDomainRemark,
    setCustomDomainRemark,
    customDomainSaving,
    openCustomDomainModal,
    handleSaveCustomDomain,
    // 删除确认
    customDeleteGroup,
    setCustomDeleteGroup,
    customDeleteAccount,
    setCustomDeleteAccount,
    customDeleteDomain,
    setCustomDeleteDomain,
    handleDeleteCustomAccount,
    handleDeleteCustomDomain,
    handleDeleteCustomGroup,
  };
}
