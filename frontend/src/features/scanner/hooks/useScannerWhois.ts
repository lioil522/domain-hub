import { useCallback, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { toASCII } from "../../../punycode";
import type { ApiFetch } from "../../../api/client";
import type { Account } from "../../../types/account";
import type { AvailableDomain, WhoisResult } from "../utils/scanner-types";

type Toast = (kind: "success" | "error" | "info" | "warning", message: string) => void;

type Options = {
  apiFetch: ApiFetch;
  showToast: Toast;
  dnsheAccounts: Account[];
  fetchDomains: () => void;
  setActiveTab: (tab: "domains") => void;
  actionLoading: string | null;
  setActionLoading: (v: string | null) => void;
  searchSubdomain: string;
  setSearchSubdomain: Dispatch<SetStateAction<string>>;
  searchRootdomain: string;
  setSearchRootdomain: Dispatch<SetStateAction<string>>;
  whoisLoading: boolean;
  setWhoisLoading: Dispatch<SetStateAction<boolean>>;
  whoisResult: WhoisResult | null;
  setWhoisResult: Dispatch<SetStateAction<WhoisResult | null>>;
  registerAccountId: number | "";
  setRegisterAccountId: Dispatch<SetStateAction<number | "">>;
  setRegMode: Dispatch<SetStateAction<"single" | "batch">>;
  reservedPrefixes: string[];
  enableReservedFilter: boolean;
};

export function useScannerWhois({
  apiFetch, showToast, dnsheAccounts, fetchDomains, setActiveTab, actionLoading, setActionLoading,
  searchSubdomain, setSearchSubdomain, searchRootdomain, setSearchRootdomain,
  whoisLoading, setWhoisLoading, whoisResult, setWhoisResult,
  registerAccountId, setRegisterAccountId, setRegMode, reservedPrefixes, enableReservedFilter
}: Options) {
  const handleCheckWhois = useCallback(async (
    e?: FormEvent,
    overrideSub?: string,
    overrideRoot?: string
  ) => {
    if (e) e.preventDefault();
    const sub = toASCII((overrideSub !== undefined ? overrideSub : searchSubdomain).trim());
    const root = toASCII((overrideRoot !== undefined ? overrideRoot : searchRootdomain).trim());

    if (!sub) {
      showToast("error", "请输入想要查询的子域名前缀！");
      return;
    }

    if (enableReservedFilter && reservedPrefixes.some(p => p.toLowerCase() === sub.toLowerCase())) {
      showToast("error", `前缀 [${sub}] 属于官方保留名单，不可注册（可在批量页的保留名单中调整）`);
      return;
    }

    const fullTargetDomain = `${sub}.${root}`;
    setWhoisLoading(true);
    try {
      const accountQuery = registerAccountId ? `&account_id=${registerAccountId}` : "";
      const res = await apiFetch(`/api/whois?domain=${encodeURIComponent(fullTargetDomain)}${accountQuery}`);
      const data = await res.json();
      if (data.success && data.whois) {
        setWhoisResult({ searchedDomain: fullTargetDomain, ...data.whois });
        if (dnsheAccounts.length > 0 && !registerAccountId) {
          setRegisterAccountId(dnsheAccounts[0].id);
        }
      } else {
        showToast("error", data.message || "WHOIS 查询失败");
      }
    } catch {
      showToast("error", "WHOIS 查询请求失败，请检查网络连接");
    } finally {
      setWhoisLoading(false);
    }
  }, [apiFetch, dnsheAccounts, enableReservedFilter, registerAccountId, reservedPrefixes, searchRootdomain, searchSubdomain, setRegisterAccountId, setWhoisLoading, setWhoisResult, showToast]);

  const handleRegisterSubdomain = useCallback(async () => {
    const sub = toASCII(searchSubdomain.trim());
    const root = toASCII(searchRootdomain.trim());
    if (!sub || !root) return;
    if (!registerAccountId) {
      showToast("error", "请先选择用于注册域名的 API 账号！");
      return;
    }

    setActionLoading("register-subdomain");
    try {
      const res = await apiFetch("/api/domains/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: registerAccountId, subdomain: sub, rootdomain: root })
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", `🎉 域名 [${data.full_domain || sub + "." + root}] 注册成功！`);
        setWhoisResult(null);
        setSearchSubdomain("");
        fetchDomains();
        setActiveTab("domains");
      } else {
        showToast("error", data.message || "注册子域名失败，请重试");
      }
    } catch {
      showToast("error", "注册请求失败，请重试");
    } finally {
      setActionLoading(null);
    }
  }, [apiFetch, fetchDomains, registerAccountId, searchRootdomain, searchSubdomain, setActionLoading, setSearchSubdomain, setActiveTab, setWhoisResult, showToast]);

  const handleRegisterFromResult = useCallback((item: AvailableDomain) => {
    const sub = item.subdomain;
    const root = item.rootdomain;
    setSearchSubdomain(sub);
    setSearchRootdomain(root);
    setRegMode("single");
    if (dnsheAccounts.length > 0 && !registerAccountId) {
      setRegisterAccountId(dnsheAccounts[0].id);
    }
    setWhoisResult({ searchedDomain: item.fullDomain, registered: false });
    void handleCheckWhois(undefined, sub, root);
  }, [dnsheAccounts, handleCheckWhois, registerAccountId, setRegMode, setRegisterAccountId, setSearchRootdomain, setSearchSubdomain, setWhoisResult]);

  return {
    handleCheckWhois,
    handleRegisterSubdomain,
    handleRegisterFromResult,
    registerLoading: actionLoading === "register-subdomain",
    whoisLoading,
    whoisResult
  };
}
