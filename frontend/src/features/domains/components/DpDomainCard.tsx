/**
 * DigitalPlat 域名卡片（Phase 4-F 从 App.tsx 抽出）
 *
 * 原实现为 App.tsx 内的 renderDpDomainCard(dom)，约 145 行。布局与 DNSHE 的
 * DomainCard 一致（域名 / 注册态徽章 / 注册与到期时间 / 当前 DNS 服务器 /
 * 底部交叉提示 + DNS 按钮 + 三点菜单），差异在：
 * - 状态徽章是「注册态」（dpStatusBadge：正常 / 待删除 / 未知）而非 DNSHE 三态；
 * - 三点菜单只有「修改 NS 记录」「删除域名」，没有续期（上游走不同流程）。
 *
 * 跨卡片共享状态由 props 注入（与 DomainCard 同一套约定）：
 * highlighted / menuOpen+onToggleMenu+onCloseMenu / cfManaged / 四个动作回调。
 *
 * NOTE: 不做「统一域名卡片」抽象 —— 与 MultiProvider 卡片的差异（无到期时间、
 * 无删除、无 NS）已被刻意保留成三份，合并会把差异塞进一堆 if。
 */

import type { Domain } from "../../../types/domain";
import { Badge } from "../../../components/Badge";
import { CloudflareIcon } from "../../../components/icons/CloudflareIcon";
import { displayDomainSmart, formatDate } from "../../../lib/display-domain";
import { checkHasDns, getDnsProviderLabel } from "../../../lib/dns-status";
import { useAppData } from "../../../state/AppDataContext";
import { dpStatusBadge } from "../dpStatusBadge";
import { MoreVertical, Server, Settings, Trash2 } from "lucide-react";

export interface DpDomainCardProps {
  dom: Domain;
  /** 是否为本卡高亮定位（父级 dpHighlightDomainId === dom.id） */
  highlighted: boolean;
  /** 是否显示「已绑定 Cloudflare，前往管理解析」交叉提示 */
  cfManaged: boolean;
  /** 三点操作菜单是否展开 */
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onGotoCf: () => void;
  /** 打开 DNS 解析记录弹窗（DigitalPlat） */
  onOpenDns: () => void;
  /** 打开 NS 修改弹窗（DigitalPlat） */
  onOpenNs: () => void;
  /** 打开删除域名确认弹窗 */
  onDelete: () => void;
}

// DigitalPlat 域名卡片 —— 布局与 renderDomainCard（域名列表页）一致：
// 域名 + 注册态徽章 / 注册与到期时间 / 当前 DNS 服务器 / 底部交叉提示 + DNS 按钮 + 三点菜单。
// 差异：状态徽章是注册态（ok/pendingdelete）而非 DNSHE 三态；三点菜单只有删除
//（修改 NS 与续期上游走不同流程，不在本面板提供）。
export function DpDomainCard({
  dom,
  highlighted,
  cfManaged,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onGotoCf,
  onOpenDns,
  onOpenNs,
  onDelete,
}: DpDomainCardProps) {
  const { showToast } = useAppData();
  const unicodeDomain = displayDomainSmart(dom.full_domain);
  const badge = dpStatusBadge(String(dom.status || ""));
  const hostedHere = checkHasDns(dom);

  const handleCopyDomain = () => {
    navigator.clipboard.writeText(dom.full_domain).then(() => {
      showToast("success", `已复制：${dom.full_domain}`);
    }).catch(() => {
      showToast("error", "复制失败，请手动选择");
    });
  };

  return (
    <div
      id={`dp-domain-card-${dom.id}`}
      className={`bg-surface border rounded-2xl p-5 flex flex-col justify-between transition-all duration-300 shadow-xl ${
        highlighted
          ? "card-highlighted border-emerald-400 ring-2 ring-emerald-400/50"
          : "border-border-base hover:border-border-base"
      }`}
    >
      {/* 顶部：域名名称与注册态 */}
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={handleCopyDomain}
          className="font-mono text-sm sm:text-base font-bold text-content-primary tracking-wide truncate min-w-0 hover:text-accent transition-colors cursor-pointer text-left"
          title={`点击复制：${dom.full_domain}`}
        >
          {unicodeDomain}
        </button>
        <Badge tone={badge.tone} className="flex-shrink-0">
          {badge.text}
        </Badge>
      </div>

      {/* 中间：注册时间与到期时间 */}
      <div className="mt-4 space-y-2 text-xs">
        <div className="flex justify-between items-center">
          <span className="text-content-muted font-medium">注册时间</span>
          <span className="font-mono text-content-secondary">{formatDate(dom.created_at, false)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-content-muted font-medium">到期时间</span>
          <span className="font-mono text-content-secondary" title="DigitalPlat 注册商侧到期时间">
            {formatDate(dom.expires_at, true)}
          </span>
        </div>
      </div>

      {/* 分隔线 */}
      <div className="border-t border-border-base my-3.5" />

      {/* 当前 DNS 服务器 */}
      <div className="flex justify-between items-center text-xs">
        <span className="text-content-muted font-medium">当前 DNS 服务器</span>
        {hostedHere ? (
          <span className="bg-elevated text-content-secondary border border-border-base text-xs font-medium px-2.5 py-0.5 rounded-md">
            DigitalPlat 托管
          </span>
        ) : (
          <span className="bg-sky-50 text-sky-700 border border-sky-200 dark:bg-sky-950/80 dark:text-sky-300 dark:border-sky-800/60 text-xs font-medium px-2.5 py-0.5 rounded-md">
            {getDnsProviderLabel(dom)}
          </span>
        )}
      </div>

      {/* 分隔线 */}
      <div className="border-t border-border-base my-3.5" />

      {/* 底部：交叉提示（外部 NS 且同名 zone 已在绑定的 CF 账号中）+ DNS 按钮与三点菜单 */}
      <div className="flex items-center gap-3 relative">
        {cfManaged && (
          <button
            onClick={onGotoCf}
            className="min-w-0 text-xs font-medium text-sky-600 dark:text-sky-400 hover:text-sky-500 dark:hover:text-sky-300 flex items-center gap-1.5 transition-colors text-left"
            title="已绑定 Cloudflare 账号，点击前往 Cloudflare 标签页并定位到该域名"
          >
            <CloudflareIcon className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="truncate">前往 Cloudflare 管理解析</span>
          </button>
        )}

        <div className="flex items-center gap-3 ml-auto flex-shrink-0">
          <button
            onClick={onOpenDns}
            disabled={!hostedHere}
            title={hostedHere ? undefined : "该域名 NS 未指向 DigitalPlat，解析记录请在对应服务商管理"}
            className={`text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 transition-all shadow-inner ${
              hostedHere
                ? "bg-elevated hover:bg-hovered text-content-secondary cursor-pointer"
                : "bg-elevated text-content-muted opacity-50 cursor-not-allowed"
            }`}
          >
            <Settings className="w-3.5 h-3.5 text-content-muted" /> DNS
          </button>

          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleMenu();
              }}
              className="p-2 hover:bg-hovered text-content-muted hover:text-content-primary rounded-lg transition-colors"
            >
              <MoreVertical className="w-4 h-4" />
            </button>

            {menuOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute right-0 bottom-10 z-30 w-40 bg-elevated border border-border-base rounded-xl shadow-2xl overflow-hidden text-xs py-1 animate-in fade-in zoom-in-95"
              >
                <button
                  onClick={() => {
                    onCloseMenu();
                    onOpenNs();
                  }}
                  disabled={String(dom.status || "").toLowerCase().includes("pendingdelete")}
                  className={`w-full text-left px-3.5 py-2.5 hover:bg-hovered text-content-secondary hover:text-content-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed`}
                  title={String(dom.status || "").toLowerCase().includes("pendingdelete") ? "该域名处于待删除状态，无法修改 NS" : "整组替换该域名的 NS 服务器（DNS 委派立即切换）"}
                >
                  <Server className="w-3.5 h-3.5 text-content-muted" /> 修改 NS 记录
                </button>
                <button
                  onClick={() => {
                    onCloseMenu();
                    onDelete();
                  }}
                  className="w-full text-left px-3.5 py-2.5 hover:bg-rose-50 text-rose-600 hover:text-rose-700 dark:hover:bg-rose-950/40 dark:text-rose-400 dark:hover:text-rose-300 flex items-center gap-2 border-t border-border-base"
                >
                  <Trash2 className="w-3.5 h-3.5" /> 删除域名
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
