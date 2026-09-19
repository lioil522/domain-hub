/**
 * DNSHE 解析记录弹窗 —— 「批量修改」面板
 *
 * 从原单文件 `DnsheDnsModal.tsx` 拆出（UI 优化方案 P1）。DOM / className / 文案逐字保留。
 */

import type { Dispatch, SetStateAction } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Pencil, RefreshCw, Save, X } from "lucide-react";
import { CustomSelect } from "../../../../components/form/CustomSelect";
import { DnsLineSelect } from "../../../../components/dns/DnsLineSelect";
import { DNS_TYPE_OPTIONS, type DnsEditFieldFlags, type DnsEditTarget } from "../../../../dnsrecords";
import type { Domain } from "../../../../types/domain";
import type { DnsBatchResult } from "./types";

export interface DnsheDnsBulkEditProps {
  currentDomain: Domain;
  actionLoading: string | null;
  domainSupportsLine: (dom: Domain | null | undefined) => boolean;

  selectedCount: number;
  setDnsEditPanelOpen: Dispatch<SetStateAction<boolean>>;

  dnsEditFields: DnsEditFieldFlags;
  setDnsEditFields: Dispatch<SetStateAction<DnsEditFieldFlags>>;

  batchEditType: string;
  setBatchEditType: (v: string) => void;
  batchEditName: string;
  setBatchEditName: (v: string) => void;
  batchEditTtl: number;
  setBatchEditTtl: (v: number) => void;
  batchEditLine: string;
  setBatchEditLine: (v: string) => void;
  batchEditPriority: number;
  setBatchEditPriority: (v: number) => void;

  /** 面板里是否需要露出优先级（改成 MX/SRV 或选中记录含 MX/SRV） */
  batchEditNeedsPriority: boolean;
  /** 合并后的目标记录（勾选字段用新值，其余沿用原值） */
  batchEditTargets: DnsEditTarget[];
  /** 真正发生变化的条数 */
  batchEditChangedCount: number;
  batchEditContents: Record<string, string>;
  setBatchEditContents: Dispatch<SetStateAction<Record<string, string>>>;

  dnsEditResults: DnsBatchResult[] | null;
  onBatchUpdateDnsRecords: () => void;
}

export function DnsheDnsBulkEdit({
  currentDomain,
  actionLoading,
  domainSupportsLine,
  selectedCount,
  setDnsEditPanelOpen,
  dnsEditFields,
  setDnsEditFields,
  batchEditType,
  setBatchEditType,
  batchEditName,
  setBatchEditName,
  batchEditTtl,
  setBatchEditTtl,
  batchEditLine,
  setBatchEditLine,
  batchEditPriority,
  setBatchEditPriority,
  batchEditNeedsPriority,
  batchEditTargets,
  batchEditChangedCount,
  batchEditContents,
  setBatchEditContents,
  dnsEditResults,
  onBatchUpdateDnsRecords,
}: DnsheDnsBulkEditProps) {
  return (
    <div className="mb-3 border border-accent/30 bg-accent-soft rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h5 className="text-xs font-bold text-accent flex items-center gap-1.5">
          <Pencil className="w-3.5 h-3.5" />
          批量修改 {selectedCount} 条记录
        </h5>
        <span className="text-[10px] text-content-muted hidden sm:inline">只有勾选的字段会被覆盖，其余字段保留各自原值</span>
      </div>
      <p className="text-[11px] text-content-muted sm:hidden -mt-2">只有勾选的字段会被覆盖，其余保留原值</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* 记录类型 */}
        <label htmlFor="dnshednsbulkedit-fld1" className="flex items-center gap-2">
          <input id="dnshednsbulkedit-fld1"
            type="checkbox"
            checked={dnsEditFields.type}
            onChange={(e) => setDnsEditFields({ ...dnsEditFields, type: e.target.checked })}
            className="w-4 h-4 accent-[var(--accent)] cursor-pointer shrink-0"
          />
          <span className="text-xs text-content-secondary w-20 shrink-0">记录类型</span>
          <div className="flex-1 min-w-0">
            <CustomSelect
              value={batchEditType}
              onChange={setBatchEditType}
              options={DNS_TYPE_OPTIONS}
              disabled={!dnsEditFields.type}
              className="w-full px-2 py-1.5 rounded text-xs text-content-secondary"
            />
          </div>
        </label>

        {/* TTL */}
        <label htmlFor="dnshednsbulkedit-fld2" className="flex items-center gap-2">
          <input id="dnshednsbulkedit-fld2"
            type="checkbox"
            checked={dnsEditFields.ttl}
            onChange={(e) => setDnsEditFields({ ...dnsEditFields, ttl: e.target.checked })}
            className="w-4 h-4 accent-[var(--accent)] cursor-pointer shrink-0"
          />
          <span className="text-xs text-content-secondary w-20 shrink-0">TTL (秒)</span>
          <input
            type="number"
            name="dns-bulk-ttl"
            autoComplete="off"
            min={120}
            max={86400}
            value={batchEditTtl}
            onChange={(e) => setBatchEditTtl(parseInt(e.target.value, 10) || 600)}
            disabled={!dnsEditFields.ttl}
            className="flex-1 form-input px-2 py-1.5 rounded text-xs text-content-secondary disabled:opacity-40"
          />
        </label>

        {/* 主机记录 */}
        <label htmlFor="dnshednsbulkedit-fld3" className="flex items-center gap-2">
          <input id="dnshednsbulkedit-fld3"
            type="checkbox"
            checked={dnsEditFields.name}
            onChange={(e) => setDnsEditFields({ ...dnsEditFields, name: e.target.checked })}
            className="w-4 h-4 accent-[var(--accent)] cursor-pointer shrink-0"
          />
          <span className="text-xs text-content-secondary w-20 shrink-0">主机记录</span>
          <input
            type="text"
            name="dns-bulk-name"
            autoComplete="off"
            placeholder="@ 或 jp"
            title={`只能填相对名：@ 代表 ${currentDomain.full_domain}`}
            value={batchEditName}
            onChange={(e) => setBatchEditName(e.target.value)}
            disabled={!dnsEditFields.name}
            className="flex-1 form-input px-2 py-1.5 rounded text-xs font-mono text-content-secondary disabled:opacity-40"
          />
        </label>

        {/* 解析线路 */}
        <label htmlFor="dnshednsbulkedit-fld4" className="flex items-center gap-2">
          <input id="dnshednsbulkedit-fld4"
            type="checkbox"
            checked={dnsEditFields.line}
            onChange={(e) => setDnsEditFields({ ...dnsEditFields, line: e.target.checked })}
            disabled={!domainSupportsLine(currentDomain)}
            className="w-4 h-4 accent-[var(--accent)] cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          />
          <span className="text-xs text-content-secondary w-20 shrink-0">解析线路</span>
          <DnsLineSelect
            value={batchEditLine}
            onChange={setBatchEditLine}
            supported={domainSupportsLine(currentDomain)}
            disabled={!dnsEditFields.line}
            className="flex-1 form-input px-2 py-1.5 rounded text-xs text-content-secondary disabled:opacity-40"
          />
        </label>

        {/* 记录值：只在这里开关，具体新值在下方逐条编辑 */}
        <label htmlFor="dnshednsbulkedit-fld5" className="flex items-center gap-2 md:col-span-2">
          <input id="dnshednsbulkedit-fld5"
            type="checkbox"
            checked={dnsEditFields.content}
            onChange={(e) => setDnsEditFields({ ...dnsEditFields, content: e.target.checked })}
            className="w-4 h-4 accent-[var(--accent)] cursor-pointer shrink-0"
          />
          <span className="text-xs text-content-secondary w-20 shrink-0">记录值</span>
          <span className="text-[11px] text-content-muted">
            {dnsEditFields.content
              ? "在下方逐条编辑各自的新记录值，不改的行保持原值"
              : "勾选后可在下方逐条编辑记录值"}
          </span>
        </label>

        {/* 优先级：仅在改成 MX / SRV 或选中记录含 MX / SRV 时出现 */}
        {batchEditNeedsPriority && (
          <label htmlFor="dnshednsbulkedit-fld6" className="flex items-center gap-2">
            <input id="dnshednsbulkedit-fld6"
              type="checkbox"
              checked={dnsEditFields.priority}
              onChange={(e) => setDnsEditFields({ ...dnsEditFields, priority: e.target.checked })}
              className="w-4 h-4 accent-[var(--accent)] cursor-pointer shrink-0"
            />
            <span className="text-xs text-content-secondary w-20 shrink-0">优先级</span>
            <input
              type="number"
              name="dns-bulk-priority"
              autoComplete="off"
              min={0}
              max={65535}
              value={batchEditPriority}
              onChange={(e) => setBatchEditPriority(parseInt(e.target.value, 10) || 0)}
              disabled={!dnsEditFields.priority}
              className="flex-1 form-input px-2 py-1.5 rounded text-xs text-content-secondary disabled:opacity-40"
            />
          </label>
        )}
      </div>

      {/* 记录值逐条编辑时，提示重复值会造成重复记录（上游通常直接拒绝） */}
      {dnsEditFields.content && (() => {
        const values = batchEditTargets.map((t) => `${t.type}|${t.name}|${t.content}`);
        const dupCount = values.length - new Set(values).size;
        return dupCount > 0 ? (
          <p className="text-xs text-amber-400 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            有 {dupCount} 条记录的「类型 + 主机记录 + 记录值」与其它行重复，上游可能拒绝写入
          </p>
        ) : null;
      })()}

      {/* 变更预览：逐条显示「原记录 → 改后」；勾了记录值时该列可就地编辑 */}
      <div className="max-h-56 overflow-y-auto pr-1 space-y-1">
        {batchEditTargets.map((t) => (
          <div
            key={t.record_id}
            /* NOTE: 窄屏改为纵向两段（原记录 / 改后），横排 7 段在手机上必然溢出 */
            className={`text-[11px] font-mono flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 rounded px-1 py-1 sm:py-0.5 border-b border-border-soft sm:border-0 last:border-0 ${
              t.unchanged ? "opacity-45" : ""
            }`}
            title={t.unchanged ? "与原记录一致，提交时会跳过" : undefined}
          >
            <span className="text-content-muted flex-1 truncate min-w-0" title={t.label}>{t.label}</span>
            <ChevronRight className="w-3 h-3 text-content-muted shrink-0 rotate-90 sm:rotate-0" />
            <span className="flex items-center gap-2 min-w-0 sm:contents">
              <span className="text-accent shrink-0">{t.type}</span>
              <span className="text-content-secondary shrink-0 max-w-[7rem] truncate" title={t.name}>{t.name}</span>
            </span>
            {dnsEditFields.content ? (
              <input
                type="text"
                name={`dns-bulk-content-${t.record_id}`}
                autoComplete="off"
                value={batchEditContents[t.record_id] ?? ""}
                onChange={(e) =>
                  setBatchEditContents({ ...batchEditContents, [t.record_id]: e.target.value })
                }
                placeholder={t.origin_content}
                title="留空则保持原记录值"
                className="flex-1 min-w-0 form-input px-2 py-1 rounded text-[11px] font-mono text-content-secondary"
              />
            ) : (
              <span className="text-content-secondary flex-1 truncate min-w-0" title={t.content}>{t.content}</span>
            )}
            <span className="flex items-center gap-2 sm:contents">
              <span className="text-content-muted shrink-0">TTL {t.ttl}</span>
              {t.priority !== undefined && <span className="text-content-muted shrink-0">优先级 {t.priority}</span>}
              <span className="text-content-muted shrink-0">{t.line || "默认线路"}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={onBatchUpdateDnsRecords}
          disabled={actionLoading === "batch-update-dns" || batchEditChangedCount === 0}
          className="flex-1 btn-primary py-2 rounded-lg font-semibold text-sm text-white flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {actionLoading === "batch-update-dns" ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" /> 正在逐条提交…
            </>
          ) : (
            <>
              <Save className="w-4 h-4" />
              {batchEditChangedCount === 0
                ? "没有需要提交的修改"
                : `应用到 ${batchEditChangedCount} 条记录${
                    batchEditChangedCount < batchEditTargets.length
                      ? `（跳过 ${batchEditTargets.length - batchEditChangedCount} 条无变化）`
                      : ""
                  }`}
            </>
          )}
        </button>
        <button
          onClick={() => setDnsEditPanelOpen(false)}
          className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-4 py-2 rounded-lg text-sm font-semibold"
        >
          取消
        </button>
      </div>

      {/* 逐条提交结果回执 */}
      {dnsEditResults && dnsEditResults.length > 0 && (
        <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
          {dnsEditResults.map((r, idx) => (
            <div
              key={idx}
              className={`flex items-start justify-between gap-2 text-xs px-3 py-2 rounded-lg border ${
                r.success
                  ? "bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-500/10 dark:border-emerald-500/30 dark:text-emerald-300"
                  : "bg-red-50 border-red-200 text-red-700 dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-300"
              }`}
            >
              <div className="font-mono min-w-0 truncate" title={r.label}>{r.label}</div>
              <div className="flex items-center gap-1 shrink-0">
                {r.success ? <CheckCircle2 className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                <span>{r.success ? "成功" : r.message}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
