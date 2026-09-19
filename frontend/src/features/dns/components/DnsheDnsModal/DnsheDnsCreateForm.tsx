/**
 * DNSHE 解析记录弹窗 —— 「添加新解析记录」折叠表单
 *
 * 现代化流玻表单：圆润 rounded-xl 边框、精细间距、accent 图标与状态动效。
 */

import type { Dispatch, FormEvent, SetStateAction } from "react";
import { ChevronDown, ChevronRight, Plus, RefreshCw } from "lucide-react";
import { CustomSelect } from "../../../../components/form/CustomSelect";
import { DnsLineSelect } from "../../../../components/dns/DnsLineSelect";
import { DNS_TYPE_OPTIONS, needsDnsPriority } from "../../../../dnsrecords";
import type { Domain } from "../../../../types/domain";

export interface DnsheDnsCreateFormProps {
  currentDomain: Domain;
  actionLoading: string | null;
  domainSupportsLine: (dom: Domain | null | undefined) => boolean;

  dnsFormOpen: boolean;
  setDnsFormOpen: Dispatch<SetStateAction<boolean>>;

  newDnsType: string;
  setNewDnsType: (v: string) => void;
  newDnsName: string;
  setNewDnsName: (v: string) => void;
  newDnsContent: string;
  setNewDnsContent: (v: string) => void;
  newDnsTtl: number;
  setNewDnsTtl: (v: number) => void;
  newDnsPriority: number;
  setNewDnsPriority: (v: number) => void;
  newDnsLine: string;
  setNewDnsLine: (v: string) => void;

  onCreateDnsRecord: (e: FormEvent) => void;
}

export function DnsheDnsCreateForm({
  currentDomain,
  actionLoading,
  domainSupportsLine,
  dnsFormOpen,
  setDnsFormOpen,
  newDnsType,
  setNewDnsType,
  newDnsName,
  setNewDnsName,
  newDnsContent,
  setNewDnsContent,
  newDnsTtl,
  setNewDnsTtl,
  newDnsPriority,
  setNewDnsPriority,
  newDnsLine,
  setNewDnsLine,
  onCreateDnsRecord,
}: DnsheDnsCreateFormProps) {
  return (
    <div className="bg-elevated/60 backdrop-blur-sm border border-border-base rounded-2xl overflow-hidden [isolation:isolate] transition-all">
      <button
        onClick={() => setDnsFormOpen(!dnsFormOpen)}
        className="w-full px-4 py-3 hover:bg-hovered/50 flex justify-between items-center text-sm font-semibold text-content-secondary transition-colors"
      >
        <span className="flex items-center gap-2">
          <Plus className="w-4 h-4 text-accent" />
          <span>{dnsFormOpen ? "隐藏新建解析表单" : "添加新解析记录"}</span>
        </span>
        {dnsFormOpen ? (
          <ChevronDown className="w-4 h-4 text-accent transition-transform" />
        ) : (
          <ChevronRight className="w-4 h-4 text-accent transition-transform" />
        )}
      </button>

      {dnsFormOpen && (
        <form onSubmit={onCreateDnsRecord} className="p-4 sm:p-5 grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4 border-t border-border-base/60">
          <div>
            <span className="block text-xs font-semibold text-content-muted mb-1.5">记录类型</span>
            <CustomSelect
              ariaLabel="记录类型"
              value={newDnsType}
              onChange={setNewDnsType}
              options={DNS_TYPE_OPTIONS}
              className="w-full px-3.5 py-2 rounded-xl text-sm text-content-primary"
            />
          </div>

          <div>
            <label htmlFor="dnshednscreateform-fld1" className="block text-xs font-semibold text-content-muted mb-1.5">主机记录</label>
            <input
              id="dnshednscreateform-fld1"
              type="text"
              name="dns-new-name"
              autoComplete="off"
              placeholder="例如 @ 或 www"
              value={newDnsName}
              onChange={(e) => setNewDnsName(e.target.value)}
              className="w-full form-input px-3.5 py-2.5 rounded-xl text-sm text-content-primary"
            />
          </div>

          <div className="md:col-span-2 lg:col-span-1">
            <label htmlFor="dnshednscreateform-fld2" className="block text-xs font-semibold text-content-muted mb-1.5">记录值 (Content)</label>
            <input
              id="dnshednscreateform-fld2"
              type="text"
              name="dns-new-content"
              autoComplete="off"
              required
              placeholder="例如 192.0.2.1"
              value={newDnsContent}
              onChange={(e) => setNewDnsContent(e.target.value)}
              className="w-full form-input px-3.5 py-2.5 rounded-xl text-sm text-content-primary"
            />
          </div>

          <div>
            <label htmlFor="dnshednscreateform-fld3" className="block text-xs font-semibold text-content-muted mb-1.5">TTL (秒)</label>
            <input
              id="dnshednscreateform-fld3"
              type="number"
              name="dns-new-ttl"
              autoComplete="off"
              min={120}
              max={86400}
              value={newDnsTtl}
              onChange={(e) => setNewDnsTtl(parseInt(e.target.value, 10))}
              className="w-full form-input px-3.5 py-2.5 rounded-xl text-sm text-content-primary"
            />
          </div>

          {needsDnsPriority(newDnsType) && (
            <div>
              <label htmlFor="dnshednscreateform-fld4" className="block text-xs font-semibold text-content-muted mb-1.5">优先级</label>
              <input
                id="dnshednscreateform-fld4"
                type="number"
                name="dns-new-priority"
                autoComplete="off"
                min={0}
                max={65535}
                value={newDnsPriority}
                onChange={(e) => setNewDnsPriority(parseInt(e.target.value, 10))}
                className="w-full form-input px-3.5 py-2.5 rounded-xl text-sm text-content-primary"
              />
            </div>
          )}

          <div>
            <span className="block text-xs font-semibold text-content-muted mb-1.5">解析线路</span>
            <DnsLineSelect
              value={newDnsLine}
              onChange={setNewDnsLine}
              supported={domainSupportsLine(currentDomain)}
              className="w-full form-input px-3.5 py-2 rounded-xl text-sm text-content-primary"
            />
          </div>

          <div className="flex items-end md:col-span-3 lg:col-span-1">
            <button
              type="submit"
              disabled={actionLoading === "create-dns"}
              className="w-full btn-primary py-2.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-1.5 shadow-sm transition-all"
            >
              {actionLoading === "create-dns" ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              确认保存
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
