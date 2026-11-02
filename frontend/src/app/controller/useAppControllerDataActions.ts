import type { Dispatch, SetStateAction } from "react";
import type { ApiFetch } from "../../api/client";
import type { AppLog } from "../../types/log";
import type { Quota } from "../../types/quota";
import { useLogFeed } from "../../features/logs/hooks/useLogFeed";
import { readSessionToken } from "../../api/client";
import { LogFeedStoppedError } from "../../lib/log-feed";

interface UseAppControllerDataActionsOptions {
  apiFetch: ApiFetch;
  sessionToken: string | null;
  showToast: (type: "success" | "error" | "warning" | "info", message: string) => void;
  setLoadingQuotas: (value: boolean) => void;
  setQuotas: Dispatch<SetStateAction<Quota[]>>;
  setLoadingLogs: (value: boolean) => void;
  setLogs: Dispatch<SetStateAction<AppLog[]>>;
  setActionLoading: (value: string | null) => void;
}

export function useAppControllerDataActions({
  apiFetch,
  sessionToken,
  showToast,
  setLoadingQuotas,
  setQuotas,
  setLoadingLogs,
  setLogs,
  setActionLoading,
}: UseAppControllerDataActionsOptions) {
  const logFeed = useLogFeed(apiFetch, sessionToken, setLogs, setLoadingLogs);
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
    try {
      await logFeed.current.full();
    } catch (error) {
      if (!(error instanceof LogFeedStoppedError) && readSessionToken() === sessionToken) showToast("error", "获取系统运行日志失败");
    }
  };

  const handleClearLogs = async () => {
    if (!confirm("确定要清空所有的运行日志吗？")) return;
    const ownerFeed = logFeed.current;
    setActionLoading("clear-logs");
    try {
      const res = await apiFetch("/api/logs/clear", { method: "POST" });
      const data = await res.json();
      if (readSessionToken() !== sessionToken || logFeed.current !== ownerFeed) return;
      if (data.success) {
        showToast("success", "系统日志已成功清空");
        await fetchLogs();
      } else {
        showToast("error", data.message || "清空日志失败");
      }
    } catch {
      if (readSessionToken() === sessionToken && logFeed.current === ownerFeed) showToast("error", "清空日志网络请求失败");
    } finally {
      if (readSessionToken() === sessionToken && logFeed.current === ownerFeed) setActionLoading(null);
    }
  };

  return { fetchQuotas, fetchLogs, handleClearLogs, logFeed };
}
