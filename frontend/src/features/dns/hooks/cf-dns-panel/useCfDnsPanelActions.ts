import { useMemo } from "react";
import type { Domain } from "../../../../types/domain";
import type { DnsRecord } from "../../../../types/dns";
import type { ApiFetch } from "../../../../api/client";
import { apiJson } from "../../../../api/request";
import { dnsRecordKey, buildDnsEditTargets, parseDnsBatchInput, needsDnsPriority, CF_DNS_TYPE_SET, toRelativeRecordName, type ParsedDnsLine } from "../../../../dnsrecords";
import type { UseCfDnsPanelStateReturn } from "./useCfDnsPanelState";
import type { UseCfDnsPanelMetaReturn } from "./useCfDnsPanelMeta";

type DnsBatchResultRow = { label: string; success: boolean; message: string };
type DnsBatchResponse = { results?: DnsBatchResultRow[]; success_count?: number; fail_count?: number };


export interface UseCfDnsPanelActionsOptions {
  state: UseCfDnsPanelStateReturn;
  meta: UseCfDnsPanelMetaReturn;
  apiFetch: ApiFetch;
  showToast: (type: "success" | "error" | "info" | "warning", msg: string) => void;
  setActionLoading: (value: string | null) => void;
}

export function useCfDnsPanelActions({ state, meta, apiFetch, showToast, setActionLoading }: UseCfDnsPanelActionsOptions) {
  const {
    cfSelectedZone, cfRecords, cfBatchInput, cfBatchType, cfBatchLine, cfBatchName, cfBatchTtl, cfBatchPriority, cfBatchProxied,
    cfNewType, cfNewLine, cfNewName, cfNewContent, cfNewTtl, cfNewPriority, cfNewProxied,
    cfEditingKey, cfEditType, cfEditLine, cfEditName, cfEditContent, cfEditTtl, cfEditPriority, cfEditProxied,
    cfSelectedKeys, cfEditFields, cfBatchEditName, cfBatchEditTtl, cfBatchEditProxied, cfBatchEditContents,
    setCfDnsModalOpen, setCfSelectedZone, setLoadingCfRecords, setCfRecords, setCfRecordsError,
    setCfFormOpen, setCfNewType, setCfNewLine, setCfNewName, setCfNewContent, setCfNewTtl, setCfNewPriority, setCfNewProxied,
    setCfEditingKey, setCfEditType, setCfEditLine, setCfEditName, setCfEditContent, setCfEditTtl, setCfEditPriority, setCfEditProxied,
    setCfBatchOpen, setCfBatchInput, setCfBatchLine, setCfBatchTtl, setCfBatchProxied, setCfBatchResults, setCfSelectedKeys, setCfEditPanelOpen, setCfBatchEditContents, setCfEditResults,
    setCfBatchEditName, setCfBatchEditTtl, setCfBatchEditProxied, setCfEditFields,
  } = state;
  const { dnsPanelMeta, dnsPanelIsDp } = meta;

  // 打开 CF 解析记录面板并加载记录
  const reloadCfRecords = async (zone: Domain, forceRefresh = false) => {
    setLoadingCfRecords(true);
    try {
      const data = await apiJson<{ records?: DnsRecord[] }>(apiFetch, `/api/domains/${zone.id}/dns${forceRefresh ? "?refresh=1" : ""}`);
      if (data.success) {
        setCfRecords(data.records || []);
        setCfRecordsError(null);
      } else {
        setCfRecordsError(data.message || "获取解析记录失败");
        showToast("error", data.message || "获取解析记录失败");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "获取解析记录失败";
      setCfRecordsError(msg);
      showToast("error", msg);
    } finally {
      setLoadingCfRecords(false);
    }
  };

  const handleCfOpenDnsModal = (zone: Domain) => {
    setCfSelectedZone(zone);
    setCfDnsModalOpen(true);
    setCfRecords([]);
    setCfRecordsError(null);
    setCfSelectedKeys(new Set());
    setCfEditingKey(null);
    setCfFormOpen(false);
    setCfBatchOpen(false);
    setCfEditPanelOpen(false);
    setCfBatchResults(null);
    setCfEditResults(null);
    setCfNewType("A");
    setCfNewLine("default");
    setCfNewName("");
    setCfNewContent("");

    // 根据 provider 判断默认 TTL：Cloudflare 为 1（自动），其余托管商（华为云/DP/阿里/腾讯等）为 300
    const isCloudflare =
      zone.dns_provider === "Cloudflare" ||
      zone.account_provider === "cloudflare" ||
      String(zone.ns1 || "").toLowerCase().includes("cloudflare.com") ||
      String(zone.ns2 || "").toLowerCase().includes("cloudflare.com");
    const defaultTtl = isCloudflare ? 1 : 300;

    setCfNewTtl(defaultTtl);
    setCfEditTtl(defaultTtl);
    setCfBatchTtl(defaultTtl);
    setCfBatchEditTtl(defaultTtl);
    setCfNewPriority(10);
    setCfNewProxied(false);
    setCfEditProxied(false);
    setCfBatchProxied(false);
    setCfBatchLine("default");
    setCfEditLine("default");
    setCfEditFields({ name: false, content: false, ttl: false, proxied: false });
    void reloadCfRecords(zone);
  };

  // 新建 CF 解析记录
  const handleCfCreateRecord = async () => {
    if (!cfSelectedZone) return;
    if (!cfNewContent.trim()) {
      showToast("error", "记录值不能为空");
      return;
    }
    setActionLoading("cf-create-dns");
    try {
      const isCf = dnsPanelMeta.isCloudflare;
      const isDp = dnsPanelIsDp;
      const numTtl = Number(cfNewTtl);
      const safeTtl = isCf && cfNewProxied
        ? 1
        : isCf
        ? (Number.isFinite(numTtl) && numTtl > 0 ? numTtl : 1)
        : (Number.isFinite(numTtl) && numTtl >= 300 ? numTtl : 300);
      const payload: Record<string, unknown> = {
        type: cfNewType,
        name: cfNewName.trim() || "@",
        content: cfNewContent.trim(),
        ttl: safeTtl,
      };
      if (dnsPanelMeta.supportsLine) {
        payload.line = cfNewLine || "default";
      }
      if (isCf) {
        payload.proxied = cfNewProxied;
      }
      if (!isDp && needsDnsPriority(cfNewType)) {
        payload.priority = cfNewPriority;
      }
      const data = await apiJson(apiFetch, `/api/domains/${cfSelectedZone.id}/dns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (data.success) {
        showToast("success", "创建解析记录成功");
        setCfNewName("");
        setCfNewContent("");
        setCfNewProxied(false);
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "创建解析记录失败");
      }
    } catch (e) {
      showToast("error", e instanceof Error ? e.message : "创建解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 行内修改：进入编辑态
  const handleCfStartEditRecord = (rec: DnsRecord) => {
    setCfEditingKey(dnsRecordKey(rec));
    setCfEditType(rec.type);
    setCfEditLine(rec.line || "default");
    setCfEditName(toRelativeRecordName(rec.name, cfSelectedZone?.full_domain || ""));
    setCfEditContent(rec.content);
    setCfEditTtl(rec.ttl > 0 ? rec.ttl : 1);
    setCfEditPriority(rec.priority !== null && rec.priority !== undefined ? rec.priority : 10);
    setCfEditProxied(Boolean(rec.proxied));
  };

  // 行内修改：保存
  const handleCfUpdateRecord = async () => {
    if (!cfSelectedZone || !cfEditingKey) return;
    const target = cfRecords.find((r) => dnsRecordKey(r) === cfEditingKey);
    if (!target) return;
    if (!cfEditContent.trim()) {
      showToast("error", "记录值不能为空");
      return;
    }
    setActionLoading(`cf-update-dns-${cfEditingKey}`);
    try {
      const isCf = dnsPanelMeta.isCloudflare;
      const isDp = dnsPanelIsDp;
      const numEditTtl = Number(cfEditTtl);
      const safeEditTtl = isCf && cfEditProxied
        ? 1
        : isCf
        ? (Number.isFinite(numEditTtl) && numEditTtl > 0 ? numEditTtl : 1)
        : (Number.isFinite(numEditTtl) && numEditTtl >= 300 ? numEditTtl : 300);
      const payload: Record<string, unknown> = {
        type: cfEditType,
        name: cfEditName.trim() || "@",
        content: cfEditContent.trim(),
        origin_content: target.content,
        ttl: safeEditTtl,
        priority: !isDp && needsDnsPriority(cfEditType) ? cfEditPriority : undefined,
        ...(isCf ? { proxied: cfEditProxied } : {})
      };
      if (dnsPanelMeta.supportsLine) {
        payload.line = cfEditLine || "default";
      }
      const data = await apiJson(apiFetch, `/api/domains/${cfSelectedZone.id}/dns/${encodeURIComponent(cfEditingKey)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (data.success) {
        showToast("success", "解析记录已更新");
        setCfEditingKey(null);
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "更新解析记录失败");
      }
    } catch (e) {
      showToast("error", e instanceof Error ? e.message : "更新解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 删除单条 CF 解析记录
  const handleCfDeleteRecord = async (rec: DnsRecord) => {
    if (!cfSelectedZone) return;
    if (!confirm(`确定要删除记录 ${rec.type} ${rec.name} → ${rec.content} 吗？这会立即影响该域名的解析！`)) {
      return;
    }
    const key = dnsRecordKey(rec);
    setActionLoading(`cf-delete-dns-${key}`);
    try {
      const data = await apiJson(apiFetch, `/api/domains/${cfSelectedZone.id}/dns/${encodeURIComponent(key)}`, { method: "DELETE" });
      if (data.success) {
        showToast("success", "解析记录已删除");
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "删除解析记录失败");
      }
    } catch (e) {
      showToast("error", e instanceof Error ? e.message : "删除解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // CF 批量添加输入框的实时解析（主机记录提前转相对名，预览与提交一致）
  // NOTE: 行首类型令牌按 Cloudflare 全量类型识别，否则 PTR 这类行首会被误认成主机记录
  const cfParsedBatchLines = useMemo(
    () =>
      parseDnsBatchInput(cfBatchInput, {
        type: cfBatchType,
        name: cfBatchName.trim() || "@",
        ttl: cfBatchProxied ? 1 : cfBatchTtl,
        priority: cfBatchPriority
      }, CF_DNS_TYPE_SET).map((r) =>
        r ? { ...r, name: toRelativeRecordName(r.name, cfSelectedZone?.full_domain || "") } : null
      ),
    [cfBatchInput, cfBatchType, cfBatchName, cfBatchTtl, cfBatchPriority, cfBatchProxied, cfSelectedZone]
  );

  const cfValidBatchLines = useMemo(
    () => cfParsedBatchLines.filter((r): r is ParsedDnsLine => r !== null),
    [cfParsedBatchLines]
  );

  // CF 批量添加（面板上的「代理」开关只对 A/AAAA/CNAME 行生效）
  const handleCfBatchCreate = async () => {
    if (!cfSelectedZone) return;
    if (cfValidBatchLines.length === 0) {
      showToast("error", "未能解析出任何有效的解析记录，请检查输入格式");
      return;
    }
    if (cfValidBatchLines.length > 50) {
      showToast("error", "单次最多批量添加 50 条解析记录");
      return;
    }

    const isCf = dnsPanelMeta.isCloudflare;
    const records = cfValidBatchLines.map((r) => ({
      ...r,
      line: dnsPanelMeta.supportsLine ? (cfBatchLine || "default") : undefined,
      ttl: isCf && cfBatchProxied ? 1 : r.ttl,
      proxied: isCf && cfBatchProxied && ["A", "AAAA", "CNAME"].includes(r.type) ? true : undefined
    }));

    setActionLoading("cf-batch-create-dns");
    setCfBatchResults(null);
    try {
      const data = await apiJson<DnsBatchResponse>(apiFetch, `/api/domains/${cfSelectedZone.id}/dns/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records })
      });
      if (data.success) {
        setCfBatchResults(data.results || []);
        if (data.fail_count === 0) {
          showToast("success", `已添加 ${data.success_count} 条解析记录`);
          setCfBatchInput("");
        } else {
          showToast("warning", `批量添加完成：成功 ${data.success_count} 条，失败 ${data.fail_count} 条（详见下方明细）`);
        }
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "批量添加解析记录失败");
      }
    } catch (e) {
      showToast("error", e instanceof Error ? e.message : "批量添加解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // CF 勾选的记录（批量修改 / 批量删除共用）
  const cfSelectedRecords = useMemo(
    () => cfRecords.filter((rec) => cfSelectedKeys.has(dnsRecordKey(rec))),
    [cfRecords, cfSelectedKeys]
  );

  const cfToggleAllSelection = () => {
    if (cfSelectedKeys.size === cfRecords.length) {
      setCfSelectedKeys(new Set());
    } else {
      setCfSelectedKeys(new Set(cfRecords.map(dnsRecordKey)));
    }
  };

  // CF 批量修改目标（复用 buildDnsEditTargets：主机记录 / 内容 / TTL / 代理 均可覆盖）
  const cfBatchEditTargets = useMemo(
    () =>
      buildDnsEditTargets(
        cfSelectedRecords,
        {
          type: false,
          name: cfEditFields.name,
          content: cfEditFields.content,
          ttl: cfEditFields.ttl,
          line: false,
          priority: false,
          proxied: cfEditFields.proxied
        },
        {
          type: "A",
          name: cfBatchEditName,
          content: "",
          ttl: cfBatchEditTtl,
          line: "",
          priority: 10,
          proxied: cfBatchEditProxied
        },
        cfSelectedZone?.full_domain || "",
        cfBatchEditContents
      ),
    [cfSelectedRecords, cfSelectedZone, cfEditFields, cfBatchEditName, cfBatchEditTtl, cfBatchEditProxied, cfBatchEditContents]
  );

  const cfBatchEditChanged = useMemo(
    () => cfBatchEditTargets.filter((t) => !t.unchanged),
    [cfBatchEditTargets]
  );

  const handleCfOpenEditPanel = () => {
    setCfBatchEditContents(
      Object.fromEntries(cfSelectedRecords.map((rec) => [dnsRecordKey(rec), rec.content || ""]))
    );
    if (cfSelectedRecords.length > 0) {
      setCfBatchEditName(toRelativeRecordName(cfSelectedRecords[0].name, cfSelectedZone?.full_domain || ""));
    }
    setCfEditResults(null);
    setCfEditPanelOpen(true);
  };

  // CF 批量修改已勾选的解析记录
  const handleCfBatchUpdateRecords = async () => {
    if (!cfSelectedZone || cfBatchEditTargets.length === 0) return;
    if (!cfEditFields.name && !cfEditFields.content && !cfEditFields.ttl && !cfEditFields.proxied) {
      showToast("error", "请至少勾选一个要修改的字段");
      return;
    }
    if (cfBatchEditChanged.length === 0) {
      showToast("info", "选中的记录与当前值一致，没有需要提交的修改");
      return;
    }
    if (cfBatchEditChanged.length > 50) {
      showToast("error", "单次最多批量修改 50 条解析记录");
      return;
    }

    if (!confirm(`确定要修改选中的 ${cfBatchEditChanged.length} 条解析记录吗？`)) {
      return;
    }

    const isCf = dnsPanelMeta.isCloudflare;
    const records = cfBatchEditChanged.map((t) => {
      const safeRecordTtl = isCf && cfEditFields.proxied && cfBatchEditProxied ? 1 : (isCf ? t.ttl : (t.ttl >= 300 ? t.ttl : 300));
      return {
        record_id: t.record_id,
        label: t.label,
        type: t.type,
        name: t.name,
        content: t.content,
        origin_content: t.origin_content,
        ttl: safeRecordTtl,
        proxied: isCf && cfEditFields.proxied ? cfBatchEditProxied : undefined,
      };
    });

    setActionLoading("cf-batch-update-dns");
    try {
      const data = await apiJson<DnsBatchResponse>(apiFetch, `/api/domains/${cfSelectedZone.id}/dns/batch-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records })
      });
      if (data.success) {
        setCfEditResults(data.results || []);
        const failed = (data.results || []).filter((r: { success: boolean }) => !r.success);
        if (failed.length === 0) {
          showToast("success", `已修改 ${data.success_count} 条解析记录`);
        } else {
          showToast("warning", `批量修改完成：成功 ${data.success_count} 条，失败 ${data.fail_count} 条（详见下方明细）`);
        }
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "批量修改解析记录失败");
      }
    } catch (e) {
      showToast("error", e instanceof Error ? e.message : "批量修改解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // CF 批量删除已勾选的解析记录
  const handleCfBatchDeleteRecords = async () => {
    if (!cfSelectedZone || cfSelectedKeys.size === 0) return;

    const targets = cfSelectedRecords.map((rec) => ({
      record_id: dnsRecordKey(rec),
      label: `${rec.type} ${rec.name} → ${rec.content}`
    }));

    if (
      !confirm(
        `确定要删除选中的 ${targets.length} 条解析记录吗？这会立即影响该域名的解析！\n\n${targets
          .map((t) => t.label)
          .join("\n")}`
      )
    ) {
      return;
    }

    setActionLoading("cf-batch-delete-dns");
    try {
      const data = await apiJson<DnsBatchResponse>(apiFetch, `/api/domains/${cfSelectedZone.id}/dns/batch-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: targets })
      });
      if (data.success) {
        const failed = (data.results || []).filter((r: { success: boolean }) => !r.success);
        if (failed.length === 0) {
          showToast("success", `已删除 ${data.success_count} 条解析记录`);
        } else {
          showToast(
            "error",
            `${failed.length} 条删除失败：${failed
              .map((f: { label: string; message: string }) => `${f.label}(${f.message})`)
              .join("；")}`
          );
        }
        setCfSelectedKeys(new Set());
        void reloadCfRecords(cfSelectedZone, true);
      } else {
        showToast("error", data.message || "批量删除解析记录失败");
      }
    } catch (e) {
      showToast("error", e instanceof Error ? e.message : "批量删除解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 打开 DigitalPlat 域名的解析记录面板（复用 CF 面板；TTL 默认 300 —— DigitalPlat 无「自动」语义）
  const handleDpOpenDnsModal = (domain: Domain) => {
    handleCfOpenDnsModal(domain);
    setCfNewTtl(300);
    setCfEditTtl(300);
    setCfBatchTtl(300);
    setCfNewProxied(false);
    setCfEditProxied(false);
    setCfBatchProxied(false);
    // DP 无代理概念、批量修改默认不勾 TTL：避免沿用 CF 会话残留的 cfBatchEditTtl=1
    //（会把 DP 记录写成非法 TTL=1）或残留的 proxied=true 强制 TTL=1。
    setCfBatchEditTtl(300);
    setCfBatchEditProxied(false);
    setCfEditFields({ name: false, content: false, ttl: false, proxied: false });
    setCfSelectedKeys(new Set());
  };
  return {
    reloadCfRecords, handleCfOpenDnsModal, handleCfCreateRecord, handleCfStartEditRecord, handleCfUpdateRecord, handleCfDeleteRecord,
    cfValidBatchLines, handleCfBatchCreate, cfSelectedRecords, cfToggleAllSelection, cfBatchEditTargets, cfBatchEditChanged,
    handleCfOpenEditPanel, handleCfBatchUpdateRecords, handleCfBatchDeleteRecords, handleDpOpenDnsModal,
  };
}

export type UseCfDnsPanelActionsReturn = ReturnType<typeof useCfDnsPanelActions>;
