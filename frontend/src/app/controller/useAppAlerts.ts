import { useMemo, useState } from "react";
import type { AppLog } from "../../types/log";

type LogCategory = "all" | "auth" | "api" | "operation";

/** Notification badge state and log filtering kept outside the main app orchestrator. */
export function useAppAlerts(logs: AppLog[], logCategory: LogCategory) {
  const alertLogs = useMemo(
    () => logs.filter((log) => log.type === "error" || log.type === "warning").slice(0, 6),
    [logs],
  );

  const [lastAlertSeenId, setLastAlertSeenId] = useState<number>(() =>
    Number(localStorage.getItem("DNSHE_LAST_SEEN_ALERT_ID") || 0),
  );

  const unreadAlert = useMemo(() => {
    const newest = alertLogs[0];
    return !!newest && newest.id > lastAlertSeenId;
  }, [alertLogs, lastAlertSeenId]);

  const markAlertsRead = () => {
    const newest = alertLogs[0];
    if (!newest) return;
    setLastAlertSeenId(newest.id);
    localStorage.setItem("DNSHE_LAST_SEEN_ALERT_ID", String(newest.id));
  };

  const filteredLogs = useMemo(() => {
    if (logCategory === "all") return logs;
    const groupMap: Record<Exclude<LogCategory, "all">, string[]> = {
      auth: ["auth"],
      api: ["api", "sync", "renew"],
      operation: ["operation", "system"],
    };
    const allowed = groupMap[logCategory] || [];
    return logs.filter((log) => allowed.includes(log.category));
  }, [logs, logCategory]);

  return { alertLogs, unreadAlert, markAlertsRead, filteredLogs };
}
