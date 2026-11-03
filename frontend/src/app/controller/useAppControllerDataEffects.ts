import { useEffect, useRef } from "react";
import type { TabKey } from "../navigation";

interface UseAppControllerDataEffectsOptions {
  sessionToken: string | null;
  activeTab: TabKey;
  fetchAccounts: () => void;
  fetchDomains: () => void;
  refreshAllProviderDomains: () => void;
  fetchCustomDomains: () => void;
  fetchLogs: () => void;
  fetchQuotas: () => void;
  fetchSettings: () => void;
  fetchAccountInfo: () => void;
}

export function useAppControllerDataEffects({
  sessionToken,
  activeTab,
  fetchAccounts,
  fetchDomains,
  refreshAllProviderDomains,
  fetchCustomDomains,
  fetchLogs,
  fetchQuotas,
  fetchSettings,
  fetchAccountInfo,
}: UseAppControllerDataEffectsOptions) {
  const tabDataFetchedAtRef = useRef<Record<string, number>>({});

  const invalidateQuotaTabCache = () => {
    delete tabDataFetchedAtRef.current.quota;
  };

  useEffect(() => {
    if (!sessionToken) return;
    tabDataFetchedAtRef.current = {};
    fetchAccounts();
    fetchDomains();
    refreshAllProviderDomains();
    fetchCustomDomains();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionToken]);

  useEffect(() => {
    if (!sessionToken) return;
    const now = Date.now();
    const fetchIfStale = (key: string, ttlMs: number, run: () => void) => {
      const last = tabDataFetchedAtRef.current[key];
      if (last !== undefined && now - last < ttlMs) return;
      tabDataFetchedAtRef.current[key] = now;
      run();
    };

    if (activeTab === "dashboard" || activeTab === "logs") {
      fetchIfStale("logs", 60_000, fetchLogs);
    } else if (activeTab === "quota") {
      fetchIfStale("quota", 60_000, fetchQuotas);
    } else if (activeTab === "settings") {
      fetchIfStale("settings", Infinity, fetchSettings);
      fetchIfStale("account", Infinity, fetchAccountInfo);
    } else if (activeTab === "custom") {
      fetchIfStale("custom", 60_000, fetchCustomDomains);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, sessionToken]);

  return { invalidateQuotaTabCache };
}
