/**
 * DNS 解析记录面板 —— 头部（域名、副标题、刷新、关闭）
 *
 * 从原单文件 `DnsRecordPanel.tsx` 拆出（UI 优化方案 P1）。DOM / className / 文案逐字保留。
 */

import { Globe, RefreshCw, X } from "lucide-react";
import type { Domain } from "../types";
import type { DnsPanelMeta } from "./types";
import { displayDomainSmart } from "../../lib/display-domain";

export interface DnsRecordPanelHeaderProps {
  zone: Domain;
  meta: DnsPanelMeta;
  loadingRecords: boolean;
  onReload: (force?: boolean) => void;
  onClose: () => void;
}

export function DnsRecordPanelHeader({
  zone,
  meta,
  loadingRecords,
  onReload,
  onClose,
}: DnsRecordPanelHeaderProps) {
  return (
    <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between border-b border-border-base flex-shrink-0 gap-2">
      <div className="min-w-0">
        <h3 id="dns-record-panel-title" className="text-base sm:text-lg font-bold text-content-primary font-mono truncate flex items-center gap-2">
          <Globe className="w-4 h-4 text-sky-400 flex-shrink-0" />
          {displayDomainSmart(zone.full_domain)}
        </h3>
        <p className="text-xs text-content-muted mt-0.5">{meta.subtitle}</p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={() => onReload(true)}
          disabled={loadingRecords}
          title={meta.refreshTitle}
          className="p-2 text-content-muted hover:text-content-primary hover:bg-hovered rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loadingRecords ? "animate-spin" : ""}`} />
        </button>
        <button
          onClick={onClose}
          className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded"
          aria-label="关闭解析面板"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
