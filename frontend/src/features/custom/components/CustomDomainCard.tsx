import { Pencil, Trash2 } from "lucide-react";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { CloudflareIcon } from "../../../components/icons/CloudflareIcon";
import { domainKeyCandidates } from "../../../lib/domain-keys";
import type { DomainWithDays } from "../hooks/useCustomProviders";

/**
 * 自定义服务商的手动域名单卡
 *
 * 从 `App.tsx` 抽出（Phase 8）。**纯搬运**：DOM 结构与全部 className / aria-label /
 * title 逐字保留（含一条关于「触屏无 hover、部分 AT 不朗读 title」的可访问性注释）。
 *
 * 差异只有由 props 注入的可变项：
 *   - `expiryBadge` 的产物（tone/text/permanent）由 App 侧算好后传入
 *   - `cfManaged`（是否已在 Cloudflare 托管）由 App 侧用 cfZoneFullDomainSet 判定
 */
export interface CustomDomainCardProps {
  dom: DomainWithDays;
  /** 到期徽章语义与文案（App 侧 expiryBadge 产出） */
  badge: { tone: "ok" | "warn" | "danger" | "info" | "idle"; text: string; permanent: boolean };
  /** 该域名是否已在 Cloudflare 托管（是则显示跳转入口） */
  cfManaged: boolean;
  onGotoCf: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function CustomDomainCard({
  dom,
  badge,
  cfManaged,
  onGotoCf,
  onEdit,
  onDelete,
}: CustomDomainCardProps) {
  const { tone: badgeTone, text: daysText, permanent } = badge;
  return (
    <div className="bg-hovered border border-border-base rounded-lg p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-content-primary truncate" title={dom.full_domain}>
            {dom.full_domain}
          </div>
          <div className="text-[11px] text-content-muted mt-0.5 font-mono">
            注册: {dom.registered_at ? dom.registered_at.slice(0, 10) : "—"}
          </div>
          <div className="text-[11px] text-content-muted font-mono">
            到期: {permanent ? "永久" : dom.expires_at.slice(0, 10)}
          </div>
        </div>
        <Badge tone={badgeTone} size="sm" className="flex-shrink-0">{daysText}</Badge>
      </div>
      {dom.remark && (
        <div className="text-[11px] text-content-secondary bg-surface border border-border-soft rounded-md px-2.5 py-1.5">
          {dom.remark}
        </div>
      )}
      <div className="flex items-center gap-2 mt-auto pt-0.5">
        {cfManaged && (
          <button
            onClick={onGotoCf}
            className="min-w-0 text-[11px] font-medium text-sky-600 dark:text-sky-400 hover:text-sky-500 dark:hover:text-sky-300 flex items-center gap-1 transition-colors text-left"
            title="该域名已在 Cloudflare 托管，点击前往管理解析"
          >
            <CloudflareIcon className="w-3 h-3 flex-shrink-0" />
            <span className="truncate">Cloudflare</span>
          </button>
        )}
        <div className="flex items-center gap-0.5 ml-auto flex-shrink-0">
          {/* NOTE: 原先只有 title，没有 aria-label。title 在部分读屏/触屏场景下不可靠
              （触屏无 hover、部分 AT 不朗读 title），这里补上权威的可访问名称。 */}
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            icon={<Pencil className="w-3.5 h-3.5" aria-hidden="true" />}
            aria-label={`编辑域名 ${dom.full_domain}`}
            title="编辑域名"
            onClick={onEdit}
          />
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            icon={<Trash2 className="w-3.5 h-3.5" aria-hidden="true" />}
            aria-label={`删除域名 ${dom.full_domain}`}
            title="删除域名"
            className="hover:text-state-danger-fg hover:bg-state-danger-bg"
            onClick={onDelete}
          />
        </div>
      </div>
    </div>
  );
}

/** 判断域名是否已在 Cloudflare 托管（App 侧用它算 cfManaged） */
export function isCfManaged(fullDomain: string, cfZoneFullDomainSet: Set<string>): boolean {
  return domainKeyCandidates(fullDomain).some((k) => cfZoneFullDomainSet.has(k));
}
