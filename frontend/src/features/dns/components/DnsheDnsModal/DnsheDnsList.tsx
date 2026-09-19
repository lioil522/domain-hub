/**
 * DNSHE 解析记录弹窗 —— 记录列表区
 *
 * 含列表标题 / 多选工具条、加载中 / 空态、桌面表格（≥md）与移动端卡片（<md）
 * 两套布局。从原单文件 `DnsheDnsModal.tsx` 拆出（UI 优化方案 P1）。
 * DOM / className / 文案逐字保留。
 *
 * NOTE: 行内编辑的受控控件（typeSelect / nameInput / …）在编排层由 `dnsRowParts`
 * 生成后作为节点包传入 —— 定义仍只有一份，桌面表格与移动卡片共用（与原实现一致）。
 */

import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import type { DnsRecord } from "../../../../types/dns";

/** 单条记录在两种布局下共用的字段节点包（由编排层的 dnsRowParts 生成） */
export interface DnsRowParts {
  key: string;
  isEditing: boolean;
  checkbox: ReactNode;
  typeSelect: ReactNode;
  nameInput: ReactNode;
  contentInput: ReactNode;
  priorityInput: ReactNode;
  ttlInput: ReactNode;
  lineInput: ReactNode;
  saveButton: ReactNode;
  cancelButton: ReactNode;
  editButton: ReactNode;
  deleteButton: ReactNode;
}

export interface DnsheDnsListProps {
  dnsRecords: DnsRecord[];
  loadingDns: boolean;
  actionLoading: string | null;

  selectedDnsKeys: Set<string>;
  setSelectedDnsKeys: Dispatch<SetStateAction<Set<string>>>;
  toggleAllDnsSelection: () => void;
  dnsEditPanelOpen: boolean;
  setDnsEditPanelOpen: Dispatch<SetStateAction<boolean>>;
  handleOpenDnsEditPanel: () => void;
  handleBatchDeleteDnsRecords: () => void;

  /** 批量修改面板节点（由编排层构建，勾选且展开时才渲染） */
  bulkEditPanel: ReactNode;

  /** 生成单条记录的字段节点包（编排层闭包了全部编辑态 state） */
  dnsRowParts: (rec: DnsRecord) => DnsRowParts;
}

export function DnsheDnsList({
  dnsRecords,
  loadingDns,
  actionLoading,
  selectedDnsKeys,
  setSelectedDnsKeys,
  toggleAllDnsSelection,
  dnsEditPanelOpen,
  setDnsEditPanelOpen,
  handleOpenDnsEditPanel,
  handleBatchDeleteDnsRecords,
  bulkEditPanel,
  dnsRowParts,
}: DnsheDnsListProps) {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h4 className="text-sm font-bold text-content-primary">
          当前解析记录列表
          {dnsRecords.length > 0 && (
            <span className="ml-2 text-xs text-content-muted font-normal">共 {dnsRecords.length} 条</span>
          )}
        </h4>

        {selectedDnsKeys.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            <span className="text-xs text-content-muted">已选 {selectedDnsKeys.size} 条</span>
            <button
              onClick={() => setSelectedDnsKeys(new Set())}
              className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-2.5 py-2 sm:py-1.5 rounded-lg text-xs font-semibold"
            >
              取消选择
            </button>
            <button
              onClick={() => (dnsEditPanelOpen ? setDnsEditPanelOpen(false) : handleOpenDnsEditPanel())}
              className={`px-2.5 py-2 sm:py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 border transition-colors ${
                dnsEditPanelOpen
                  ? "bg-accent text-accent-contrast border-transparent shadow-sm"
                  : "bg-accent-soft hover:opacity-90 text-accent border-accent/20"
              }`}
              title="批量修改已勾选记录的指定字段"
            >
              <Pencil className="w-3.5 h-3.5" />
              批量修改 ({selectedDnsKeys.size})
            </button>
            <button
              onClick={handleBatchDeleteDnsRecords}
              disabled={actionLoading === "batch-delete-dns"}
              className="bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 dark:bg-red-950/60 dark:hover:bg-red-900/60 dark:text-red-300 dark:border-red-900/60 px-2.5 py-2 sm:py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50"
              title="批量删除已勾选的解析记录"
            >
              {actionLoading === "batch-delete-dns" ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
              批量删除 ({selectedDnsKeys.size})
            </button>
          </div>
        )}
      </div>

      {/* 批量修改面板：勾选哪个字段就只覆盖那个字段 */}
      {dnsEditPanelOpen && selectedDnsKeys.size > 0 && bulkEditPanel}

      {loadingDns ? (
        <div className="flex justify-center py-10">
          <RefreshCw className="w-6 h-6 animate-spin text-accent" />
        </div>
      ) : dnsRecords.length === 0 ? (
        <div className="text-center py-12 px-4 bg-elevated/40 backdrop-blur-sm rounded-2xl border border-border-base/70 text-content-muted text-sm space-y-1.5">
          <p className="font-medium text-content-secondary">暂无解析记录</p>
          <p className="text-xs text-content-muted">请点击上方按钮添加第一条记录或执行批量添加。</p>
        </div>
      ) : (
        <>
          {/* ≥md：保持原有 7 列表格（手机上这张表最小需要约 750px，只能横拖） */}
          <div className="hidden md:block bg-elevated/40 backdrop-blur-sm border border-border-base/80 rounded-2xl overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-elevated text-content-muted text-[10px] uppercase font-bold tracking-wider border-b border-border-base">
                    <th scope="col" className="p-3 w-10">
                      <input
                        type="checkbox"
                        checked={dnsRecords.length > 0 && selectedDnsKeys.size === dnsRecords.length}
                        onChange={toggleAllDnsSelection}
                        className="w-4 h-4 accent-[var(--accent)] cursor-pointer align-middle"
                        title="全选 / 取消全选"
                      />
                    </th>
                    <th scope="col" className="p-3">类型</th>
                    <th scope="col" className="p-3">主机记录</th>
                    <th scope="col" className="p-3">解析记录值</th>
                    <th scope="col" className="p-3 w-20">TTL</th>
                    <th scope="col" className="p-3 w-24">线路</th>
                    <th scope="col" className="p-3 w-20 text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-soft text-content-secondary">
                  {dnsRecords.map((rec) => {
                    const p = dnsRowParts(rec);

                    // 行内编辑态：整行换成输入控件，保存 / 取消就地完成
                    if (p.isEditing) {
                      return (
                        <tr key={p.key} className="bg-accent-soft">
                          <td className="p-3" />
                          <td className="p-2">{p.typeSelect}</td>
                          <td className="p-2">{p.nameInput}</td>
                          <td className="p-2">
                            <div className="flex items-center gap-1.5">
                              {p.contentInput}
                              {p.priorityInput}
                            </div>
                          </td>
                          <td className="p-2">{p.ttlInput}</td>
                          <td className="p-2">{p.lineInput}</td>
                          <td className="p-2">
                            <div className="flex items-center justify-center gap-1">
                              {p.saveButton}
                              {p.cancelButton}
                            </div>
                          </td>
                        </tr>
                      );
                    }

                    return (
                      <tr key={p.key} className="hover:bg-hovered">
                        <td className="p-3">{p.checkbox}</td>
                        <td className="p-3 font-bold text-xs text-accent">{rec.type}</td>
                        <td className="p-3 font-mono text-xs">{rec.name}</td>
                        <td className="p-3 font-mono text-xs break-all max-w-xs" title={rec.content}>
                          {rec.priority !== null && rec.priority !== undefined && `[优先级: ${rec.priority}] `}
                          {rec.content}
                        </td>
                        <td className="p-3 text-xs text-content-muted">{rec.ttl}</td>
                        <td className="p-3 text-xs text-content-muted">{rec.line || "默认"}</td>
                        <td className="p-3">
                          <div className="flex items-center justify-center gap-1">
                            {p.editButton}
                            {p.deleteButton}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* <md：每条记录一张卡片，字段纵向堆叠；编辑态在同一张卡里展开 */}
          <div className="md:hidden space-y-2">
            {/* 卡片模式下表头消失了，全选入口单独给一行 */}
            <label htmlFor="dnshednslist-fld1" className="flex items-center gap-2 px-1 py-1 text-xs text-content-muted">
              <input id="dnshednslist-fld1"
                type="checkbox"
                checked={dnsRecords.length > 0 && selectedDnsKeys.size === dnsRecords.length}
                onChange={toggleAllDnsSelection}
                className="w-4 h-4 accent-[var(--accent)] cursor-pointer"
              />
              全选（共 {dnsRecords.length} 条）
            </label>

            {dnsRecords.map((rec) => {
              const p = dnsRowParts(rec);

              if (p.isEditing) {
                return (
                  <div
                    key={p.key}
                    className="bg-accent-soft border border-accent/40 rounded-lg p-3 space-y-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-bold text-accent uppercase tracking-wider">
                        修改解析记录
                      </span>
                      <div className="flex items-center gap-1">
                        {p.saveButton}
                        {p.cancelButton}
                      </div>
                    </div>
                    <div>
                      <span className="block text-[11px] text-content-muted mb-1">记录类型</span>
                      {p.typeSelect}
                    </div>
                    <div>
                      <span className="block text-[11px] text-content-muted mb-1">主机记录</span>
                      {p.nameInput}
                    </div>
                    <div>
                      <span className="block text-[11px] text-content-muted mb-1">
                        记录值{p.priorityInput ? " / 优先级" : ""}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {p.contentInput}
                        {p.priorityInput}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <span className="block text-[11px] text-content-muted mb-1">TTL (秒)</span>
                        {p.ttlInput}
                      </div>
                      <div>
                        <span className="block text-[11px] text-content-muted mb-1">解析线路</span>
                        {p.lineInput}
                      </div>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={p.key}
                  className={`bg-hovered border rounded-lg p-3 space-y-2 ${
                    selectedDnsKeys.has(p.key) ? "border-accent/60" : "border-border-base"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {p.checkbox}
                    <span className="font-bold text-xs text-accent">{rec.type}</span>
                    <span className="ml-auto flex items-center gap-1">
                      {p.editButton}
                      {p.deleteButton}
                    </span>
                  </div>
                  <div className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1 text-xs">
                    <span className="text-content-muted">主机记录</span>
                    <span className="font-mono text-content-secondary break-all">{rec.name}</span>

                    <span className="text-content-muted">记录值</span>
                    <span className="font-mono text-content-secondary break-all">
                      {rec.priority !== null && rec.priority !== undefined && `[优先级: ${rec.priority}] `}
                      {rec.content}
                    </span>

                    <span className="text-content-muted">TTL</span>
                    <span className="text-content-secondary">{rec.ttl}</span>

                    <span className="text-content-muted">线路</span>
                    <span className="text-content-secondary">{rec.line || "默认"}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
