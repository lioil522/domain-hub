import { useAppData } from "../../../state/AppDataContext";
import { accountsApi } from "../../../api/endpoints/accounts";
import { domainsApi } from "../../../api/endpoints/domains";

/** `useDomainSync` 的外部依赖 —— 均由 `App.tsx` 注入 */
export interface UseDomainSyncOptions {
  /** 动作级 loading 标记（App 的 `actionLoading` setter） */
  setActionLoading: (v: string | null) => void;
  /** 刷新 DNSHE 域名列表（App 的 `fetchDomains`） */
  refreshDomains: () => void;
  /** 刷新全部服务商（App 的 `refreshAllProviderDomains`） */
  refreshAllProviderDomains: () => void;
  /** 按 provider 刷新对应标签页（App 的 `refreshProviderDomains`） */
  refreshProviderDomains: (provider?: string, accountIdFilter?: string) => void;
}

/**
 * 域名同步动作（全量 / DNSHE / 单账号）
 *
 * 从 `App.tsx` 抽出（Phase 4-J）。**纯搬运**：接口路径、loading 键、延迟刷新
 * 时长（5000 / 5000 / 3000ms）与全部 toast 文案逐字保留。
 *
 * 为什么 `apiFetch` / `showToast` 走 `useAppData()`：Provider 级横切能力，
 * 与 App 内调用点共用同一实例，少两个 prop。
 *
 * NOTE: 三个 refresh 回调刻意不从 Context 取 —— 它们随 `activeTab` / 筛选条件
 * 变化且依赖 App 内状态，作为参数注入语义更清晰，也避免把 App 私有函数塞进 Context。
 */
export function useDomainSync({
  setActionLoading,
  refreshDomains,
  refreshAllProviderDomains,
  refreshProviderDomains,
}: UseDomainSyncOptions) {
  const { apiFetch, showToast } = useAppData();

  /**
   * 全量同步（概览页入口）：跨所有服务商回源，子请求开销最大。
   * 日常只改单个服务商时优先用各自页面上的「同步域名」按钮。
   */
  const handleSyncDomains = async () => {
    setActionLoading("sync-all");
    try {
      const data = await domainsApi.syncAll(apiFetch);
      if (data.success) {
        showToast("success", data.message || "同步域名任务已成功在后台启动");
        setTimeout(() => {
          refreshDomains();
          refreshAllProviderDomains();
        }, 5000);
      } else {
        showToast("error", data.message || "启动同步域名任务失败");
      }
    } catch (e) {
      showToast("error", "发起域名同步网络请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  /**
   * DNSHE 页「同步域名」：只回源 DNSHE 账号，不碰其它服务商。
   *
   * NOTE: 走 /api/providers/dnshe/sync 而非旧的 /api/domains/sync —— 后者是全量回源，
   * 在 DNSHE 页点一下会把其它所有服务商也拉一遍，既慢又白耗子请求配额。
   */
  const handleSyncDnsheDomains = async () => {
    setActionLoading("sync");
    try {
      const data = await domainsApi.syncProvider(apiFetch, "dnshe");
      if (data.success) {
        showToast("success", data.message || "DNSHE 账号同步已在后台启动");
        setTimeout(() => refreshDomains(), 5000);
      } else {
        showToast("error", data.message || "启动 DNSHE 同步失败");
      }
    } catch (e) {
      showToast("error", "发起同步请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  /**
   * 单账号同步：只拉取指定账号的域名，子请求数远小于全量同步
   *
   * NOTE: 同步完成后按 provider 刷新对应标签页的数据（DNSHE → fetchDomains，
   * CF → fetchCfZones，DP → fetchDpDomains），避免用户手动刷新。
   */
  const handleSyncAccount = async (accountId: number, provider?: string) => {
    const loadingKey = `sync-account-${accountId}`;
    setActionLoading(loadingKey);
    try {
      const data = await accountsApi.sync(apiFetch, accountId);
      if (data.success) {
        showToast("success", data.message || "同步已在后台启动");
        // 延迟刷新对应 provider 的域名列表，等待后台同步完成
        setTimeout(() => {
          refreshProviderDomains(provider);
        }, 3000);
      } else {
        showToast("error", data.message || "同步失败");
      }
    } catch (e) {
      showToast("error", "发起同步请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  return { handleSyncDomains, handleSyncDnsheDomains, handleSyncAccount };
}
