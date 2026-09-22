/**
 * DNSHE 解析记录弹窗 —— 「批量添加解析记录」折叠面板
 *
 * 现代化流玻表单：圆润 rounded-xl 边框、统一 accent 色彩体系。
 */

import type { Dispatch, SetStateAction } from "react";
import { Textarea } from "../../../../components/form/Textarea";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Play, RefreshCw, Sparkles, X } from "lucide-react";
import { CustomSelect } from "../../../../components/form/CustomSelect";
import { DnsLineSelect } from "../../../../components/dns/DnsLineSelect";
import { DNS_TYPE_OPTIONS, needsDnsPriority } from "../../../../dnsrecords";
import type { Domain } from "../../../../types/domain";
import type { DnsBatchResult } from "./types";

/** 解析预览行（主机记录已转相对名） */
interface ParsedPreviewLine {
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
}

export interface DnsheDnsBatchCreateProps {
  currentDomain: Domain;
  actionLoading: string | null;
  domainSupportsLine: (dom: Domain | null | undefined) => boolean;

  dnsBatchOpen: boolean;
  setDnsBatchOpen: Dispatch<SetStateAction<boolean>>;

  dnsBatchInput: string;
  setDnsBatchInput: (v: string) => void;
  dnsBatchType: string;
  setDnsBatchType: (v: string) => void;
  dnsBatchName: string;
  setDnsBatchName: (v: string) => void;
  dnsBatchTtl: number;
  setDnsBatchTtl: (v: number) => void;
  dnsBatchPriority: number;
  setDnsBatchPriority: (v: number) => void;
  dnsBatchLine: string;
  setDnsBatchLine: (v: string) => void;

  /** 输入框实时解析出的有效行（含相对名，用于「已识别 N 条」与预览） */
  validDnsBatchLines: ParsedPreviewLine[];
  /** 解析总数（含无法解析的行，用于「有 N 行无法解析」提示） */
  parsedTotalCount: number;
  dnsBatchResults: DnsBatchResult[] | null;

  onBatchCreateDnsRecords: () => void;
}

export function DnsheDnsBatchCreate({
  currentDomain,
  actionLoading,
  domainSupportsLine,
  dnsBatchOpen,
  setDnsBatchOpen,
  dnsBatchInput,
  setDnsBatchInput,
  dnsBatchType,
  setDnsBatchType,
  dnsBatchName,
  setDnsBatchName,
  dnsBatchTtl,
  setDnsBatchTtl,
  dnsBatchPriority,
  setDnsBatchPriority,
  dnsBatchLine,
  setDnsBatchLine,
  validDnsBatchLines,
  parsedTotalCount,
  dnsBatchResults,
  onBatchCreateDnsRecords,
}: DnsheDnsBatchCreateProps) {
  return (
    <div className="bg-elevated/60 backdrop-blur-sm border border-border-base rounded-2xl overflow-hidden [isolation:isolate] transition-all">
      <button
        onClick={() => setDnsBatchOpen(!dnsBatchOpen)}
        className="w-full px-4 py-3 hover:bg-hovered/50 flex justify-between items-center text-sm font-semibold text-content-secondary transition-colors"
      >
        <span className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-accent" />
          <span>{dnsBatchOpen ? "隐藏批量添加面板" : "批量添加解析记录"}</span>
        </span>
        <div className="flex items-center gap-2">
          {!dnsBatchOpen && (
            <span className="text-[11px] text-content-muted font-normal hidden sm:inline">一行一条，缺省字段取下方默认值</span>
          )}
          {dnsBatchOpen ? (
            <ChevronDown className="w-4 h-4 text-accent transition-transform" />
          ) : (
            <ChevronRight className="w-4 h-4 text-accent transition-transform" />
          )}
        </div>
      </button>

      {dnsBatchOpen && (
        <div className="p-4 sm:p-5 space-y-4 border-t border-border-base/60">
          <p className="text-xs text-content-muted leading-relaxed">
            每行一条记录，支持 <span className="font-mono text-accent">记录值</span> /
            <span className="font-mono text-accent"> 主机记录 记录值</span> /
            <span className="font-mono text-accent"> 类型 主机记录 记录值 [TTL] [优先级]</span>；
            字段分隔符优先级为 <span className="font-mono">竖线 &gt; 逗号 &gt; 空格</span>
            （TXT 记录值本身含空格时请改用竖线或逗号分隔），<span className="font-mono">#</span> 开头的行会被忽略。
            未写明的字段取下方默认值，单次最多 50 条。
            主机记录只能是相对名 —— <span className="font-mono text-accent">@</span> 代表
            <span className="font-mono"> {currentDomain.full_domain}</span>，
            填完整域名会自动剥成相对名。
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
            <div>
              <span className="block text-xs font-semibold text-content-muted mb-1.5">记录类型</span>
              <CustomSelect
                ariaLabel="记录类型"
                value={dnsBatchType}
                onChange={setDnsBatchType}
                options={DNS_TYPE_OPTIONS}
                className="w-full px-3.5 py-2 rounded-xl text-sm text-content-primary"
              />
            </div>

            <div>
              <label htmlFor="dnshednsbatchcreate-fld1" className="block text-xs font-semibold text-content-muted mb-1.5">主机记录</label>
              <input
                id="dnshednsbatchcreate-fld1"
                type="text"
                name="dns-batch-name"
                autoComplete="off"
                placeholder="例如 @ 或 www"
                value={dnsBatchName}
                onChange={(e) => setDnsBatchName(e.target.value)}
                className="w-full form-input px-3.5 py-2.5 rounded-xl text-sm text-content-primary"
              />
            </div>

            <div>
              <label htmlFor="dnshednsbatchcreate-fld2" className="block text-xs font-semibold text-content-muted mb-1.5">TTL (秒)</label>
              <input
                id="dnshednsbatchcreate-fld2"
                type="number"
                name="dns-batch-ttl"
                autoComplete="off"
                min={120}
                max={86400}
                value={dnsBatchTtl}
                onChange={(e) => setDnsBatchTtl(parseInt(e.target.value, 10) || 600)}
                className="w-full form-input px-3.5 py-2.5 rounded-xl text-sm text-content-primary"
              />
            </div>

            {needsDnsPriority(dnsBatchType) && (
              <div>
                <label htmlFor="dnshednsbatchcreate-fld3" className="block text-xs font-semibold text-content-muted mb-1.5">优先级</label>
                <input
                  id="dnshednsbatchcreate-fld3"
                  type="number"
                  name="dns-batch-priority"
                  autoComplete="off"
                  min={0}
                  max={65535}
                  value={dnsBatchPriority}
                  onChange={(e) => setDnsBatchPriority(parseInt(e.target.value, 10) || 0)}
                  className="w-full form-input px-3.5 py-2.5 rounded-xl text-sm text-content-primary"
                />
              </div>
            )}

            <div>
              <span className="block text-xs font-semibold text-content-muted mb-1.5">解析线路</span>
              <DnsLineSelect
                value={dnsBatchLine}
                onChange={setDnsBatchLine}
                supported={domainSupportsLine(currentDomain)}
                className="w-full form-input px-3.5 py-2 rounded-xl text-sm text-content-primary"
              />
            </div>
          </div>

          <Textarea
            mono
            resizable
            value={dnsBatchInput}
            onChange={(e) => setDnsBatchInput(e.target.value)}
            rows={6}
            name="dns-batch-input"
            autoComplete="off"
            spellCheck={false}
            placeholder={"2001:db8::5010:e191\n2001:db8::527:8a4e\nAAAA ipv6 2001:db8::e095:d9aa\nA www 192.0.2.1 600\nMX @ mail.example.com 600 10"}
            className="w-full rounded-xl text-content-primary text-sm font-mono"
          />

          <button
            onClick={onBatchCreateDnsRecords}
            disabled={actionLoading === "batch-create-dns" || validDnsBatchLines.length === 0}
            className="w-full btn-primary py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50 shadow-sm transition-all"
          >
            {actionLoading === "batch-create-dns" ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" /> 正在逐条提交…
              </>
            ) : (
              <>
                <Play className="w-4 h-4" /> 开始批量添加 (已识别 {validDnsBatchLines.length} 条)
              </>
            )}
          </button>

          {parsedTotalCount > validDnsBatchLines.length && (
            <p className="text-xs text-amber-400 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              有 {parsedTotalCount - validDnsBatchLines.length} 行无法解析（缺少记录值），提交时会自动跳过
            </p>
          )}

          {validDnsBatchLines.length > 0 && (
            <div className="max-h-40 overflow-y-auto pr-1 space-y-1">
              {validDnsBatchLines.map((r, idx) => (
                <div key={idx} className="text-[11px] font-mono text-content-muted flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-accent font-bold w-12 shrink-0">{r.type}</span>
                  <span className="w-20 sm:w-24 shrink-0 truncate" title={r.name}>{r.name}</span>
                  <span className="w-full sm:flex-1 sm:w-auto truncate text-content-secondary" title={r.content}>{r.content}</span>
                  <span className="shrink-0">TTL {r.ttl}</span>
                  {r.priority !== undefined && <span className="shrink-0">优先级 {r.priority}</span>}
                </div>
              ))}
            </div>
          )}

          {dnsBatchResults && dnsBatchResults.length > 0 && (
            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {dnsBatchResults.map((r, idx) => (
                <div
                  key={idx}
                  className={`flex items-start justify-between gap-2 text-xs px-3 py-2 rounded-xl border ${
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
      )}
    </div>
  );
}
