import { useEffect, type Dispatch, type SetStateAction } from "react";
import { tabFromHash, type TabKey } from "../navigation";
import type { JumpSource } from "../../types/provider";

interface UseAppControllerNavigationOptions {
  activeTab: TabKey;
  setActiveTab: Dispatch<SetStateAction<TabKey>>;
  setGlobalSearch: (value: string) => void;
  setDnsheMenuOpen: (value: boolean) => void;
  setMultiProviderFilter: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  gotoDnsheDomain: (fullDomain: string) => void;
  gotoCfZone: (fullDomain: string) => void;
  gotoDpDomain: (fullDomain: string) => void;
}

export function useAppControllerNavigation({
  activeTab,
  setActiveTab,
  setGlobalSearch,
  setDnsheMenuOpen,
  setMultiProviderFilter,
  gotoDnsheDomain,
  gotoCfZone,
  gotoDpDomain,
}: UseAppControllerNavigationOptions) {
  useEffect(() => {
    const syncFromHash = () => {
      const next = tabFromHash();
      setActiveTab((prev) => (prev === next ? prev : next));
    };
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  useEffect(() => {
    const want = `#${activeTab}`;
    if (window.location.hash !== want) window.location.hash = want;
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "register" || activeTab === "quota" || activeTab === "line-settings") {
      setDnsheMenuOpen(true);
    }
  }, [activeTab, setDnsheMenuOpen]);

  const toJumpSource = (displayName: string): JumpSource => {
    const s = displayName.toLowerCase();
    if (s === "cloudflare" || s === "cf") return "cf";
    if (s === "digitalplat" || s === "dp") return "dp";
    if (s === "自定义" || s === "custom") return "custom";
    if (s.includes("dnspod") || s.includes("腾讯云")) return "dnspod";
    if (s.includes("aliyun") || s.includes("阿里")) return "alidns";
    if (s.includes("huawei") || s.includes("华为")) return "huaweicloud";
    if (s.includes("vercel")) return "vercel";
    return "dnshe";
  };

  const handleCrossSourceJump = (source: JumpSource, fullDomain: string) => {
    if (source === "dnshe") {
      gotoDnsheDomain(fullDomain);
    } else if (source === "cf") {
      gotoCfZone(fullDomain);
    } else if (source === "dp") {
      gotoDpDomain(fullDomain);
    } else {
      setActiveTab(source as TabKey);
      setMultiProviderFilter((prev) => ({ ...prev, [source]: "all" }));
    }
    setGlobalSearch("");
  };

  return { activeTab, setActiveTab, toJumpSource, handleCrossSourceJump };
}
