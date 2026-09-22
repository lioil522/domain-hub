/**
 * DNS 解析记录面板 —— 「添加解析记录」折叠表单
 *
 * 从原单文件 `DnsRecordPanel.tsx` 拆出（UI 优化方案 P1）。DOM / className / 文案逐字保留。
 */

import type { Dispatch, SetStateAction } from "react";
import { Input } from "../form/Input";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { getDnsTypeOptionsForProvider, needsDnsPriority } from "../../dnsrecords";
import { Button } from "../Button";
import { CustomSelect } from "../form/CustomSelect";
import { DnsLineSelect } from "../dns/DnsLineSelect";
import type { DnsPanelMeta } from "./types";
import { PROXIED_TYPES, ttlSelectOptions } from "./options";

export interface DnsRecordCreateFormProps {
  meta: DnsPanelMeta;
  actionLoading: string | null;

  formOpen: boolean;
  setFormOpen: Dispatch<SetStateAction<boolean>>;
  setBatchOpen: Dispatch<SetStateAction<boolean>>;

  newType: string;
  setNewType: (v: string) => void;
  newName: string;
  setNewName: (v: string) => void;
  newContent: string;
  setNewContent: (v: string) => void;
  newTtl: number;
  setNewTtl: (v: number) => void;
  newPriority: number;
  setNewPriority: (v: number) => void;
  newLine?: string;
  setNewLine?: (v: string) => void;
  newProxied: boolean;
  setNewProxied: (v: boolean) => void;
  onCreateRecord: () => void;
}

export function DnsRecordCreateForm({
  meta,
  actionLoading,
  formOpen,
  setFormOpen,
  setBatchOpen,
  newType,
  setNewType,
  newName,
  setNewName,
  newContent,
  setNewContent,
  newTtl,
  setNewTtl,
  newPriority,
  setNewPriority,
  newLine,
  setNewLine,
  newProxied,
  setNewProxied,
  onCreateRecord,
}: DnsRecordCreateFormProps) {
  const typeOptions = getDnsTypeOptionsForProvider(meta.provider);

  return (
    <div className="bg-elevated/60 backdrop-blur-sm border border-border-base rounded-2xl overflow-hidden">
      <button
        onClick={() => {
          setFormOpen(!formOpen);
          setBatchOpen(false);
        }}
        className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold text-content-secondary hover:text-content-primary transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <Plus className="w-4 h-4 text-accent" /> 添加解析记录
        </span>
        {formOpen ? <ChevronDown className="w-4 h-4 text-accent" /> : <ChevronRight className="w-4 h-4 text-accent" />}
      </button>
      {formOpen && (
        <div className="px-4 pb-4 space-y-3 border-t border-border-base/60 pt-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <span className="block text-xs font-semibold text-content-muted mb-1.5">记录类型</span>
              <CustomSelect
                value={newType}
                onChange={(v) => {
                  setNewType(v);
                  if (!PROXIED_TYPES.includes(v)) setNewProxied(false);
                }}
                ariaLabel="记录类型"
                options={typeOptions}
                className="w-full px-3.5 py-2 rounded-xl text-sm text-content-secondary"
              />
            </div>
            <div>
              <label htmlFor="dnsrecordcreateform-fld1" className="block text-xs font-semibold text-content-muted mb-1.5">主机记录</label>
              <Input id="dnsrecordcreateform-fld1" size="sm" mono
                type="text"
                name="cf-new-name"
                autoComplete="off"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="例如 @ 或 www"
                className="w-full text-content-secondary rounded-xl"
              />
            </div>
            <div>
              <span className="block text-xs font-semibold text-content-muted mb-1.5">TTL (秒)</span>
              <CustomSelect
                value={String(meta.isCloudflare ? (newProxied ? 1 : (newTtl || 1)) : (newTtl && newTtl > 1 ? newTtl : 300))}
                onChange={(v) => setNewTtl(Number(v))}
                disabled={meta.isCloudflare && newProxied}
                title={meta.isCloudflare && newProxied ? "开启代理时 Cloudflare 固定使用自动 TTL" : undefined}
                ariaLabel="TTL (秒)"
                options={ttlSelectOptions(meta.isCloudflare)}
                className="w-full px-3.5 py-2 rounded-xl text-sm text-content-secondary"
              />
            </div>
            {meta.isDp ? (
              <div>
                <span className="block text-xs font-semibold text-content-muted mb-1.5">优先级</span>
                <p className="text-[11px] text-content-muted leading-relaxed pt-1.5">
                  DigitalPlat 无独立优先级字段，MX/SRV 请写在记录值前缀（如{" "}
                  <span className="font-mono">10 mail.example.com</span>）
                </p>
              </div>
            ) : (
              <div>
                <label htmlFor="dnsrecordcreateform-fld2" className="block text-xs font-semibold text-content-muted mb-1.5">
                  优先级 {needsDnsPriority(newType) ? "" : "(无需)"}
                </label>
                <Input id="dnsrecordcreateform-fld2" size="sm"
                  type="number"
                  name="cf-new-priority"
                  autoComplete="off"
                  value={newPriority}
                  onChange={(e) => setNewPriority(Number(e.target.value))}
                  disabled={!needsDnsPriority(newType)}
                  className="w-full text-content-secondary disabled:opacity-50 disabled:cursor-not-allowed rounded-xl"
                />
              </div>
            )}
          </div>
          <div>
            <label htmlFor="dnsrecordcreateform-fld3" className="block text-xs font-semibold text-content-muted mb-1.5">记录值 Content</label>
            <Input id="dnsrecordcreateform-fld3" size="sm" mono
              type="text"
              name="cf-new-content"
              autoComplete="off"
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="如 192.0.2.1 / example.com / v=spf1 ..."
              className="w-full text-content-secondary rounded-xl"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            {meta.supportsLine && newLine !== undefined && setNewLine ? (
              <div className="flex items-center gap-2 text-xs">
                <span className="font-semibold text-content-muted whitespace-nowrap">解析线路:</span>
                <DnsLineSelect
                  value={newLine}
                  onChange={setNewLine}
                  supported={true}
                  className="px-3.5 py-1.5 rounded-xl text-xs text-content-secondary min-w-[120px]"
                />
              </div>
            ) : meta.isCloudflare ? (
              PROXIED_TYPES.includes(newType) ? (
                <label htmlFor="dnsrecordcreateform-fld4" className="flex items-center gap-2 text-xs text-content-secondary cursor-pointer select-none">
                  <input id="dnsrecordcreateform-fld4"
                    type="checkbox"
                    checked={newProxied}
                    onChange={(e) => setNewProxied(e.target.checked)}
                    className="w-4 h-4 accent-orange-500"
                  />
                  开启代理（橙色云，隐藏源站 IP，TTL 固定自动）
                </label>
              ) : (
                <span className="text-[11px] text-content-muted">该记录类型不支持 Cloudflare 代理</span>
              )
            ) : (
              <span />
            )}
            <Button
              onClick={onCreateRecord}
              loading={actionLoading === "cf-create-dns"}
              variant="primary"
              size="sm"
              icon={<Plus className="w-4 h-4" />}
            >
              创建记录
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
