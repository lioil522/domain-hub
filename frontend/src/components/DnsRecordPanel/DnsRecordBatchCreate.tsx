/**
 * DNS 解析记录面板 —— 「批量添加解析记录」折叠面板
 *
 * 从原单文件 `DnsRecordPanel.tsx` 拆出（UI 优化方案 P1）。DOM / className / 文案逐字保留。
 */

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { Textarea } from "../form/Textarea";
import { Input } from "../form/Input";
import { ChevronDown, ChevronRight, Plus, Sparkles } from "lucide-react";
import { getDnsTypeOptionsForProvider, needsDnsPriority } from "../../dnsrecords";
import { Button } from "../Button";
import { CustomSelect } from "../form/CustomSelect";
import { DnsLineSelect } from "../dns/DnsLineSelect";
import type { DnsBatchResult, DnsPanelMeta } from "./types";
import type { Domain } from "../../types/domain";
import { displayDomainSmart } from "../../lib/display-domain";
import { PROXIED_TYPES, ttlSelectOptions } from "./options";
import { DnsBatchResults } from "./DnsBatchResults";

export interface DnsRecordBatchCreateProps {
  zone?: Domain | null;
  meta: DnsPanelMeta;
  actionLoading: string | null;

  batchOpen: boolean;
  setBatchOpen: Dispatch<SetStateAction<boolean>>;
  setFormOpen: Dispatch<SetStateAction<boolean>>;

  batchInput: string;
  setBatchInput: (v: string) => void;
  batchType: string;
  setBatchType: (v: string) => void;
  batchName: string;
  setBatchName: (v: string) => void;
  batchTtl: number;
  setBatchTtl: (v: number) => void;
  batchPriority: number;
  setBatchPriority: (v: number) => void;
  batchLine?: string;
  setBatchLine?: (v: string) => void;
  batchProxied: boolean;
  setBatchProxied: (v: boolean) => void;
  batchTextareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  validBatchLines: ReadonlyArray<unknown>;
  batchResults: DnsBatchResult[] | null;
  onBatchCreate: () => void;
}

export function DnsRecordBatchCreate({
  zone,
  meta,
  actionLoading,
  batchOpen,
  setBatchOpen,
  setFormOpen,
  batchInput,
  setBatchInput,
  batchType,
  setBatchType,
  batchName,
  setBatchName,
  batchTtl,
  setBatchTtl,
  batchPriority,
  setBatchPriority,
  batchLine,
  setBatchLine,
  batchProxied,
  setBatchProxied,
  batchTextareaRef,
  validBatchLines,
  batchResults,
  onBatchCreate,
}: DnsRecordBatchCreateProps) {
  const typeOptions = getDnsTypeOptionsForProvider(meta.provider);
  const zoneDomain = zone?.full_domain || "";

  return (
    <div className="bg-elevated/60 backdrop-blur-sm border border-border-base rounded-2xl overflow-hidden">
      <button
        onClick={() => {
          setBatchOpen(!batchOpen);
          setFormOpen(false);
        }}
        className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold text-content-secondary hover:text-content-primary transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-accent" /> 批量添加解析记录
        </span>
        {batchOpen ? <ChevronDown className="w-4 h-4 text-accent" /> : <ChevronRight className="w-4 h-4 text-accent" />}
      </button>
      {batchOpen && (
        <div className="p-4 sm:p-5 space-y-4 border-t border-border-base/60">
          <p className="text-xs text-content-muted leading-relaxed">
            每行一条记录，支持 <span className="font-mono text-accent">记录值</span> /{" "}
            <span className="font-mono text-accent">主机记录 记录值</span> /{" "}
            <span className="font-mono text-accent">类型 主机记录 记录值 [TTL] [优先级]</span>；
            字段分隔符优先级为 <span className="font-mono">竖线 &gt; 逗号 &gt; 空格</span>
            （TXT 记录值本身含空格时请改用竖线或逗号分隔），<span className="font-mono">#</span> 开头的行会被忽略。
            未写明的字段取下方默认值，单次最多 50 条。
            主机记录只能是相对名 —— <span className="font-mono text-accent">@</span> 代表{" "}
            <span className="font-mono">{displayDomainSmart(zoneDomain)}</span>，
            填完整域名会自动剥成相对名。
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
            <div>
              <span className="block text-xs font-semibold text-content-muted mb-1.5">记录类型</span>
              <CustomSelect
                value={batchType}
                onChange={setBatchType}
                ariaLabel="记录类型"
                options={typeOptions}
                className="w-full px-3.5 py-2 rounded-xl text-sm text-content-secondary"
              />
            </div>

            <div>
              <label htmlFor="dnsrecordbatchcreate-fld1" className="block text-xs font-semibold text-content-muted mb-1.5">主机记录</label>
              <Input id="dnsrecordbatchcreate-fld1" size="sm" mono
                type="text"
                name="cf-batch-name"
                autoComplete="off"
                value={batchName}
                onChange={(e) => setBatchName(e.target.value)}
                placeholder="例如 @ 或 www"
                className="w-full text-content-secondary rounded-xl"
              />
            </div>

            <div>
              <span className="block text-xs font-semibold text-content-muted mb-1.5">TTL (秒)</span>
              <CustomSelect
                value={String(meta.isCloudflare && batchProxied ? 1 : batchTtl)}
                onChange={(v) => setBatchTtl(Number(v))}
                disabled={meta.isCloudflare && batchProxied}
                ariaLabel="TTL (秒)"
                options={ttlSelectOptions(meta.isCloudflare)}
                className="w-full px-3.5 py-2 rounded-xl text-sm text-content-secondary"
              />
            </div>

            {needsDnsPriority(batchType) && (
              meta.isDp ? (
                <div>
                  <span className="block text-xs font-semibold text-content-muted mb-1.5">优先级</span>
                  <p className="text-[11px] text-content-muted leading-relaxed pt-1.5">
                    DigitalPlat 无独立优先级字段，MX/SRV 请在每行写在记录值前缀（如{" "}
                    <span className="font-mono">10 mail.example.com</span>）
                  </p>
                </div>
              ) : (
                <div>
                  <label htmlFor="dnsrecordbatchcreate-fld2" className="block text-xs font-semibold text-content-muted mb-1.5">
                    优先级
                  </label>
                  <Input id="dnsrecordbatchcreate-fld2" size="sm"
                    type="number"
                    name="cf-batch-priority"
                    autoComplete="off"
                    value={batchPriority}
                    onChange={(e) => setBatchPriority(Number(e.target.value))}
                    className="w-full text-content-secondary rounded-xl"
                  />
                </div>
              )
            )}

            {meta.supportsLine && batchLine !== undefined && setBatchLine && (
              <div>
                <span className="block text-xs font-semibold text-content-muted mb-1.5">解析线路</span>
                <DnsLineSelect
                  value={batchLine}
                  onChange={setBatchLine}
                  supported={true}
                  className="w-full form-input px-3.5 py-2 rounded-xl text-sm text-content-secondary"
                />
              </div>
            )}
          </div>

          <Textarea
            id="cf-batch-input"
            rows={6}
            mono
            resizable
            name="cf-batch-records"
            autoComplete="off"
            spellCheck={false}
            value={batchInput}
            onChange={(e) => setBatchInput(e.target.value)}
            ref={batchTextareaRef}
            placeholder={"2001:db8::5010:e191\n2001:db8::527:8a4e\nAAAA ipv6 2001:db8::e095:d9aa\nA www 192.0.2.1 600\nMX @ mail.example.com 600 10"}
            className="w-full text-content-primary rounded-xl text-sm font-mono"
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            {meta.isCloudflare && PROXIED_TYPES.includes(batchType) ? (
              <label htmlFor="dnsrecordbatchcreate-fld3" className="flex items-center gap-2 text-xs text-content-secondary cursor-pointer select-none">
                <input id="dnsrecordbatchcreate-fld3"
                  type="checkbox"
                  checked={batchProxied}
                  onChange={(e) => setBatchProxied(e.target.checked)}
                  className="w-4 h-4 accent-orange-500"
                />
                默认开启代理（仅对 A/AAAA/CNAME 行生效）
              </label>
            ) : (
              <span />
            )}
            <Button
              onClick={onBatchCreate}
              disabled={validBatchLines.length === 0}
              loading={actionLoading === "cf-batch-create-dns"}
              variant="primary"
              size="sm"
              icon={<Plus className="w-4 h-4" />}
            >
              开始批量添加{validBatchLines.length > 0 ? `（已识别 ${validBatchLines.length} 条）` : ""}
            </Button>
          </div>
          {batchResults && <DnsBatchResults results={batchResults} />}
        </div>
      )}
    </div>
  );
}
