/**
 * DNSHE 域名解析记录弹窗（Phase 4-D 从 App.tsx 抽出）
 *
 * 原实现为 App.tsx 内的内联 JSX（dnsModalOpen && selectedDomain），约 810 行，
 * 承载 DNSHE 域名的解析记录增删改查（单条添加 / 批量添加 / 行内修改 / 批量修改 /
 * 批量删除），以及桌面表格与移动端卡片两套布局。
 *
 * 与 components/DnsRecordPanel.tsx 的关系：二者并非重复组件。面板当前只接了
 * Cloudflare（App.tsx 中单处调用），且没有「解析线路」字段、没有移动端卡片、
 * 列序与按钮样式也不同 —— DNSHE 弹窗与面板的 UI 差异多达 12 处。强行合并会带来
 * 可见回归，故本 Phase 只做「整体抽出」，不改任何外观与逻辑；真正的合并推迟到
 * Phase 7 接入 DNSPod / 阿里云 / 华为云 / Vercel 时再做（那时面板才需要线路）。
 *
 * 关键行为对齐（逐行搬运，勿改）：
 * - 打开即重置各表单并拉取 /api/domains/:id/dns，顺手用返回的记录反推线路支持；
 * - 行内编辑的受控输入只定义一份（dnsRowParts），桌面表格与移动卡片共用；
 * - 批量修改只覆盖勾选的字段，未勾选的沿用每条记录原值（buildDnsEditTargets）；
 * - 批量添加 / 批量修改 / 批量删除均为后端串行提交并逐条回执。
 *
 * NOTE: 以下三项由父级注入，因为它们跨模块共享（Phase 10 再归位）：
 * - domainSupportsLine / learnLineRootFrom：设置页的线路名单管理也用；
 * - onDeleteRecord：删除单条记录的逻辑与 NameserverModal 共用（父级 handleDeleteDnsRecord）。
 *
 * NOTE（UI 优化方案 P1）：本文件现为「编排层」，弹窗各功能区已拆入同目录子组件
 * （Header / CreateForm / BatchCreate / BulkEdit / List）。所有 state 与副作用仍
 * 集中在此（纯搬运），子组件只负责渲染，DOM 结构、className、文案与原实现逐字一致。
 */

import { ModalOverlay } from "../../../../components/ModalOverlay";
import { useEffect, useMemo, useState } from "react";
import { Pencil, Save, Trash2, X } from "lucide-react";
import type { Domain } from "../../../../types/domain";
import type { DnsRecord } from "../../../../types/dns";
import { useAppData } from "../../../../state/AppDataContext";
import { Button } from "../../../../components/Button";
import { CustomSelect } from "../../../../components/form/CustomSelect";
import { DnsLineSelect } from "../../../../components/dns/DnsLineSelect";
import {
  DNS_TYPE_OPTIONS,
  buildDnsEditTargets,
  dnsRecordKey,
  needsDnsPriority,
  parseDnsBatchInput,
  toRelativeRecordName,
  type ParsedDnsLine,
} from "../../../../dnsrecords";
import type { DnsheDnsModalProps } from "./types";
import { DnsheDnsModalHeader } from "./DnsheDnsModalHeader";
import { DnsheDnsCreateForm } from "./DnsheDnsCreateForm";
import { DnsheDnsBatchCreate } from "./DnsheDnsBatchCreate";
import { DnsheDnsBulkEdit } from "./DnsheDnsBulkEdit";
import { DnsheDnsList, type DnsRowParts } from "./DnsheDnsList";

export type { DnsheDnsModalProps };

export function DnsheDnsModal({
  open,
  domain,
  onClose,
  actionLoading,
  setActionLoading,
  domainSupportsLine,
  learnLineRootFrom,
  onDomainsChanged,
  onDeleteRecord,
  refreshToken,
}: DnsheDnsModalProps) {
  const { apiFetch, showToast } = useAppData();

  // ===== 弹窗状态（原 App.tsx 的同名 state，整体内聚到组件内） =====

  // 新建 DNS 记录表单状态
  const [newDnsType, setNewDnsType] = useState("A");
  const [newDnsName, setNewDnsName] = useState("");
  const [newDnsContent, setNewDnsContent] = useState("");
  const [newDnsTtl, setNewDnsTtl] = useState(600);
  const [newDnsPriority, setNewDnsPriority] = useState<number>(10);
  const [newDnsLine, setNewDnsLine] = useState("");
  const [dnsFormOpen, setDnsFormOpen] = useState(false);

  // 行内修改解析记录状态（editingDnsKey 为 dnsRecordKey(rec)，null 表示当前没有在编辑）
  const [editingDnsKey, setEditingDnsKey] = useState<string | null>(null);
  const [editDnsType, setEditDnsType] = useState("A");
  const [editDnsName, setEditDnsName] = useState("");
  const [editDnsContent, setEditDnsContent] = useState("");
  const [editDnsTtl, setEditDnsTtl] = useState(600);
  const [editDnsPriority, setEditDnsPriority] = useState<number>(10);
  const [editDnsLine, setEditDnsLine] = useState("");

  // 批量添加解析记录面板状态（面板上的类型/主机记录/TTL 等作为每行缺省字段的默认值）
  const [dnsBatchOpen, setDnsBatchOpen] = useState(false);
  const [dnsBatchInput, setDnsBatchInput] = useState("");
  const [dnsBatchType, setDnsBatchType] = useState("A");
  const [dnsBatchName, setDnsBatchName] = useState("@");
  const [dnsBatchTtl, setDnsBatchTtl] = useState(600);
  const [dnsBatchPriority, setDnsBatchPriority] = useState<number>(10);
  const [dnsBatchLine, setDnsBatchLine] = useState("");
  const [dnsBatchResults, setDnsBatchResults] = useState<Array<{ label: string; success: boolean; message: string }> | null>(null);

  // 批量删除：已勾选的解析记录键集合
  const [selectedDnsKeys, setSelectedDnsKeys] = useState<Set<string>>(new Set());

  // 批量修改面板状态
  //
  // NOTE: 勾选哪个字段就只覆盖那个字段，其余字段沿用每条记录的原值 —— 批量选中的
  // 记录往往只有 TTL / 线路 需要统一，记录值各不相同（如 6 条不同 IP 的 AAAA），
  // 整表覆盖会把它们改成一模一样。
  const [dnsEditPanelOpen, setDnsEditPanelOpen] = useState(false);
  const [dnsEditFields, setDnsEditFields] = useState({
    type: false,
    name: false,
    content: false,
    ttl: true,
    line: false,
    priority: false,
    // DNSHE 记录没有代理开关，该字段只为满足共享的 buildDnsEditTargets 签名，恒为 false
    proxied: false
  });
  const [batchEditType, setBatchEditType] = useState("A");
  const [batchEditName, setBatchEditName] = useState("@");
  const [batchEditTtl, setBatchEditTtl] = useState(600);
  const [batchEditLine, setBatchEditLine] = useState("");
  const [batchEditPriority, setBatchEditPriority] = useState<number>(10);
  // 记录值逐条给值（键为 record_id）：勾选「记录值」后每行都能单独改，留空即保持原值
  const [batchEditContents, setBatchEditContents] = useState<Record<string, string>>({});
  const [dnsEditResults, setDnsEditResults] = useState<Array<{ label: string; success: boolean; message: string }> | null>(null);

  // 解析记录列表与加载态（原 App.tsx 的 dnsRecords / loadingDns）
  const [dnsRecords, setDnsRecords] = useState<DnsRecord[]>([]);
  const [loadingDns, setLoadingDns] = useState(false);


  // 当前勾选的记录（批量修改 / 批量删除共用）
  const selectedDnsRecords = useMemo(
    () => dnsRecords.filter((rec) => selectedDnsKeys.has(dnsRecordKey(rec))),
    [dnsRecords, selectedDnsKeys]
  );

  // 批量修改的目标记录：勾选的字段用新值，其余字段沿用每条记录的原值
  const batchEditTargets = useMemo(
    () =>
      buildDnsEditTargets(
        selectedDnsRecords,
        dnsEditFields,
        {
          type: batchEditType,
          name: batchEditName,
          content: "",
          ttl: batchEditTtl,
          line: batchEditLine,
          priority: batchEditPriority,
          proxied: false
        },
        domain?.full_domain || "",
        batchEditContents
      ),
    [
      selectedDnsRecords,
      domain,
      dnsEditFields,
      batchEditType,
      batchEditName,
      batchEditContents,
      batchEditTtl,
      batchEditLine,
      batchEditPriority
    ]
  );

  // 真正需要提交的记录：合并后与原记录完全一致的跳过，不为没变化的记录白跑一次上游
  const batchEditChanged = useMemo(
    () => batchEditTargets.filter((t) => !t.unchanged),
    [batchEditTargets]
  );

  // 面板里是否需要露出优先级：改成 MX / SRV，或选中的记录里本来就有 MX / SRV
  const batchEditNeedsPriority = dnsEditFields.type
    ? needsDnsPriority(batchEditType)
    : selectedDnsRecords.some((rec) => needsDnsPriority(rec.type));

  // 批量添加输入框的实时解析结果，供按钮显示「已识别 N 条」并复用于提交
  // NOTE: 主机记录在这里就转成相对名，让预览显示的与真正写进去的完全一致
  const parsedDnsBatchLines = useMemo(
    () =>
      parseDnsBatchInput(dnsBatchInput, {
        type: dnsBatchType,
        name: dnsBatchName,
        ttl: dnsBatchTtl,
        priority: dnsBatchPriority
      }).map((r) =>
        r ? { ...r, name: toRelativeRecordName(r.name, domain?.full_domain || "") } : null
      ),
    [dnsBatchInput, dnsBatchType, dnsBatchName, dnsBatchTtl, dnsBatchPriority, domain]
  );

  const validDnsBatchLines = useMemo(
    () => parsedDnsBatchLines.filter((r): r is ParsedDnsLine => r !== null),
    [parsedDnsBatchLines]
  );

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
  const handleCreateDnsRecord = async (e: React.FormEvent) => {
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
  const handleEditDnsKeyDown = (e: React.KeyboardEvent, recordId: string) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleUpdateDnsRecord(recordId);
    } else if (e.key === "Escape") {
      setEditingDnsKey(null);
    }
  };

  /**
   * 单条解析记录在「桌面表格行」与「手机卡片」两种布局下共用的字段节点
   *
   * NOTE: 表格行必须待在 <tbody> 里、卡片必须在表格外，两种布局无法共用一次 map；
   * 但这 6 个受控输入的定义只写这一份 —— 复制两套的话，日后改一处漏一处，
   * 行内编辑很快就会在其中一种宽度下失灵。
   */
  const dnsRowParts = (rec: DnsRecord): DnsRowParts => {
    const key = dnsRecordKey(rec);
    const isEditing = editingDnsKey === key;
    const saving = actionLoading === `update-dns-${key}`;

    return {
      key,
      isEditing,
      // ── 勾选（批量操作用）──
      checkbox: (
        <input
          type="checkbox"
          checked={selectedDnsKeys.has(key)}
          onChange={() => toggleDnsSelection(key)}
          className="w-4 h-4 accent-[var(--accent)] cursor-pointer align-middle"
        />
      ),
      // ── 编辑态控件 ──
      typeSelect: (
        <CustomSelect
          value={editDnsType}
          onChange={setEditDnsType}
          ariaLabel="记录类型"
          options={DNS_TYPE_OPTIONS.map((opt) => ({ value: opt.value, label: opt.value }))}
          className="px-2 py-1.5 rounded-lg text-xs text-content-secondary"
        />
      ),
      nameInput: (
        <input
          aria-label="主机记录"
          type="text"
          name="dns-edit-name"
          autoComplete="off"
          value={editDnsName}
          onChange={(e) => setEditDnsName(e.target.value)}
          onKeyDown={(e) => handleEditDnsKeyDown(e, key)}
          placeholder="@ 或 jp"
          title={`只能填相对名：@ 代表 ${currentDomain?.full_domain ?? ""}，jp 代表 jp.${currentDomain?.full_domain ?? ""}`}
          className="w-full form-input px-2.5 py-1.5 rounded-lg text-xs font-mono text-content-secondary"
        />
      ),
      contentInput: (
        <input
          aria-label="记录值"
          type="text"
          name="dns-edit-content"
          autoComplete="off"
          value={editDnsContent}
          onChange={(e) => setEditDnsContent(e.target.value)}
          onKeyDown={(e) => handleEditDnsKeyDown(e, key)}
          placeholder="记录值"
          className="flex-1 min-w-0 form-input px-2.5 py-1.5 rounded-lg text-xs font-mono text-content-secondary"
        />
      ),
      priorityInput: needsDnsPriority(editDnsType) ? (
        <input
          aria-label="优先级"
          type="number"
          name="dns-edit-priority"
          autoComplete="off"
          min={0}
          max={65535}
          value={editDnsPriority}
          onChange={(e) => setEditDnsPriority(parseInt(e.target.value, 10) || 0)}
          onKeyDown={(e) => handleEditDnsKeyDown(e, key)}
          title="优先级"
          className="w-16 form-input px-2 py-1.5 rounded-lg text-xs text-content-secondary"
        />
      ) : null,
      ttlInput: (
        <input
          aria-label="TTL"
          type="number"
          name="dns-edit-ttl"
          autoComplete="off"
          min={120}
          max={86400}
          value={editDnsTtl}
          onChange={(e) => setEditDnsTtl(parseInt(e.target.value, 10) || 600)}
          onKeyDown={(e) => handleEditDnsKeyDown(e, key)}
          className="w-full form-input px-2 py-1.5 rounded-lg text-xs text-content-secondary"
        />
      ),
      lineInput: (
        <DnsLineSelect
          value={editDnsLine}
          onChange={setEditDnsLine}
          supported={domainSupportsLine(currentDomain)}
          onKeyDown={(e) => handleEditDnsKeyDown(e, key)}
          className="w-full form-input px-2 py-1.5 rounded-lg text-xs text-content-secondary"
        />
      ),
      saveButton: (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          icon={<Save className="w-4 h-4" aria-hidden="true" />}
          loading={saving}
          aria-label={`保存 ${rec.type} 记录 ${rec.name} 的修改`}
          title="保存修改（回车）"
          onClick={() => handleUpdateDnsRecord(key)}
        />
      ),
      cancelButton: (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          icon={<X className="w-4 h-4" aria-hidden="true" />}
          aria-label={`取消编辑 ${rec.type} 记录 ${rec.name}`}
          title="取消（Esc）"
          onClick={() => setEditingDnsKey(null)}
        />
      ),
      // ── 展示态操作 ──
      editButton: (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          icon={<Pencil className="w-4 h-4" aria-hidden="true" />}
          aria-label={`修改 ${rec.type} 记录 ${rec.name}`}
          title="修改此记录"
          className="text-state-info-fg hover:bg-state-info-bg"
          onClick={() => handleStartEditDnsRecord(rec)}
        />
      ),
      deleteButton: (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          icon={<Trash2 className="w-4 h-4" aria-hidden="true" />}
          loading={actionLoading === `delete-dns-${key}`}
          aria-label={`删除 ${rec.type} 记录 ${rec.name}`}
          title="删除此记录"
          className="text-state-danger-fg hover:bg-state-danger-bg"
          onClick={() => onDeleteRecord(key)}
        />
      ),
    };
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

  // 打开 / 换域名时初始化：重置各表单并拉取记录列表。
  //
  // NOTE: 依赖用 domain 整体而非 domain.id —— 父级只在「打开」时设置该对象、
  // 关闭时清空，打开期间不变，故不会重复拉取。
  useEffect(() => {
    if (open && domain) void handleOpenDnsModal(domain);
  }, [open, domain]);

  // 父级（NS 弹窗路径）删除记录后递增 refreshToken，等价于原
  // dnsModalOpen && selectedDomain?.id === domain.id 时 reloadDnsRecords(domain)。
  // NOTE: 只重拉列表，不重置表单 —— 与 reloadDnsRecords 的语义一致。
  useEffect(() => {
    if (refreshToken > 0 && open && domain) void reloadDnsRecords(domain);
  }, [refreshToken]);

  // 弹窗仅在 open && domain 时渲染
  if (!open || !domain) return null;

  // 收窄后的当前域名别名：以下所有 currentDomain 引用都指向它（原 App 的 selectedDomain）。
  // NOTE: 必须放在 guard 之后，TS 才能把 Domain | null 收窄成 Domain。
  const currentDomain = domain;

  return (
    <ModalOverlay>
      <div role="dialog" aria-labelledby="dnshe-dns-modal-title" className="bg-surface border border-border-base w-full max-w-4xl max-h-[90dvh] rounded-xl overflow-hidden flex flex-col shadow-2xl">
        {/* 模态框头部 */}
        <DnsheDnsModalHeader
          domain={currentDomain}
          loadingDns={loadingDns}
          onReload={(force) => reloadDnsRecords(currentDomain, force)}
          onClose={onClose}
        />

        {/* 模态框主体 */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4 sm:space-y-6">

          {/* 新建 DNS 记录表单折叠面板 */}
          <DnsheDnsCreateForm
            currentDomain={currentDomain}
            actionLoading={actionLoading}
            domainSupportsLine={domainSupportsLine}
            dnsFormOpen={dnsFormOpen}
            setDnsFormOpen={setDnsFormOpen}
            newDnsType={newDnsType}
            setNewDnsType={setNewDnsType}
            newDnsName={newDnsName}
            setNewDnsName={setNewDnsName}
            newDnsContent={newDnsContent}
            setNewDnsContent={setNewDnsContent}
            newDnsTtl={newDnsTtl}
            setNewDnsTtl={setNewDnsTtl}
            newDnsPriority={newDnsPriority}
            setNewDnsPriority={setNewDnsPriority}
            newDnsLine={newDnsLine}
            setNewDnsLine={setNewDnsLine}
            onCreateDnsRecord={handleCreateDnsRecord}
          />

          {/* 批量添加解析记录折叠面板 */}
          <DnsheDnsBatchCreate
            currentDomain={currentDomain}
            actionLoading={actionLoading}
            domainSupportsLine={domainSupportsLine}
            dnsBatchOpen={dnsBatchOpen}
            setDnsBatchOpen={setDnsBatchOpen}
            dnsBatchInput={dnsBatchInput}
            setDnsBatchInput={setDnsBatchInput}
            dnsBatchType={dnsBatchType}
            setDnsBatchType={setDnsBatchType}
            dnsBatchName={dnsBatchName}
            setDnsBatchName={setDnsBatchName}
            dnsBatchTtl={dnsBatchTtl}
            setDnsBatchTtl={setDnsBatchTtl}
            dnsBatchPriority={dnsBatchPriority}
            setDnsBatchPriority={setDnsBatchPriority}
            dnsBatchLine={dnsBatchLine}
            setDnsBatchLine={setDnsBatchLine}
            validDnsBatchLines={validDnsBatchLines}
            parsedTotalCount={parsedDnsBatchLines.length}
            dnsBatchResults={dnsBatchResults}
            onBatchCreateDnsRecords={handleBatchCreateDnsRecords}
          />

          {/* DNS 记录列表展现 */}
          <DnsheDnsList
            dnsRecords={dnsRecords}
            loadingDns={loadingDns}
            actionLoading={actionLoading}
            selectedDnsKeys={selectedDnsKeys}
            setSelectedDnsKeys={setSelectedDnsKeys}
            toggleAllDnsSelection={toggleAllDnsSelection}
            dnsEditPanelOpen={dnsEditPanelOpen}
            setDnsEditPanelOpen={setDnsEditPanelOpen}
            handleOpenDnsEditPanel={handleOpenDnsEditPanel}
            handleBatchDeleteDnsRecords={handleBatchDeleteDnsRecords}
            bulkEditPanel={
              <DnsheDnsBulkEdit
                currentDomain={currentDomain}
                actionLoading={actionLoading}
                domainSupportsLine={domainSupportsLine}
                selectedCount={selectedDnsKeys.size}
                setDnsEditPanelOpen={setDnsEditPanelOpen}
                dnsEditFields={dnsEditFields}
                setDnsEditFields={setDnsEditFields}
                batchEditType={batchEditType}
                setBatchEditType={setBatchEditType}
                batchEditName={batchEditName}
                setBatchEditName={setBatchEditName}
                batchEditTtl={batchEditTtl}
                setBatchEditTtl={setBatchEditTtl}
                batchEditLine={batchEditLine}
                setBatchEditLine={setBatchEditLine}
                batchEditPriority={batchEditPriority}
                setBatchEditPriority={setBatchEditPriority}
                batchEditNeedsPriority={batchEditNeedsPriority}
                batchEditTargets={batchEditTargets}
                batchEditChangedCount={batchEditChanged.length}
                batchEditContents={batchEditContents}
                setBatchEditContents={setBatchEditContents}
                dnsEditResults={dnsEditResults}
                onBatchUpdateDnsRecords={handleBatchUpdateDnsRecords}
              />
            }
            dnsRowParts={dnsRowParts}
          />

        </div>

        {/* 模态框页脚 */}
        <div className="bg-elevated px-4 sm:px-6 py-4 border-t border-border-base flex justify-end flex-shrink-0">
          <button
            onClick={() => onClose()}
            className="bg-elevated hover:bg-hovered text-content-secondary text-sm font-semibold px-4 py-2 rounded-lg"
          >
            关闭
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
