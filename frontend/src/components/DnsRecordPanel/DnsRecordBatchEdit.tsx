/**
 * DNS 解析记录面板 —— 「批量修改」面板
 *
 * 从原单文件 `DnsRecordPanel.tsx` 拆出（UI 优化方案 P1）。DOM / className / 文案逐字保留。
 */

import type { Dispatch, SetStateAction } from "react";
import { Save, X } from "lucide-react";
import { Button } from "../Button";
import { CustomSelect } from "../form/CustomSelect";
import type { DnsBatchResult, DnsPanelMeta } from "./types";
import { ttlSelectOptions } from "./options";
import { DnsBatchResults } from "./DnsBatchResults";

export interface DnsRecordBatchEditProps {
  meta: DnsPanelMeta;
  actionLoading: string | null;
  selectedCount: number;

  setEditPanelOpen: Dispatch<SetStateAction<boolean>>;
  editFields: { content: boolean; ttl: boolean; proxied: boolean };
  setEditFields: Dispatch<SetStateAction<{ content: boolean; ttl: boolean; proxied: boolean }>>;
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
  meta,
  actionLoading,
  selectedCount,
  setEditPanelOpen,
  editFields,
  setEditFields,
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
      {editFields.ttl && (
        <div className="max-w-[200px]">
          <span className="block text-xs font-semibold text-content-muted mb-1.5">新 TTL</span>
          <CustomSelect
            value={String(meta.isCloudflare && batchEditProxied ? 1 : batchEditTtl)}
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
      <div className="flex items-center justify-between gap-2">
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
