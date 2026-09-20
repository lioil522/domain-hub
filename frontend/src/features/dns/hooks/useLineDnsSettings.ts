import { useMemo, useState, type FormEvent } from "react";
import type { Domain } from "../../../types/domain";
import type { ApiFetch } from "../../../api/client";
import type { DnsRecord } from "../../../types/dns";
import { DEFAULT_LINE_NS_SUFFIXES, DEFAULT_LINE_PROVIDERS } from "../../../constants/dns";
import { parseWords } from "../../../wordbanks";

const NS_LOOKUP_BATCH = 20;

type Toast = (tone: "success" | "error" | "info" | "warning", message: string) => void;

type LineDnsSettingsOptions = {
  domains: Domain[];
  scannerRootDomains: string[];
  dnsheAccountCount: number;
  apiFetch: ApiFetch;
  showToast: Toast;
  setActionLoading: (value: string | null) => void;
};

/**
 * Line-DNS support state shared by the Settings page and domain/DNS views.
 *
 * Responsibilities are deliberately limited to the local mirror, NS lookup,
 * line-support inference and user actions. Rendering stays in the page layer.
 */
export function useLineDnsSettings({
  domains,
  scannerRootDomains,
  dnsheAccountCount,
  apiFetch,
  showToast,
  setActionLoading,
}: LineDnsSettingsOptions) {
  const [lineNsSuffixes, setLineNsSuffixes] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("DNSHE_LINE_NS_SUFFIXES");
      if (!raw) return DEFAULT_LINE_NS_SUFFIXES;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : DEFAULT_LINE_NS_SUFFIXES;
    } catch {
      return DEFAULT_LINE_NS_SUFFIXES;
    }
  });
  const [newLineNsInput, setNewLineNsInput] = useState("");

  const [rootNs, setRootNs] = useState<Record<string, string[] | null>>(() => {
    try {
      const raw = localStorage.getItem("DNSHE_ROOT_NS");
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  });

  const [learnedLineRoots, setLearnedLineRoots] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("DNSHE_LINE_ROOTS");
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
    } catch {
      return [];
    }
  });

  const persistLineNsSuffixes = (next: string[]) => {
    const cleaned = Array.from(
      new Set(
        next
          .map((v) => String(v).trim().toLowerCase().replace(/^\.+|\.+$/g, ""))
          .filter(Boolean),
      ),
    );
    setLineNsSuffixes(cleaned);
    localStorage.setItem("DNSHE_LINE_NS_SUFFIXES", JSON.stringify(cleaned));
  };

  const nsHostMatchesSuffix = (host: string): boolean => {
    const h = host.trim().toLowerCase().replace(/\.$/, "");
    if (!h) return false;
    return lineNsSuffixes.some((sfx) => h === sfx || h.endsWith(`.${sfx}`));
  };

  const domainSupportsLine = (dom: Domain | null | undefined): boolean => {
    const root = String(dom?.rootdomain ?? "").trim().toLowerCase();
    if (root && learnedLineRoots.includes(root)) return true;

    const ns = root ? rootNs[root] : undefined;
    if (ns && ns.length > 0) return ns.some(nsHostMatchesSuffix);

    const pid = dom?.provider_account_id;
    if (pid === undefined || pid === null || String(pid).trim() === "") return false;
    return DEFAULT_LINE_PROVIDERS.includes(String(pid).trim());
  };

  const fetchRootNs = async (
    roots: string[],
    force = false,
  ): Promise<Record<string, string[] | null>> => {
    const normalized = Array.from(
      new Set(roots.map((r) => String(r || "").trim().toLowerCase()).filter(Boolean)),
    );
    const pending = force
      ? normalized
      : normalized.filter((r) => {
          const cur = rootNs[r];
          return !(Array.isArray(cur) && cur.length > 0);
        });
    if (pending.length === 0) return {};

    const merged: Record<string, string[] | null> = {};
    for (let i = 0; i < pending.length; i += NS_LOOKUP_BATCH) {
      const batch = pending.slice(i, i + NS_LOOKUP_BATCH);
      try {
        const res = await apiFetch(
          `/api/dns/ns?roots=${encodeURIComponent(batch.join(","))}${force ? "&refresh=1" : ""}`,
        );
        const data = await res.json();
        if (data.success && data.ns && typeof data.ns === "object") {
          Object.assign(merged, data.ns as Record<string, string[] | null>);
        }
      } catch {
        // Keep the local result unknown and let the provider fallback decide.
      }
    }
    if (Object.keys(merged).length === 0) return {};

    setRootNs((prev) => {
      const next = { ...prev, ...merged };
      localStorage.setItem("DNSHE_ROOT_NS", JSON.stringify(next));
      return next;
    });
    return merged;
  };

  const learnLineRootFrom = (dom: Domain, records: DnsRecord[]) => {
    const root = String(dom.rootdomain ?? "").trim().toLowerCase();
    if (!root || learnedLineRoots.includes(root)) return;

    const usesLine = records.some((r) => {
      const value = String(r.line || "").trim().toLowerCase();
      return value !== "" && value !== "default";
    });
    if (!usesLine) return;

    setLearnedLineRoots((prev) => {
      if (prev.includes(root)) return prev;
      const next = [...prev, root];
      localStorage.setItem("DNSHE_LINE_ROOTS", JSON.stringify(next));
      return next;
    });
    showToast("info", `检测到 ${dom.full_domain} 使用了线路解析，已确认根域 ${root} 支持线路`);
  };

  const handleAddLineNsSuffix = (event?: FormEvent) => {
    event?.preventDefault();
    const incoming = parseWords(newLineNsInput).map((word) => word.toLowerCase());
    if (incoming.length === 0) return;
    const merged = Array.from(new Set([...lineNsSuffixes, ...incoming]));
    const added = merged.length - lineNsSuffixes.length;
    persistLineNsSuffixes(merged);
    setNewLineNsInput("");
    showToast(
      added > 0 ? "success" : "info",
      added > 0 ? `已添加 ${added} 个 NS 后缀` : "输入的后缀都已在名单中",
    );
  };

  const handleRemoveLineNsSuffix = (suffix: string) => {
    persistLineNsSuffixes(lineNsSuffixes.filter((item) => item !== suffix));
  };

  const handleRestoreLineNsSuffixes = () => {
    persistLineNsSuffixes(DEFAULT_LINE_NS_SUFFIXES);
    showToast("success", "已恢复默认 NS 后缀名单");
  };

  const handleClearLearnedLineRoots = () => {
    setLearnedLineRoots([]);
    localStorage.removeItem("DNSHE_LINE_ROOTS");
    showToast("info", "已清空实测确认的根域");
  };

  const knownRootDomains = useMemo(() => {
    const roots = new Set<string>();
    for (const domain of domains) {
      const root = String(domain.rootdomain ?? "").trim().toLowerCase();
      if (root) roots.add(root);
    }
    for (const root of scannerRootDomains) {
      const normalized = String(root || "").trim().toLowerCase();
      if (normalized) roots.add(normalized);
    }
    return Array.from(roots).sort();
  }, [domains, scannerRootDomains]);

  const handleRefreshRootNs = async () => {
    // DNSHE 根域 NS 查询仅在已添加 DNSHE 账号后执行。
    if (dnsheAccountCount === 0) return;

    setActionLoading("ns-lookup");
    try {
      const result = await fetchRootNs(knownRootDomains, true);
      const total = Object.keys(result).length;
      const resolved = Object.values(result).filter((value) => Array.isArray(value) && value.length > 0).length;
      if (total === 0) {
        showToast("error", "NS 查询没有返回任何结果，请检查后端连通性");
      } else if (resolved === 0) {
        showToast("error", `${total} 个根域全部查询失败，判定已回退到服务商 ID（详见运行日志）`);
      } else if (resolved < total) {
        showToast("info", `已查到 ${resolved}/${total} 个根域的 NS，其余保持「未知」`);
      } else {
        showToast("success", `${resolved} 个根域的 NS 已刷新`);
      }
    } finally {
      setActionLoading(null);
    }
  };

  return {
    lineNsSuffixes,
    newLineNsInput,
    setNewLineNsInput,
    rootNs,
    learnedLineRoots,
    persistLineNsSuffixes,
    nsHostMatchesSuffix,
    domainSupportsLine,
    fetchRootNs,
    learnLineRootFrom,
    handleAddLineNsSuffix,
    handleRemoveLineNsSuffix,
    handleRestoreLineNsSuffixes,
    handleClearLearnedLineRoots,
    handleRefreshRootNs,
    knownRootDomains,
  };
}
