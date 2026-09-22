/**
 * DNS 解析记录面板 —— 「批量修改」面板
 *
 * 从原单文件 `DnsRecordPanel.tsx` 拆出（UI 优化方案 P1）。支持批量修改主机记录、记录值、TTL 与代理状态。
 */

import type { Dispatch, SetStateAction } from "react";
import { Save, X } from "lucide-react";
import { Button } from "../Button";
import { CustomSelect } from "../form/CustomSelect";
import type { DnsBatchResult, DnsPanelMeta } from "./types";
import type { Domain } from "../../types/domain";
import { displayDomainSmart } from "../../lib/display-domain";
import { ttlSelectOptions } from "./options";
import { DnsBatchResults } from "./DnsBatchResults";

export interface DnsRecordBatchEditProps {
  zone?: Domain | null;
  meta: DnsPanelMeta;
  actionLoading: string | null;
  selectedCount: number;

  setEditPanelOpen: Dispatch<SetStateAction<boolean>>;
  editFields: { name: boolean; content: boolean; ttl: boolean; proxied: boolean };
  setEditFields: Dispatch<SetStateAction<{ name: boolean; content: boolean; ttl: boolean; proxied: boolean }>>;
  batchEditName?: string;
  setBatchEditName?: (v: string) => void;
  batchEditTtl: number;
  setBatchEditTtl: (v: number) => void;
  batchEditProxied: boolean;
  setBatchEditProxied: (v: boolean) => void;
  batchEditContents: Record<string, string>;
  setBatchEditContents: Dispatch<SetStateAction<Record<string, string>>>;
  batchEditTargets: Array<{ record_id: string; label: string; origin_content?: string }>;
  batchEditChangedCount: number;
  editResults: DnsBatchResult[] | null;
  onBatchUpdateRecords: () => void;
}

export function DnsRecordBatchEdit({
  zone,
  meta,
  actionLoading,
  selectedCount,
  setEditPanelOpen,
  editFields,
  setEditFields,
  batchEditName,
  setBatchEditName,
  batchEditTtl,
  setBatchEditTtl,
  batchEditProxied,
  setBatchEditProxied,
  batchEditContents,
  setBatchEditContents,
  batchEditTargets,
  batchEditChangedCount,
  editResults,
  onBatchUpdateRecords,
}: DnsRecordBatchEditProps) {
  return (
    <div className="bg-elevated border border-accent/40 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-content-primary">批量修改 {selectedCount} 条记录</h4>
        <button
          onClick={() => setEditPanelOpen(false)}
          className="text-content-muted hover:text-content-primary"
          aria-label="收起批量修改面板"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex flex-wrap gap-4 text-xs text-content-secondary">
        <label htmlFor="dnsrecordbatchedit-fld-name" className="flex items-center gap-1.5 cursor-pointer">
          <input id="dnsrecordbatchedit-fld-name"
            type="checkbox"
            checked={Boolean(editFields.name)}
            onChange={(e) => setEditFields({ ...editFields, name: e.target.checked })}
            className="w-4 h-4 accent-[var(--accent)]"
          />
          主机记录
        </label>
        <label htmlFor="dnsrecordbatchedit-fld1" className="flex items-center gap-1.5 cursor-pointer">
          <input id="dnsrecordbatchedit-fld1"
            type="checkbox"
            checked={editFields.content}
            onChange={(e) => setEditFields({ ...editFields, content: e.target.checked })}
            className="w-4 h-4 accent-[var(--accent)]"
          />
          记录值（可逐条编辑）
        </label>
        <label htmlFor="dnsrecordbatchedit-fld2" className="flex items-center gap-1.5 cursor-pointer">
          <input id="dnsrecordbatchedit-fld2"
            type="checkbox"
            checked={editFields.ttl}
            onChange={(e) => setEditFields({ ...editFields, ttl: e.target.checked })}
            className="w-4 h-4 accent-[var(--accent)]"
          />
          TTL
        </label>
        {meta.isCloudflare && (
          <label htmlFor="dnsrecordbatchedit-fld3" className="flex items-center gap-1.5 cursor-pointer">
            <input id="dnsrecordbatchedit-fld3"
              type="checkbox"
              checked={editFields.proxied}
              onChange={(e) => setEditFields({ ...editFields, proxied: e.target.checked })}
              className="w-4 h-4 accent-[var(--accent)]"
            />
            代理开关
          </label>
        )}
      </div>

      {editFields.name && (
        <div className="space-y-1.5 pt-1">
          <label htmlFor="dnsrecordbatchedit-name-input" className="block text-xs font-semibold text-content-muted">
            新主机记录
          </label>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <input
              id="dnsrecordbatchedit-name-input"
              type="text"
              name="cf-bulk-name"
              autoComplete="off"
              placeholder="例如 @ 或 www"
              value={batchEditName ?? ""}
              onChange={(e) => setBatchEditName?.(e.target.value)}
              className="w-full sm:max-w-xs form-input px-3 py-2 rounded-xl text-xs font-mono text-content-primary"
            />
            <span className="text-[11px] text-content-muted">
              只能填相对名 —— <span className="font-mono text-accent">@</span> 代表{" "}
              <span className="font-mono">{displayDomainSmart(zone?.full_domain || "")}</span>
              ，所有选中的记录将被统一切换为此主机记录
            </span>
          </div>
        </div>
      )}

      {editFields.ttl && (
        <div className="max-w-[200px]">
          <span className="block text-xs font-semibold text-content-muted mb-1.5">新 TTL</span>
          <CustomSelect
            value={String(meta.isCloudflare ? (batchEditProxied ? 1 : (batchEditTtl || 1)) : (batchEditTtl && batchEditTtl > 1 ? batchEditTtl : 300))}
            onChange={(v) => setBatchEditTtl(Number(v))}
            disabled={meta.isCloudflare && editFields.proxied && batchEditProxied}
            ariaLabel="新 TTL"
            options={ttlSelectOptions(meta.isCloudflare)}
            className="px-3 py-2 rounded-lg text-sm text-content-secondary"
          />
        </div>
      )}

      {meta.isCloudflare && editFields.proxied && (
        <label htmlFor="dnsrecordbatchedit-fld4" className="flex items-center gap-2 text-xs text-content-secondary cursor-pointer select-none">
          <input id="dnsrecordbatchedit-fld4"
            type="checkbox"
            checked={batchEditProxied}
            onChange={(e) => setBatchEditProxied(e.target.checked)}
            className="w-4 h-4 accent-orange-500"
          />
          将选中记录设为{batchEditProxied ? "已代理（橙色云，TTL 固定自动）" : "仅 DNS（灰色云）"}
        </label>
      )}

      {editFields.content && (
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {batchEditTargets.map((t) => (
            <div key={t.record_id} className="flex items-center gap-2 text-xs">
              <span className="font-mono text-content-muted truncate max-w-[40%] flex-shrink-0" title={t.label}>
                {t.label}
              </span>
              <input
                type="text"
                value={batchEditContents[t.record_id] ?? ""}
                onChange={(e) => setBatchEditContents({ ...batchEditContents, [t.record_id]: e.target.value })}
                placeholder={t.origin_content || "保持原值"}
                className="flex-1 form-input px-2.5 py-1.5 rounded-lg text-xs text-content-secondary font-mono min-w-0"
              />
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-xs text-content-muted">
          将提交 {batchEditChangedCount} 条修改（未变化的自动跳过）
        </span>
        <Button
          onClick={onBatchUpdateRecords}
          disabled={batchEditChangedCount === 0}
          loading={actionLoading === "cf-batch-update-dns"}
          variant="primary"
          size="sm"
          icon={<Save className="w-4 h-4" />}
        >
          提交修改
        </Button>
      </div>
      {editResults && <DnsBatchResults results={editResults} />}
    </div>
  );
}
