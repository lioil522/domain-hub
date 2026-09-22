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
import { useEffect, useMemo } from "react";
import { Pencil, Save, Trash2, X } from "lucide-react";
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
import { useDnsheDnsModalState } from "./useDnsheDnsModalState";
import { useDnsheDnsModalActions } from "./useDnsheDnsModalActions";

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

  // ===== 弹窗状态：集中在独立 state boundary，业务 handlers 留在本编排层 =====
  const modalState = useDnsheDnsModalState();
  const {
    newDnsType, setNewDnsType, newDnsName, setNewDnsName, newDnsContent, setNewDnsContent,
    newDnsTtl, setNewDnsTtl, newDnsPriority, setNewDnsPriority, newDnsLine, setNewDnsLine,
    dnsFormOpen, setDnsFormOpen,
    editingDnsKey, setEditingDnsKey, editDnsType, setEditDnsType, editDnsName, setEditDnsName,
    editDnsContent, setEditDnsContent, editDnsTtl, setEditDnsTtl, editDnsPriority, setEditDnsPriority,
    editDnsLine, setEditDnsLine,
    dnsBatchOpen, setDnsBatchOpen, dnsBatchInput, setDnsBatchInput, dnsBatchType, setDnsBatchType,
    dnsBatchName, setDnsBatchName, dnsBatchTtl, setDnsBatchTtl, dnsBatchPriority, setDnsBatchPriority,
    dnsBatchLine, setDnsBatchLine, dnsBatchResults,
    selectedDnsKeys, setSelectedDnsKeys,
    dnsEditPanelOpen, setDnsEditPanelOpen, dnsEditFields, setDnsEditFields,
    batchEditType, setBatchEditType, batchEditName, setBatchEditName, batchEditTtl, setBatchEditTtl,
    batchEditLine, setBatchEditLine, batchEditPriority, setBatchEditPriority,
    batchEditContents, setBatchEditContents, dnsEditResults,
    dnsRecords, loadingDns,
  } = modalState;

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
        name: dnsBatchName.trim() || "@",
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

  const {
    handleOpenDnsModal, reloadDnsRecords, handleCreateDnsRecord, handleStartEditDnsRecord,
    handleUpdateDnsRecord, handleEditDnsKeyDown, toggleDnsSelection, toggleAllDnsSelection,
    handleOpenDnsEditPanel, handleBatchUpdateDnsRecords, handleBatchDeleteDnsRecords,
    handleBatchCreateDnsRecords,
  } = useDnsheDnsModalActions({
    state: modalState,
    apiFetch,
    showToast,
    domain,
    setActionLoading,
    learnLineRootFrom,
    onDomainsChanged,
    selectedDnsRecords,
    batchEditTargets,
    batchEditChanged,
    validDnsBatchLines,
  });

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
