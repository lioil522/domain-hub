/**
 * DNS 解析记录面板（模态框）
 *
 * 承载 DNSHE / Cloudflare / DigitalPlat / DNSPod / 阿里云 / 华为云 / Vercel
 * 七家的解析记录增删改查界面 —— 后端按 `domain.account_provider` 分发到对应
 * 上游客户端，前端这边是**同一套 UI**，差异只有：
 *
 *   1. 面板副标题与刷新按钮的文案（`meta` 传入）
 *   2. 是否有代理开关（Cloudflare 专有，`isCloudflare` 控制）
 *   3. 是否有「自动 TTL」选项（Cloudflare 专有，hasAutoTtl 控制）
 *   4. 编辑态能否改记录类型/主机名（DP 与四家新托管商的上游 PATCH 只收
 *      记录值/TTL，`lockedIdentity` 控制为只读展示）
 *
 * WHY 做成纯展示组件（状态与处理函数全部 props 传入）：
 * 抽离的目的是让这一千余行 JSX 从 `App.tsx` 里挪出来，而不是重写数据流。
 * 业务逻辑仍留在 `App.tsx`，本组件对它们一无所知 —— 这样重构的行为风险
 * 最低（纯搬运，无逻辑改动），也保留了后续把逻辑逐步下沉的空间。
 *
 * 代价是 props 较多（约 50 个）。这是刻意的取舍：props 多但每一个都是
 * 显式命名的，比"把半个 App 塞进 context"更容易追踪和类型检查。
 *
 * NOTE（UI 优化方案 P1）：本文件现为「编排层」，各功能区已拆入同目录子组件
 * （Header / CreateForm / BatchCreate / BatchEdit / Table），此文件只负责按
 * 原有顺序组合它们。DOM 结构、className、文案仍与原实现逐字一致。
 */

import { ModalOverlay } from "../ModalOverlay";
import type { DnsRecordPanelProps } from "./types";
import { DnsRecordPanelHeader } from "./DnsRecordPanelHeader";
import { DnsRecordCreateForm } from "./DnsRecordCreateForm";
import { DnsRecordBatchCreate } from "./DnsRecordBatchCreate";
import { DnsRecordBatchEdit } from "./DnsRecordBatchEdit";
import { DnsRecordTable } from "./DnsRecordTable";

export function DnsRecordPanel(props: DnsRecordPanelProps) {
  const { open, zone, meta, onClose, selectedKeys, editPanelOpen, batchEditChanged } = props;

  // 面板可见时才渲染（对齐原先 `{cfDnsModalOpen && cfSelectedZone && ...}` 的行为）
  if (!open || !zone) return null;

  return (
    <ModalOverlay>
      <div role="dialog" aria-labelledby="dns-record-panel-title" className="bg-surface border border-border-base w-full max-w-5xl max-h-[90dvh] rounded-xl flex flex-col shadow-2xl">
        {/* 头部：域名与操作 */}
        <DnsRecordPanelHeader
          zone={zone}
          meta={meta}
          loadingRecords={props.loadingRecords}
          onReload={props.onReload}
          onClose={onClose}
        />

        <div className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
          {/* ===== 新建记录折叠面板 ===== */}
          <DnsRecordCreateForm
            meta={meta}
            actionLoading={props.actionLoading}
            formOpen={props.formOpen}
            setFormOpen={props.setFormOpen}
            setBatchOpen={props.setBatchOpen}
            newType={props.newType}
            setNewType={props.setNewType}
            newLine={props.newLine}
            setNewLine={props.setNewLine}
            newName={props.newName}
            setNewName={props.setNewName}
            newContent={props.newContent}
            setNewContent={props.setNewContent}
            newTtl={props.newTtl}
            setNewTtl={props.setNewTtl}
            newPriority={props.newPriority}
            setNewPriority={props.setNewPriority}
            newProxied={props.newProxied}
            setNewProxied={props.setNewProxied}
            onCreateRecord={props.onCreateRecord}
          />

          {/* ===== 批量添加折叠面板 ===== */}
          <DnsRecordBatchCreate
            meta={meta}
            actionLoading={props.actionLoading}
            batchOpen={props.batchOpen}
            setBatchOpen={props.setBatchOpen}
            setFormOpen={props.setFormOpen}
            batchInput={props.batchInput}
            setBatchInput={props.setBatchInput}
            batchType={props.batchType}
            setBatchType={props.setBatchType}
            batchLine={props.batchLine}
            setBatchLine={props.setBatchLine}
            batchName={props.batchName}
            setBatchName={props.setBatchName}
            batchTtl={props.batchTtl}
            setBatchTtl={props.setBatchTtl}
            batchPriority={props.batchPriority}
            setBatchPriority={props.setBatchPriority}
            batchProxied={props.batchProxied}
            setBatchProxied={props.setBatchProxied}
            batchTextareaRef={props.batchTextareaRef}
            validBatchLines={props.validBatchLines}
            batchResults={props.batchResults}
            onBatchCreate={props.onBatchCreate}
          />

          {/* ===== 批量修改折叠面板 ===== */}
          {selectedKeys.size > 0 && editPanelOpen && (
            <DnsRecordBatchEdit
              meta={meta}
              actionLoading={props.actionLoading}
              selectedCount={selectedKeys.size}
              setEditPanelOpen={props.setEditPanelOpen}
              editFields={props.editFields}
              setEditFields={props.setEditFields}
              batchEditTtl={props.batchEditTtl}
              setBatchEditTtl={props.setBatchEditTtl}
              batchEditProxied={props.batchEditProxied}
              setBatchEditProxied={props.setBatchEditProxied}
              batchEditContents={props.batchEditContents}
              setBatchEditContents={props.setBatchEditContents}
              batchEditTargets={props.batchEditTargets}
              batchEditChangedCount={batchEditChanged.length}
              editResults={props.editResults}
              onBatchUpdateRecords={props.onBatchUpdateRecords}
            />
          )}

          {/* ===== 记录列表工具条 + 表格 ===== */}
          <DnsRecordTable
            zone={zone}
            meta={meta}
            actionLoading={props.actionLoading}
            records={props.records}
            loadingRecords={props.loadingRecords}
            recordsError={props.recordsError}
            onReload={props.onReload}
            editingKey={props.editingKey}
            setEditingKey={props.setEditingKey}
            editType={props.editType}
            setEditType={props.setEditType}
            editLine={props.editLine}
            setEditLine={props.setEditLine}
            editName={props.editName}
            setEditName={props.setEditName}
            editContent={props.editContent}
            setEditContent={props.setEditContent}
            editTtl={props.editTtl}
            setEditTtl={props.setEditTtl}
            editPriority={props.editPriority}
            setEditPriority={props.setEditPriority}
            editProxied={props.editProxied}
            setEditProxied={props.setEditProxied}
            onStartEditRecord={props.onStartEditRecord}
            onUpdateRecord={props.onUpdateRecord}
            onDeleteRecord={props.onDeleteRecord}
            selectedKeys={selectedKeys}
            setSelectedKeys={props.setSelectedKeys}
            onToggleAllSelection={props.onToggleAllSelection}
            editPanelOpen={editPanelOpen}
            onOpenEditPanel={props.onOpenEditPanel}
            onBatchDeleteRecords={props.onBatchDeleteRecords}
          />
        </div>
      </div>
    </ModalOverlay>
  );
}
