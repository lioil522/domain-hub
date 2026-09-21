import type { Account } from "../../../../types/account";
import type { CustomAccount, CustomDomain } from "../../../../types/custom";
import type { ApiFetch } from "../../../../api/client";
import { apiJson } from "../../../../api/request";
import type { UseCustomProvidersStateReturn } from "./useCustomProvidersState";
import type { CustomGroup } from "./types";

export interface UseCustomProvidersActionsOptions {
  state: UseCustomProvidersStateReturn;
  groupedCustomDomains: CustomGroup[];
  apiFetch: ApiFetch;
  showToast: (type: "success" | "error" | "info" | "warning", msg: string) => void;
  fetchAccounts: () => void | Promise<void>;
  isPermanentExpiry: (v?: string | null) => boolean;
}

export function useCustomProvidersActions({ state, groupedCustomDomains, apiFetch, showToast, fetchAccounts, isPermanentExpiry }: UseCustomProvidersActionsOptions) {
  const {
    setCustomAccounts, setCustomDomains, setLoadingCustomDomains, customNewGroupAlias, customNewGroupWebsite, setCustomNewGroupOpen, setCustomNewGroupAlias, setCustomNewGroupWebsite,
    setCustomNewGroupSaving, customBatchRows, setCustomBatchResults, setCustomAccountModalGroup, setCustomAccountName, setCustomAccountModalOpen,
    customAccountModalGroup, customAccountName, setCustomAccountSaving, setCustomDeleteAccount, customDeleteAccount,
    setCustomDomainModalGroup, setCustomDomainModalAccount, setCustomDomainModalEditing, setCustomDomainFull, setCustomDomainRegistered, setCustomDomainExpiry,
    setCustomDomainRemark, setCustomDomainModalOpen, customDomainModalGroup, customDomainModalAccount, customDomainModalEditing, customDomainFull, customDomainExpiry,
    customDomainRegistered, customDomainRemark, setCustomDomainSaving, setCustomDeleteDomain, customDeleteDomain, setCustomDeleteGroup, customDeleteGroup,
    customCollapsedGroups, persistCustomCollapsed, persistCustomCache,
  } = state;

  const fetchCustomDomains = async () => {
    setLoadingCustomDomains(true);
    try {
      const data = await apiJson<{ accounts?: CustomAccount[]; domains?: CustomDomain[] }>(apiFetch, "/api/custom-groups/overview");
      if (!data.success) return;
      const accountsData = Array.isArray(data.accounts) ? data.accounts : [];
      const domainsData = Array.isArray(data.domains) ? data.domains : [];
      setCustomAccounts(accountsData);
      setCustomDomains(domainsData);
      persistCustomCache(accountsData, domainsData);
    } catch {
      // 网络异常：保留当前（可能来自缓存的）数据，不清空列表。
    } finally {
      setLoadingCustomDomains(false);
    }
  };

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
      const data = await apiJson(apiFetch, "/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "custom", alias, website })
      });
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
      const data = await apiJson<{
        results?: Array<{ alias: string; success: boolean; message: string }>;
        success_count?: number;
      }>(apiFetch, "/api/custom-groups/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups })
      });
      if (data.success) {
        setCustomBatchResults(data.results || []);
        const successCount = data.success_count ?? 0;
        if (successCount > 0) {
          showToast("success", data.message || `成功创建 ${successCount} 个分组`);
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
      const data = await apiJson(apiFetch, `/api/custom-groups/${group.id}/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
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
      const data = await apiJson(apiFetch, `/api/custom-groups/${acc.group_id}/accounts/${acc.id}`, { method: "DELETE" });
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
      const data = await apiJson(apiFetch, `/api/custom-groups/${group.id}/domains`, {
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
      const data = await apiJson(apiFetch, `/api/custom-groups/${dom.group_id}/domains/${dom.id}`, { method: "DELETE" });
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
      const data = await apiJson(apiFetch, `/api/accounts/${group.id}`, { method: "DELETE" });
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
    fetchCustomDomains, customToggleGroupCollapse, customToggleAllGroups,
    handleCreateCustomGroup, handleBatchCreateCustomGroups, openCustomAccountModal, handleSaveCustomAccount,
    handleDeleteCustomAccount, openCustomDomainModal, handleSaveCustomDomain, handleDeleteCustomDomain, handleDeleteCustomGroup,
  };
}

export type UseCustomProvidersActionsReturn = ReturnType<typeof useCustomProvidersActions>;
