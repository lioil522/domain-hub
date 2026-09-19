/**
 * DNS 解析记录面板 —— 记录表格区
 *
 * 含工具栏（计数 / 全选 / 批量修改 / 批量删除）、加载中 / 加载失败 / 空态三种状态、
 * 以及记录表格（含行内编辑）。从原单文件 `DnsRecordPanel.tsx` 拆出（UI 优化方案 P1）。
 * DOM / className / 文案逐字保留。
 */

import type { Dispatch, SetStateAction } from "react";
import { AlertTriangle, Cloud, Pencil, RefreshCw, Server, Trash2 } from "lucide-react";
import { getDnsTypeOptionsForProvider, dnsRecordKey, isCfTunnelRecord, needsDnsPriority, toRelativeRecordName } from "../../dnsrecords";
import type { DnsRecord, Domain } from "../types";
import { CustomSelect } from "../form/CustomSelect";
import { DnsLineSelect } from "../dns/DnsLineSelect";
import type { DnsPanelMeta } from "./types";
import { PROXIED_TYPES, ttlSelectOptions } from "./options";

const LINE_LABEL_MAP: Record<string, string> = {
  default: "默认",
  telecom: "电信",
  unicom: "联通",
  mobile: "移动",
  oversea: "海外",
  edu: "教育网",
};

function formatDnsLine(line?: string | null): string {
  if (!line || line === "default" || line === "默认") return "默认";
  return LINE_LABEL_MAP[line.toLowerCase()] || line;
}

export interface DnsRecordTableProps {
  zone: Domain;
  meta: DnsPanelMeta;
  actionLoading: string | null;
  records: DnsRecord[];
  loadingRecords: boolean;
  recordsError: string | null;
  onReload: (force?: boolean) => void;

  editingKey: string | null;
  setEditingKey: Dispatch<SetStateAction<string | null>>;
  editType: string;
  setEditType: (v: string) => void;
  editName: string;
  setEditName: (v: string) => void;
  editContent: string;
  setEditContent: (v: string) => void;
  editTtl: number;
  setEditTtl: (v: number) => void;
  editPriority: number;
  setEditPriority: (v: number) => void;
  editLine?: string;
  setEditLine?: (v: string) => void;
  editProxied: boolean;
  setEditProxied: (v: boolean) => void;
  onStartEditRecord: (rec: DnsRecord) => void;
  onUpdateRecord: () => void;
  onDeleteRecord: (rec: DnsRecord) => void;

  selectedKeys: Set<string>;
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>;
  onToggleAllSelection: () => void;
  editPanelOpen: boolean;
  onOpenEditPanel: () => void;
  onBatchDeleteRecords: () => void;
}

export function DnsRecordTable({
  zone,
  meta,
  actionLoading,
  records,
  loadingRecords,
  recordsError,
  onReload,
  editingKey,
  setEditingKey,
  editType,
  setEditType,
  editName,
  setEditName,
  editContent,
  setEditContent,
  editTtl,
  setEditTtl,
  editPriority,
  setEditPriority,
  editLine,
  setEditLine,
  editProxied,
  setEditProxied,
  onStartEditRecord,
  onUpdateRecord,
  onDeleteRecord,
  selectedKeys,
  setSelectedKeys,
  onToggleAllSelection,
  editPanelOpen: _editPanelOpen,
  onOpenEditPanel,
  onBatchDeleteRecords,
}: DnsRecordTableProps) {
  const toggleKey = (key: string) => {
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelectedKeys(next);
  };

  const typeOptions = getDnsTypeOptionsForProvider(meta.provider);

  return (
    <>
      {/* ===== 记录列表工具条 ===== */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-content-primary">解析记录列表</span>
          <span className="text-content-muted">（共 {records.length} 条）</span>
        </div>
        <div className="flex items-center gap-2">
          {selectedKeys.size > 0 && (
            <>
              <button
                onClick={onOpenEditPanel}
                className="px-3 py-1.5 font-semibold text-content-secondary hover:text-content-primary bg-elevated hover:bg-hovered border border-border-base rounded-lg transition-all"
              >
                批量修改（已选 {selectedKeys.size} 条）
              </button>
              <button
                onClick={onBatchDeleteRecords}
                disabled={actionLoading === "cf-batch-delete-dns"}
                className="px-3 py-1.5 font-semibold text-red-600 dark:text-red-400 hover:text-red-700 bg-elevated hover:bg-hovered border border-border-base rounded-lg transition-all disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                批量删除
              </button>
            </>
          )}
        </div>
      </div>

      {/* ===== 记录列表内容区 ===== */}
      {loadingRecords && records.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-content-muted">
          <RefreshCw className="w-6 h-6 animate-spin text-accent mb-2" />
          <span className="text-sm">正在加载解析记录...</span>
        </div>
      ) : recordsError ? (
        <div className="text-center py-10 border border-red-300/60 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 rounded-xl">
          <AlertTriangle className="w-10 h-10 text-red-500 mx-auto mb-2" />
          <p className="text-red-600 dark:text-red-400 text-sm font-semibold mb-1">解析记录加载失败</p>
          <p className="text-content-muted text-xs max-w-md mx-auto break-all">{recordsError}</p>
          <button
            onClick={() => onReload(true)}
            className="mt-3 px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-400 bg-elevated border border-red-200 dark:border-red-900/60 rounded-lg transition-all inline-flex items-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" /> 重试
          </button>
        </div>
      ) : records.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-border-base rounded-xl bg-surface">
          <Server className="w-10 h-10 text-content-muted mx-auto mb-2" />
          <p className="text-content-muted text-sm">
            {meta.isDp ? "该域名暂无解析记录，可在上方添加。" : "该 zone 下暂无解析记录，可在上方添加。"}
          </p>
        </div>
      ) : (
        <div className="border border-border-base rounded-xl overflow-x-auto bg-surface">
          {/* 诊断条：统计 AAAA 100:: 占位候选与 workerName 命中情况（始终展示，便于排查权限/接口问题） */}
          {(() => {
            const placeholders = records.filter((r) => r.type === "AAAA" && r.proxied && r.content === "100::");
            const matched = placeholders.filter((r) => r.workerName).length;
            if (placeholders.length === 0) return null;
            return (
              <div
                className={`px-3 py-2 text-[11px] rounded-lg border ${
                  matched === placeholders.length
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
                    : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
                }`}
                title="诊断信息：统计 AAAA 100:: 占位候选行数与 workerName 命中数"
              >
                [Worker 识别诊断] AAAA 100:: 占位候选 <b>{placeholders.length}</b> 条，已识别为 Worker{" "}
                <b>{matched}</b> 条
                {matched < placeholders.length &&
                  "（未识别 = 缺 Account Workers Scripts:Read 权限 / CF API 返回空 / hostname 拼写不匹配，详见 Worker 日志）"}
              </div>
            );
          })()}
          <table className="w-full text-sm min-w-[760px]">
            <thead>
              <tr className="bg-elevated text-left text-xs text-content-muted">
                <th scope="col" className="px-3 py-2.5 w-10">
                  <input
                    type="checkbox"
                    checked={selectedKeys.size === records.length && records.length > 0}
                    onChange={onToggleAllSelection}
                    className="w-4 h-4 accent-[var(--accent)]"
                    aria-label="全选解析记录"
                  />
                </th>
                <th scope="col" className="px-3 py-2.5">类型</th>
                <th scope="col" className="px-3 py-2.5">主机记录</th>
                <th scope="col" className="px-3 py-2.5">记录值</th>
                {meta.supportsLine && <th scope="col" className="px-3 py-2.5 w-24">线路</th>}
                {meta.isCloudflare && <th scope="col" className="px-3 py-2.5 w-16">代理</th>}
                <th scope="col" className="px-3 py-2.5 w-20">TTL</th>
                <th scope="col" className="px-3 py-2.5 w-28 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {records.map((rec) => {
                const key = dnsRecordKey(rec);
                const isEditing = editingKey === key;
                const relativeName = toRelativeRecordName(rec.name, zone.full_domain);
                const supportsProxied = PROXIED_TYPES.includes(rec.type);

                if (isEditing) {
                  return (
                    <tr key={key} className="border-t border-border-base bg-elevated">
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={selectedKeys.has(key)}
                          onChange={() => toggleKey(key)}
                          className="w-4 h-4 accent-[var(--accent)]"
                          aria-label="选择该记录"
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        {meta.lockedIdentity ? (
                          <span
                            className="inline-block text-xs font-bold text-accent bg-accent-soft px-2 py-1 rounded font-mono"
                            title="该托管商的 PATCH 接口仅支持修改记录值/TTL，类型不可更改"
                          >
                            {editType}
                          </span>
                        ) : (
                          <CustomSelect
                            value={editType}
                            onChange={(v) => {
                              setEditType(v);
                              if (!PROXIED_TYPES.includes(v)) setEditProxied(false);
                            }}
                            ariaLabel="记录类型"
                            options={typeOptions.map((opt) => ({ value: opt.value, label: opt.value }))}
                            className="px-2 py-1.5 rounded-lg text-xs text-content-secondary w-24"
                          />
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {meta.lockedIdentity ? (
                          <span
                            className="font-mono text-xs text-content-secondary px-1 py-1 inline-block"
                            title="该托管商的 PATCH 接口仅支持修改记录值/TTL，主机记录不可更改"
                          >
                            {editName === "@" ? "@" : editName}
                          </span>
                        ) : (
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") onUpdateRecord();
                              if (e.key === "Escape") setEditingKey(null);
                            }}
                            className="form-input px-2 py-1.5 rounded-lg text-xs text-content-secondary font-mono w-28"
                          />
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <input
                          type="text"
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") onUpdateRecord();
                            if (e.key === "Escape") setEditingKey(null);
                          }}
                          className="form-input px-2 py-1.5 rounded-lg text-xs text-content-secondary font-mono w-full min-w-[180px]"
                        />
                        {needsDnsPriority(editType) && !meta.isDp && (
                          <input
                            type="number"
                            value={editPriority}
                            onChange={(e) => setEditPriority(Number(e.target.value))}
                            placeholder="优先级"
                            className="form-input px-2 py-1.5 rounded-lg text-xs text-content-secondary w-20 mt-1.5"
                          />
                        )}
                      </td>
                      {meta.supportsLine && (
                        <td className="px-3 py-2.5">
                          {editLine !== undefined && setEditLine ? (
                            <DnsLineSelect
                              value={editLine}
                              onChange={setEditLine}
                              supported={true}
                              className="px-2 py-1.5 rounded-lg text-xs text-content-secondary w-24"
                            />
                          ) : (
                            <span className="text-content-muted text-xs">—</span>
                          )}
                        </td>
                      )}
                      {meta.isCloudflare && (
                        <td className="px-3 py-2.5">
                          {supportsProxied ? (
                            <input
                              type="checkbox"
                              checked={editProxied}
                              onChange={(e) => setEditProxied(e.target.checked)}
                              title="橙色云代理"
                              className="w-4 h-4 accent-orange-500"
                            />
                          ) : (
                            <span className="text-content-muted text-xs">—</span>
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2.5">
                        <CustomSelect
                          value={String(meta.isCloudflare && editProxied ? 1 : editTtl)}
                          onChange={(v) => setEditTtl(Number(v))}
                          disabled={meta.isCloudflare && editProxied}
                          ariaLabel="TTL"
                          options={ttlSelectOptions(meta.isCloudflare, "")}
                          className="px-2 py-1.5 rounded-lg text-xs text-content-secondary w-24"
                        />
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <button
                          onClick={onUpdateRecord}
                          disabled={actionLoading === `cf-update-dns-${key}`}
                          className="text-emerald-500 hover:text-emerald-400 font-semibold text-xs px-2 disabled:opacity-50"
                        >
                          {actionLoading === `cf-update-dns-${key}` ? "保存中" : "保存"}
                        </button>
                        <button
                          onClick={() => setEditingKey(null)}
                          className="text-content-muted hover:text-content-primary font-semibold text-xs px-2"
                        >
                          取消
                        </button>
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr key={key} className="border-t border-border-base hover:bg-hovered/50 transition-colors">
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={selectedKeys.has(key)}
                        onChange={() => toggleKey(key)}
                        className="w-4 h-4 accent-[var(--accent)]"
                        aria-label="选择该记录"
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      {rec.type === "AAAA" && rec.proxied && rec.content === "100::" && rec.workerName ? (
                        <span
                          className="text-xs font-bold text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/60 border border-orange-200 dark:border-orange-900/60 px-2 py-0.5 rounded font-mono"
                          title={`由 Cloudflare Worker「${rec.workerName}」生成，DNS 端占位为 AAAA 100::`}
                        >
                          Worker
                        </span>
                      ) : isCfTunnelRecord(rec.type, rec.content) ? (
                        <span
                          className="text-xs font-bold text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/60 border border-sky-200 dark:border-sky-900/60 px-2 py-0.5 rounded font-mono"
                          title={`Cloudflare Tunnel 公开主机名，DNS 端实际是 CNAME → ${rec.content}`}
                        >
                          隧道
                        </span>
                      ) : (
                        <span className="text-xs font-bold text-accent bg-accent-soft px-2 py-0.5 rounded font-mono">
                          {rec.type}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-content-primary text-xs">
                      {relativeName === "@" ? (
                        <span className="text-content-muted">{zone.full_domain}</span>
                      ) : (
                        `${relativeName}.${zone.full_domain}`
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-content-secondary text-xs break-all max-w-[280px]">
                      {rec.type === "AAAA" && rec.proxied && rec.content === "100::" && rec.workerName ? (
                        <span
                          className="text-orange-600 dark:text-orange-400 font-semibold"
                          title={`Worker 路由占位：${rec.workerName}`}
                        >
                          {rec.workerName}
                        </span>
                      ) : (
                        rec.content
                      )}
                    </td>
                    {meta.supportsLine && (
                      <td className="px-3 py-2.5 text-xs text-content-secondary whitespace-nowrap">
                        <span className="inline-block px-2 py-0.5 rounded bg-elevated border border-border-base text-[11px] font-medium">
                          {formatDnsLine(rec.line)}
                        </span>
                      </td>
                    )}
                    {meta.isCloudflare && (
                      <td className="px-3 py-2.5">
                        {rec.proxied ? (
                          <span className="inline-flex items-center gap-1 text-xs text-orange-500 font-semibold" title="已代理（橙色云）">
                            <Cloud className="w-3.5 h-3.5" /> 已代理
                          </span>
                        ) : supportsProxied ? (
                          <span className="inline-flex items-center gap-1 text-xs text-content-muted" title="仅 DNS（灰色云）">
                            <Cloud className="w-3.5 h-3.5 opacity-40" /> 仅 DNS
                          </span>
                        ) : (
                          <span className="text-content-muted text-xs">—</span>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2.5 font-mono text-content-secondary text-xs">
                      {Number(rec.ttl) === 1 ? "自动" : `${rec.ttl}s`}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <button
                        onClick={() => onStartEditRecord(rec)}
                        className="text-accent hover:opacity-80 font-semibold text-xs px-2"
                        title="编辑"
                        aria-label="编辑该解析记录"
                      >
                        <Pencil className="w-3.5 h-3.5 inline" />
                      </button>
                      <button
                        onClick={() => onDeleteRecord(rec)}
                        disabled={actionLoading === `cf-delete-dns-${key}`}
                        className="text-red-500 hover:text-red-400 font-semibold text-xs px-2 disabled:opacity-50"
                        title="删除"
                        aria-label="删除该解析记录"
                      >
                        <Trash2 className="w-3.5 h-3.5 inline" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
