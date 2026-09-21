import { useEffect, useState } from "react";
import type { Account } from "../../../../types/account";
import type { CustomAccount, CustomDomain } from "../../../../types/custom";

const CUSTOM_CACHE_LS_KEY = "DOMAIN_HUB_CUSTOM_CACHE_V1";
const CUSTOM_COLLAPSED_LS_KEY = "DOMAIN_HUB_CUSTOM_COLLAPSED_GROUPS";

export function useCustomProvidersState() {
  const [customGroupFilter, setCustomGroupFilter] = useState<string>("all");
  const readCustomCache = (): { accounts: CustomAccount[]; domains: CustomDomain[] } => {
    try {
      const raw = localStorage.getItem(CUSTOM_CACHE_LS_KEY);
      if (!raw) return { accounts: [], domains: [] };
      const parsed = JSON.parse(raw) as { accounts?: CustomAccount[]; domains?: CustomDomain[] };
      return { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [], domains: Array.isArray(parsed.domains) ? parsed.domains : [] };
    } catch {
      return { accounts: [], domains: [] };
    }
  };
  const persistCustomCache = (accounts: CustomAccount[], domains: CustomDomain[]) => {
    try { localStorage.setItem(CUSTOM_CACHE_LS_KEY, JSON.stringify({ ts: Date.now(), accounts, domains })); } catch { /* storage unavailable */ }
  };

  const [customAccounts, setCustomAccounts] = useState<CustomAccount[]>(() => readCustomCache().accounts);
  const [customDomains, setCustomDomains] = useState<CustomDomain[]>(() => readCustomCache().domains);
  const [loadingCustomDomains, setLoadingCustomDomains] = useState(false);
  const [customCollapsedGroups, setCustomCollapsedGroups] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem(CUSTOM_COLLAPSED_LS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch { return new Set(); }
  });
  const persistCustomCollapsed = (next: Set<number>) => {
    setCustomCollapsedGroups(next);
    try { localStorage.setItem(CUSTOM_COLLAPSED_LS_KEY, JSON.stringify([...next])); } catch { /* storage unavailable */ }
  };

  const [customNewGroupOpen, setCustomNewGroupOpen] = useState(false);
  const [customNewGroupAlias, setCustomNewGroupAlias] = useState("");
  const [customNewGroupWebsite, setCustomNewGroupWebsite] = useState("");
  const [customNewGroupSaving, setCustomNewGroupSaving] = useState(false);
  const [customNewGroupMode, setCustomNewGroupMode] = useState<"single" | "batch">("single");
  const [customBatchRows, setCustomBatchRows] = useState<Array<{ alias: string; website: string }>>([{ alias: "", website: "" }]);
  const [customBatchResults, setCustomBatchResults] = useState<Array<{ alias: string; success: boolean; message: string }> | null>(null);
  const [customAccountModalOpen, setCustomAccountModalOpen] = useState(false);
  const [customAccountModalGroup, setCustomAccountModalGroup] = useState<Account | null>(null);
  const [customAccountName, setCustomAccountName] = useState("");
  const [customAccountSaving, setCustomAccountSaving] = useState(false);
  const [customDomainModalOpen, setCustomDomainModalOpen] = useState(false);
  const [customDomainModalGroup, setCustomDomainModalGroup] = useState<Account | null>(null);
  const [customDomainModalAccount, setCustomDomainModalAccount] = useState<CustomAccount | null>(null);
  const [customDomainModalEditing, setCustomDomainModalEditing] = useState<CustomDomain | null>(null);
  const [customDomainFull, setCustomDomainFull] = useState("");
  const [customDomainRegistered, setCustomDomainRegistered] = useState("");
  const [customDomainExpiry, setCustomDomainExpiry] = useState("");
  const [customDomainRemark, setCustomDomainRemark] = useState("");
  const [customDomainSaving, setCustomDomainSaving] = useState(false);
  const [customDeleteGroup, setCustomDeleteGroup] = useState<Account | null>(null);
  const [customDeleteAccount, setCustomDeleteAccount] = useState<CustomAccount | null>(null);
  const [customDeleteDomain, setCustomDeleteDomain] = useState<CustomDomain | null>(null);

  useEffect(() => {
    if (!customNewGroupOpen) return;
    setCustomNewGroupAlias("");
    setCustomNewGroupWebsite("");
    setCustomBatchRows([{ alias: "", website: "" }]);
    setCustomBatchResults(null);
    setCustomNewGroupMode("single");
  }, [customNewGroupOpen]);

  return {
    customGroupFilter, setCustomGroupFilter, customAccounts, setCustomAccounts, customDomains, setCustomDomains, loadingCustomDomains, setLoadingCustomDomains,
    customCollapsedGroups, persistCustomCollapsed, persistCustomCache,
    customNewGroupOpen, setCustomNewGroupOpen, customNewGroupAlias, setCustomNewGroupAlias, customNewGroupWebsite, setCustomNewGroupWebsite,
    customNewGroupSaving, setCustomNewGroupSaving, customNewGroupMode, setCustomNewGroupMode, customBatchRows, setCustomBatchRows,
    customBatchResults, setCustomBatchResults, customAccountModalOpen, setCustomAccountModalOpen, customAccountModalGroup, setCustomAccountModalGroup,
    customAccountName, setCustomAccountName, customAccountSaving, setCustomAccountSaving, customDomainModalOpen, setCustomDomainModalOpen,
    customDomainModalGroup, setCustomDomainModalGroup, customDomainModalAccount, setCustomDomainModalAccount, customDomainModalEditing, setCustomDomainModalEditing,
    customDomainFull, setCustomDomainFull, customDomainRegistered, setCustomDomainRegistered, customDomainExpiry, setCustomDomainExpiry,
    customDomainRemark, setCustomDomainRemark, customDomainSaving, setCustomDomainSaving, customDeleteGroup, setCustomDeleteGroup,
    customDeleteAccount, setCustomDeleteAccount, customDeleteDomain, setCustomDeleteDomain,
  };
}

export type UseCustomProvidersStateReturn = ReturnType<typeof useCustomProvidersState>;
