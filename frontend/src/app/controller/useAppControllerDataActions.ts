import type { Dispatch, SetStateAction } from "react";
import type { ApiFetch } from "../../api/client";
import type { AppLog } from "../../types/log";
import type { Quota } from "../../types/quota";

interface UseAppControllerDataActionsOptions {
  apiFetch: ApiFetch;
  showToast: (type: "success" | "error" | "warning" | "info", message: string) => void;
  setLoadingQuotas: (value: boolean) => void;
  setQuotas: Dispatch<SetStateAction<Quota[]>>;
  setLoadingLogs: (value: boolean) => void;
  setLogs: Dispatch<SetStateAction<AppLog[]>>;
  setActionLoading: (value: string | null) => void;
}

export function useAppControllerDataActions({
  apiFetch,
  showToast,
  setLoadingQuotas,
  setQuotas,
  setLoadingLogs,
  setLogs,
  setActionLoading,
}: UseAppControllerDataActionsOptions) {
  const fetchQuotas = async (forceRefresh = false) => {
    setLoadingQuotas(true);
    try {
      const res = await apiFetch(`/api/quota${forceRefresh ? "?refresh=1" : ""}`);
      const data = await res.json();
      if (data.success) setQuotas(data.quotas || []);
    } catch {
      showToast("error", "获取账户配额失败");
    } finally {
      setLoadingQuotas(false);
    }
  };

  const fetchLogs = async () => {
    setLoadingLogs(true);
    try {
      const res = await apiFetch("/api/logs");
      const data = await res.json();
      if (data.success) setLogs(data.logs || []);
    } catch {
      showToast("error", "获取系统运行日志失败");
    } finally {
      setLoadingLogs(false);
    }
  };

  const handleClearLogs = async () => {
    if (!confirm("确定要清空所有的运行日志吗？")) return;
    setActionLoading("clear-logs");
    try {
      const res = await apiFetch("/api/logs/clear", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        showToast("success", "系统日志已成功清空");
        void fetchLogs();
      } else {
        showToast("error", data.message || "清空日志失败");
      }
    } catch {
      showToast("error", "清空日志网络请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  return { fetchQuotas, fetchLogs, handleClearLogs };
}
