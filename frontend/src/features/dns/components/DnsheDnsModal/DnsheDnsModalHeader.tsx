/**
 * DNSHE 解析记录弹窗 —— 模态框头部
 *
 * 从原单文件 `DnsheDnsModal.tsx` 拆出（UI 优化方案 P1）。DOM / className / 文案逐字保留。
 */

import { RefreshCw, ShieldCheck, X } from "lucide-react";
import type { Domain } from "../../../../types/domain";

export interface DnsheDnsModalHeaderProps {
  domain: Domain;
  loadingDns: boolean;
  onReload: (force?: boolean) => void;
  onClose: () => void;
}

export function DnsheDnsModalHeader({ domain, loadingDns, onReload, onClose }: DnsheDnsModalHeaderProps) {
  return (
    <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between gap-2 border-b border-border-base flex-shrink-0">
      {/* NOTE: min-w-0 + truncate —— 长 IDN 域名（xn-- 形式很长）会把右侧按钮挤出屏幕 */}
      <div className="min-w-0">
        <h3 id="dnshe-dns-modal-title" className="text-base sm:text-lg font-bold text-content-primary flex items-center gap-1.5">
          <ShieldCheck className="text-accent w-5 h-5 flex-shrink-0" />
          <span className="truncate">DNS 解析记录管理</span>
        </h3>
        <p className="text-xs text-content-muted mt-0.5 font-mono truncate">
          域名: {domain.full_domain}
        </p>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onClick={() => onReload(true)}
          disabled={loadingDns}
          className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded disabled:opacity-50"
          title="强制刷新（重新从 DNSHE 拉取）"
        >
          <RefreshCw className={`w-4 h-4 ${loadingDns ? "animate-spin" : ""}`} />
        </button>
        <button
          onClick={() => onClose()}
          className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
