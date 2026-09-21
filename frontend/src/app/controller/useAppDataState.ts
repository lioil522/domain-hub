import { useState } from "react";
import type { Account } from "../../types/account";
import type { AppLog } from "../../types/log";
import type { Domain } from "../../types/domain";
import type { Quota } from "../../types/quota";

/** Local list/loading state owned by the application orchestration layer. */
export function useAppDataState() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [quotas, setQuotas] = useState<Quota[]>([]);
  const [logs, setLogs] = useState<AppLog[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(false);
  const [loadingQuotas, setLoadingQuotas] = useState(false);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [selectedAccountFilter, setSelectedAccountFilter] = useState("all");
  const [openActionMenuId, setOpenActionMenuId] = useState<number | null>(null);
  const [bindModalOpen, setBindModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);

  return {
    domains, setDomains,
    quotas, setQuotas,
    logs, setLogs,
    loadingDomains, setLoadingDomains,
    loadingQuotas, setLoadingQuotas,
    loadingLogs, setLoadingLogs,
    actionLoading, setActionLoading,
    selectedAccountFilter, setSelectedAccountFilter,
    openActionMenuId, setOpenActionMenuId,
    bindModalOpen, setBindModalOpen,
    editingAccount, setEditingAccount,
  };
}
