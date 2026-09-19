import { useState } from "react";
import { toUnicode } from "../../../punycode";
import { useAppData } from "../../../state/AppDataContext";
import { domainsApi } from "../../../api/endpoints/domains";
import type { Domain } from "../../../types/domain";

/** `useDomainActions` 的外部依赖 —— 均由 `App.tsx` 注入 */
export interface UseDomainActionsOptions {
  /** 动作级 loading 标记（App 的 `actionLoading` setter） */
  setActionLoading: (v: string | null) => void;
  /** 删除/续期成功后刷新 DNSHE 域名列表（App 的 `fetchDomains`） */
  refreshDomains: () => void;
  /** DigitalPlat 删除后刷新 DP 页数据与侧栏计数（App 的 `fetchDpDomains`） */
  refreshDpDomains: () => void;
}

/**
 * DNSHE 域名行的「续期 / 删除」动作 + 删除确认弹窗状态
 *
 * 从 `App.tsx` 抽出（Phase 4-I）。**纯搬运**：接口路径、请求体、loading 键、
 * toast 文案与错误分支逐字保留。
 *
 * 为什么 `apiFetch` / `showToast` 走 `useAppData()` 而不是 props：二者是
 * Provider 级横切能力，App 自身也是从 Context 取的；hook 直接消费可少两个 prop，
 * 且与 `App` 内部调用点保持同一份实例。
 *
 * NOTE: `handleDeleteDnsRecord`（DNS 记录删除）**不在此 hook** —— 它默认参数读
 * `selectedDomain`、成功分支要递增 `dnsRefreshToken`，横跨 DNS 弹窗状态，
 * 留在 App 内更清晰。
 */
export function useDomainActions({
  setActionLoading,
  refreshDomains,
  refreshDpDomains,
}: UseDomainActionsOptions) {
  const { apiFetch, showToast } = useAppData();

  // 域名删除确认状态（删除不可逆，必须输入完整域名二次确认）
  const [deleteModalDomain, setDeleteModalDomain] = useState<Domain | null>(null);

  // 手动续期子域名
  const handleRenewDomain = async (domain: Domain) => {
    setActionLoading(`renew-${domain.id}`);
    try {
      const data = await domainsApi.renew(apiFetch, domain.id);
      if (data.success) {
        showToast("success", `域名 [${domain.full_domain}] 手动续期成功！新有效期至 ${data.new_expires_at}`);
        refreshDomains();
      } else {
        showToast("error", data.message || "续期请求被拦截或失败，请检查是否处于续期窗口");
      }
    } catch (e) {
      showToast("error", "续期网络请求发生异常");
    } finally {
      setActionLoading(null);
    }
  };

  // 打开删除确认弹窗
  const handleOpenDeleteModal = (domain: Domain) => {
    setDeleteModalDomain(domain);
  };

  // 执行删除域名（不可逆）
  // 执行删除域名（不可逆）；返回错误文案（null 表示成功，弹窗自行关闭）
  const handleDeleteDomain = async (confirmInput: string): Promise<string | null> => {
    if (!deleteModalDomain) return null;
    const dom = deleteModalDomain;

    setActionLoading(`delete-${dom.id}`);
    try {
      const data = await domainsApi.remove(apiFetch, dom.id, { confirm_domain: confirmInput.trim() });
      if (data.success) {
        const isDp = dom.account_provider === "digitalplat";
        showToast("success", isDp
          ? (data.message || `域名 [${toUnicode(dom.full_domain)}] 已提交删除`)
          : `域名 [${toUnicode(dom.full_domain)}] 已删除`);
        setDeleteModalDomain(null);
        refreshDomains();
        // DigitalPlat 删除后行保留为 pendingdelete 徽标，需要刷新 DP 页数据与其侧栏计数
        if (isDp) refreshDpDomains();
        return null;
      }
      // 限制类错误（存在解析记录 / 转赠 / ServerHold / PendingDelete）保留弹窗并就地展示原因
      return data.message || "删除失败";
    } catch (e) {
      return "删除请求发生网络异常";
    } finally {
      setActionLoading(null);
    }
  };

  return {
    deleteModalDomain,
    setDeleteModalDomain,
    handleRenewDomain,
    handleOpenDeleteModal,
    handleDeleteDomain,
  };
}
