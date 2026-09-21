import type { FormEvent, KeyboardEvent } from "react";
import type { ApiFetch } from "../../../../api/client";
import type { Domain } from "../../../../types/domain";
import type { DnsRecord } from "../../../../types/dns";
import { dnsRecordKey, needsDnsPriority, toRelativeRecordName, type DnsEditTarget, type ParsedDnsLine } from "../../../../dnsrecords";
import type { useDnsheDnsModalState } from "./useDnsheDnsModalState";

type Toast = (kind: "success" | "error" | "info" | "warning", message: string) => void;
type ModalState = ReturnType<typeof useDnsheDnsModalState>;

export type DnsheDnsModalActionsOptions = {
  state: ModalState;
  apiFetch: ApiFetch;
  showToast: Toast;
  domain: Domain | null;
  setActionLoading: (value: string | null) => void;
  learnLineRootFrom: (domain: Domain, records: DnsRecord[]) => void;
  onDomainsChanged: () => void;
  selectedDnsRecords: DnsRecord[];
  batchEditTargets: DnsEditTarget[];
  batchEditChanged: DnsEditTarget[];
  validDnsBatchLines: ParsedDnsLine[];
};

export function useDnsheDnsModalActions({
  state, apiFetch, showToast, domain, setActionLoading,
  learnLineRootFrom, onDomainsChanged, selectedDnsRecords,
  batchEditTargets, batchEditChanged, validDnsBatchLines,
}: DnsheDnsModalActionsOptions) {
  const {
    newDnsType, setNewDnsType, newDnsName, setNewDnsName, newDnsContent, setNewDnsContent,
    newDnsTtl, setNewDnsTtl, newDnsPriority, setNewDnsPriority, newDnsLine, setNewDnsLine,
    setDnsFormOpen, setEditingDnsKey, editDnsType, setEditDnsType, editDnsName, setEditDnsName,
    editDnsContent, setEditDnsContent, editDnsTtl, setEditDnsTtl, editDnsPriority, setEditDnsPriority,
    editDnsLine, setEditDnsLine, setDnsBatchOpen, setDnsBatchInput, setDnsBatchType, setDnsBatchName,
    setDnsBatchTtl, setDnsBatchPriority, setDnsBatchLine, setDnsBatchResults, selectedDnsKeys,
    setSelectedDnsKeys, setDnsEditPanelOpen, setDnsEditFields, setDnsEditResults, dnsRecords, setDnsRecords, setLoadingDns,
    setBatchEditType, setBatchEditName, setBatchEditTtl, setBatchEditLine, setBatchEditPriority,
    setBatchEditContents, dnsEditFields, dnsBatchLine,
  } = state;

  const currentDomain = domain;

  // 打开 DNS 管理面板
  const handleOpenDnsModal = async (domain: Domain, forceRefresh = false) => {
    setDnsRecords([]);
    setDnsFormOpen(false);

    // 初始化表单字段
    setNewDnsName("");
    setNewDnsContent("");
    setNewDnsType("A");
    setNewDnsTtl(600);
    setNewDnsPriority(10);
    setNewDnsLine("");

    // 初始化批量添加面板
    setDnsBatchOpen(false);
    setDnsBatchInput("");
    setDnsBatchType("A");
    setDnsBatchName("@");
    setDnsBatchTtl(600);
    setDnsBatchPriority(10);
    setDnsBatchLine("");
    setDnsBatchResults(null);

    // 初始化批量修改面板
    setDnsEditPanelOpen(false);
    setDnsEditFields({ type: false, name: false, content: false, ttl: true, line: false, priority: false, proxied: false });
    setDnsEditResults(null);

    await reloadDnsRecords(domain, forceRefresh);
  };

  // 拉取解析记录列表（只刷新列表，不重置弹窗内已展开的表单与批量结果）
  const reloadDnsRecords = async (domain: Domain, forceRefresh = false) => {
    setLoadingDns(true);
    // 记录集合变了，之前的勾选与行内编辑都可能指向已不存在的行，一并作废
    setSelectedDnsKeys(new Set());
    setEditingDnsKey(null);
    // 批量修改面板依赖勾选，勾选清空后面板也没有意义（结果回执保留给用户看）
    setDnsEditPanelOpen(false);

    try {
      const res = await apiFetch(`/api/domains/${domain.id}/dns${forceRefresh ? "?refresh=1" : ""}`);
      const data = await res.json();
      if (data.success) {
        const records: DnsRecord[] = data.records || [];
        setDnsRecords(records);
        // 顺手确认根域是否支持线路（数据本来就要读，零额外上游调用）
        learnLineRootFrom(domain, records);
      } else {
        showToast("error", data.message || "加载 DNS 解析记录失败");
      }
    } catch (e) {
      showToast("error", "加载 DNS 记录发生网络异常");
    } finally {
      setLoadingDns(false);
    }
  };

  // 创建新 DNS 记录
  const handleCreateDnsRecord = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentDomain) return;
    if (!newDnsContent.trim()) {
      showToast("error", "解析记录值不能为空！");
      return;
    }

    setActionLoading("create-dns");
    try {
      const res = await apiFetch(`/api/domains/${currentDomain.id}/dns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: newDnsType,
          name: newDnsName || "@",
          content: newDnsContent,
          ttl: newDnsTtl,
          priority: needsDnsPriority(newDnsType) ? newDnsPriority : undefined,
          line: newDnsLine || undefined
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", "DNS 解析记录创建成功！");
        setNewDnsName("");
        setNewDnsContent("");
        setDnsFormOpen(false);
        reloadDnsRecords(currentDomain);
        onDomainsChanged();
      } else {
        showToast("error", data.message || "创建解析记录失败");
      }
    } catch (err) {
      showToast("error", "创建解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 进入某条记录的行内编辑态：把当前值灌进编辑表单
  const handleStartEditDnsRecord = (rec: DnsRecord) => {
    setEditingDnsKey(dnsRecordKey(rec));
    setEditDnsType(rec.type || "A");
    // 上游读到的是完整域名，编辑框里要显示相对名（@ / jp），否则改完提交会被上游拒绝
    setEditDnsName(toRelativeRecordName(rec.name, currentDomain?.full_domain || ""));
    setEditDnsContent(rec.content || "");
    setEditDnsTtl(rec.ttl > 0 ? rec.ttl : 600);
    setEditDnsPriority(rec.priority !== null && rec.priority !== undefined ? rec.priority : 10);
    setEditDnsLine(rec.line || "");
  };

  // 提交行内修改
  const handleUpdateDnsRecord = async (recordId: string | number) => {
    if (!currentDomain) return;
    if (!editDnsContent.trim()) {
      showToast("error", "解析记录值不能为空！");
      return;
    }

    setActionLoading(`update-dns-${recordId}`);
    try {
      const res = await apiFetch(`/api/domains/${currentDomain.id}/dns/${recordId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: editDnsType,
          name: editDnsName.trim() || "@",
          content: editDnsContent.trim(),
          ttl: editDnsTtl,
          priority: needsDnsPriority(editDnsType) ? editDnsPriority : undefined,
          line: editDnsLine.trim() || undefined
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", "DNS 解析记录修改成功！");
        setEditingDnsKey(null);
        reloadDnsRecords(currentDomain);
        onDomainsChanged();
      } else {
        showToast("error", data.message || "修改解析记录失败");
      }
    } catch (e) {
      showToast("error", "修改解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 行内编辑的键盘操作：回车保存、Esc 取消（表格行里放不了 <form>，只能手工绑定）
  const handleEditDnsKeyDown = (e: KeyboardEvent, recordId: string) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleUpdateDnsRecord(recordId);
    } else if (e.key === "Escape") {
      setEditingDnsKey(null);
    }
  };

  // 勾选 / 取消勾选单条记录（用于批量删除）
  const toggleDnsSelection = (key: string) => {
    const next = new Set(selectedDnsKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setSelectedDnsKeys(next);
  };

  // 全选 / 取消全选当前列表
  const toggleAllDnsSelection = () => {
    if (selectedDnsKeys.size === dnsRecords.length) {
      setSelectedDnsKeys(new Set());
    } else {
      setSelectedDnsKeys(new Set(dnsRecords.map(dnsRecordKey)));
    }
  };

  // 打开批量修改面板：默认值取第一条选中记录，避免面板一开就是空的
  const handleOpenDnsEditPanel = () => {
    const first = selectedDnsRecords[0];
    if (first) {
      setBatchEditType(first.type || "A");
      setBatchEditName(toRelativeRecordName(first.name, currentDomain?.full_domain || ""));
      setBatchEditTtl(first.ttl > 0 ? first.ttl : 600);
      setBatchEditLine(first.line || "");
      setBatchEditPriority(first.priority !== null && first.priority !== undefined ? first.priority : 10);
    }
    // 逐条记录值预填各自原值，用户只改需要改的那几行
    setBatchEditContents(
      Object.fromEntries(selectedDnsRecords.map((rec) => [dnsRecordKey(rec), rec.content || ""]))
    );
    setDnsEditResults(null);
    setDnsEditPanelOpen(true);
  };

  // 批量修改已勾选的解析记录（后端串行提交并逐条回执）
  const handleBatchUpdateDnsRecords = async () => {
    if (!currentDomain || batchEditTargets.length === 0) return;

    const enabled = Object.entries(dnsEditFields).filter(([, on]) => on).map(([k]) => k);
    if (enabled.length === 0) {
      showToast("error", "请至少勾选一个要修改的字段");
      return;
    }
    if (batchEditChanged.length === 0) {
      showToast("info", "选中的记录与当前值一致，没有需要提交的修改");
      return;
    }
    if (batchEditChanged.length > 50) {
      showToast("error", "单次最多批量修改 50 条解析记录");
      return;
    }

    setActionLoading("batch-update-dns");
    setDnsEditResults(null);
    try {
      const res = await apiFetch(`/api/domains/${currentDomain.id}/dns/batch-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: batchEditChanged })
      });
      const data = await res.json();
      if (data.success) {
        setDnsEditResults(data.results || []);
        if (data.fail_count === 0) {
          showToast("success", `已修改 ${data.success_count} 条解析记录`);
          setDnsEditPanelOpen(false);
        } else {
          showToast(
            "warning",
            data.error_code === "ns_management_disabled"
              ? "DNSHE 上游平台已禁用 NS 管理，NS 记录无法通过 API 修改。请前往 DNSHE 官网后台手动设置。"
              : `批量修改完成：成功 ${data.success_count} 条，失败 ${data.fail_count} 条（详见下方明细）`
          );
        }
        reloadDnsRecords(currentDomain);
        onDomainsChanged();
      } else {
        showToast("error", data.message || "批量修改解析记录失败");
      }
    } catch (e) {
      showToast("error", "批量修改解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 批量删除已勾选的解析记录（后端串行删除并逐条回执）
  const handleBatchDeleteDnsRecords = async () => {
    if (!currentDomain || selectedDnsKeys.size === 0) return;

    const targets = selectedDnsRecords.map((rec) => ({
      record_id: dnsRecordKey(rec),
      label: `${rec.type} ${rec.name} → ${rec.content}`
    }));

    if (
      !confirm(
        `确定要删除选中的 ${targets.length} 条 DNS 解析记录吗？这会立即影响该域名的解析！\n\n${targets
          .map((t) => t.label)
          .join("\n")}`
      )
    ) {
      return;
    }

    setActionLoading("batch-delete-dns");
    try {
      const res = await apiFetch(`/api/domains/${currentDomain.id}/dns/batch-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: targets })
      });
      const data = await res.json();
      if (data.success) {
        const failed = (data.results || []).filter((r: { success: boolean }) => !r.success);
        if (failed.length === 0) {
          showToast("success", `已删除 ${data.success_count} 条解析记录`);
        } else {
          showToast(
            "error",
            data.error_code === "ns_management_disabled"
              ? "DNSHE 上游平台已禁用 NS 管理，NS 记录无法通过 API 删除。请前往 DNSHE 官网后台手动设置。"
              : `${failed.length} 条删除失败：${failed
                  .map((f: { label: string; message: string }) => `${f.label}(${f.message})`)
                  .join("；")}`
          );
        }
        reloadDnsRecords(currentDomain);
        onDomainsChanged();
      } else {
        showToast("error", data.message || "批量删除解析记录失败");
      }
    } catch (e) {
      showToast("error", "批量删除解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 批量添加解析记录
  const handleBatchCreateDnsRecords = async () => {
    if (!currentDomain) return;

    if (validDnsBatchLines.length === 0) {
      showToast("error", "未能解析出任何有效的解析记录，请检查输入格式");
      return;
    }
    if (validDnsBatchLines.length > 50) {
      showToast("error", "单次最多批量添加 50 条解析记录");
      return;
    }

    const records = validDnsBatchLines.map((r) => ({
      ...r,
      line: dnsBatchLine.trim() || undefined
    }));

    setActionLoading("batch-create-dns");
    setDnsBatchResults(null);
    try {
      const res = await apiFetch(`/api/domains/${currentDomain.id}/dns/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records })
      });
      const data = await res.json();
      if (data.success) {
        setDnsBatchResults(data.results || []);
        if (data.fail_count === 0) {
          showToast("success", `已添加 ${data.success_count} 条解析记录`);
          setDnsBatchInput("");
        } else {
          showToast(
            "warning",
            data.error_code === "ns_management_disabled"
              ? "DNSHE 上游平台已禁用 NS 管理，NS 记录无法通过 API 添加。请前往 DNSHE 官网后台手动设置。"
              : `批量添加完成：成功 ${data.success_count} 条，失败 ${data.fail_count} 条（详见下方明细）`
          );
        }
        reloadDnsRecords(currentDomain);
        onDomainsChanged();
      } else {
        showToast("error", data.message || "批量添加解析记录失败");
      }
    } catch (e) {
      showToast("error", "批量添加解析记录请求失败");
    } finally {
      setActionLoading(null);
    }
  };


  return {
    handleOpenDnsModal, reloadDnsRecords, handleCreateDnsRecord, handleStartEditDnsRecord,
    handleUpdateDnsRecord, handleEditDnsKeyDown, toggleDnsSelection, toggleAllDnsSelection,
    handleOpenDnsEditPanel, handleBatchUpdateDnsRecords, handleBatchDeleteDnsRecords,
    handleBatchCreateDnsRecords,
  };
}
