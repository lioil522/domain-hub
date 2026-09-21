/**
 * DNSHE 域名卡片（Phase 4-E 从 App.tsx 抽出）
 *
 * 原实现为 App.tsx 内的 renderDomainCard(dom) + renderStatusBadge(dom)，约 180 行。
 * 卡片本体只依赖 props 与三个共享纯函数（checkHasDns / getDnsProviderLabel /
 * displayDomainSmart），原先散落在 App 闭包里的「跨卡片共享状态」改由 props 注入：
 *
 * - highlighted：是否为本卡高亮定位（原 dnsheHighlightDomainId === dom.id）
 * - menuOpen / onToggleMenu / onCloseMenu：三点菜单的开关（原 openActionMenuId）
 * - cfManaged：是否显示「前往 Cloudflare 管理解析」交叉提示。原判据
 *   `!checkHasDns(dom) && domainKeyCandidates(dom.full_domain).some(k => cfZoneFullDomainSet.has(k))`
 *   依赖 cfZones 与两个 App 级纯函数，故在父级算好传入（其它卡片也在用同一判据）。
 * - onGotoCf / onOpenDns / onOpenNs / onRenew / onDelete：五个动作回调
 *
 * NOTE: 不做「统一域名卡片」的抽象 —— DigitalPlat / MultiProvider 的卡片布局相近
 * 但字段与动作不同（见 renderDpDomainCard / renderMultiProviderDomainCard），
 * 强行合并会把差异塞进一堆 if。本 Phase 只做搬运。
 */

import type { Domain } from "../../../types/domain";
import { Badge, type BadgeTone } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { CloudflareIcon } from "../../../components/icons/CloudflareIcon";
import { displayDomainSmart, formatDate } from "../../../lib/display-domain";
import { checkHasDns, getDnsProviderLabel } from "../../../lib/dns-status";
import { useAppData } from "../../../state/AppDataContext";
import { MoreVertical, RefreshCw, Server, Settings, Trash2 } from "lucide-react";

export interface DomainCardProps {
  dom: Domain;
  /** 是否为本卡高亮定位（父级 dnsheHighlightDomainId === dom.id） */
  highlighted: boolean;
  /** 是否显示「已绑定 Cloudflare，前往管理解析」交叉提示 */
  cfManaged: boolean;
  /** 三点操作菜单是否展开 */
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  /** 跳转到 Cloudflare 标签页并定位同名 zone */
  onGotoCf: () => void;
  /** 打开 DNS 解析记录弹窗 */
  onOpenDns: () => void;
  /** 打开 NS 修改弹窗 */
  onOpenNs: () => void;
  /** 续期域名 */
  onRenew: () => void;
  /** 打开删除域名确认弹窗 */
  onDelete: () => void;
  /** 父级操作忙碌键（renew-<id> / delete-<id> ...） */
  actionLoading: string | null;
}

// 渲染域名三态徽章：未解析 / 已解析 / 已委派
// 三态语义 → Badge tone 映射：委派=info / 已解析=ok / 未解析=idle
function StatusBadge({ dom }: { dom: Domain }) {
  let statusText = dom.status;
  const isDelegated = Number(dom.has_dns) === 0 || dom.status === "已委派";
  
  if (isDelegated) {
    statusText = "已委派";
  } else if (dom.status === "Registered" || dom.status === "active" || dom.status === "已解析") {
    statusText = "已解析";
  } else if (dom.status === "未解析") {
    statusText = "未解析";
  }

  const tone: BadgeTone =
    statusText === "已委派" ? "info" : statusText === "已解析" ? "ok" : "idle";

  return <Badge tone={tone}>{statusText}</Badge>;
};

// 渲染单个域名卡片
export function DomainCard({
  dom,
  highlighted,
  cfManaged,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onGotoCf,
  onOpenDns,
  onOpenNs,
  onRenew,
  onDelete,
  actionLoading,
}: DomainCardProps) {
  const { showToast } = useAppData();
  const unicodeDomain = displayDomainSmart(dom.full_domain);

  const handleCopyDomain = () => {
    navigator.clipboard.writeText(dom.full_domain).then(() => {
      showToast("success", `已复制：${dom.full_domain}`);
    }).catch(() => {
      showToast("error", "复制失败，请手动选择");
    });
  };

  return (
    <div
      id={`dnshe-domain-card-${dom.id}`}
      className={`bg-surface border rounded-2xl p-5 flex flex-col justify-between transition-all duration-200 shadow-xl ${
        highlighted
          ? "card-highlighted"
          : "border-border-base hover:border-border-base"
      }`}
    >
      {/* 顶部：域名名称与状态 */}
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={handleCopyDomain}
          /* 手机上小一号字号，让常见长度的域名不必省略；超长域名仍截断，
             但 title 与「点击复制」拿到的都是完整域名 */
          className="font-mono text-sm sm:text-base font-bold text-content-primary tracking-wide truncate min-w-0 hover:text-accent transition-colors cursor-pointer text-left"
          title={`点击复制：${dom.full_domain}`}
        >
          {unicodeDomain}
        </button>
        <StatusBadge dom={dom} />
      </div>

    {/* 中间：注册时间与到期时间 */}
    <div className="mt-4 space-y-2 text-xs">
      <div className="flex justify-between items-center">
        <span className="text-content-muted font-medium">注册时间</span>
        <span className="font-mono text-content-secondary">{formatDate(dom.created_at, false)}</span>
      </div>
      <div className="flex justify-between items-center">
        <span className="text-content-muted font-medium">到期时间</span>
        <span className="font-mono text-content-secondary">{formatDate(dom.expires_at, true)}</span>
      </div>
    </div>

    {/* 分隔线 */}
    <div className="border-t border-border-base my-3.5" />

    {/* 当前 DNS 服务器 */}
    <div className="flex justify-between items-center text-xs">
      <span className="text-content-muted font-medium">当前 DNS 服务器</span>
      {checkHasDns(dom) ? (
        <span className="bg-elevated text-content-secondary border border-border-base text-xs font-medium px-2.5 py-0.5 rounded-md">
          系统默认
        </span>
      ) : (
        <span className="bg-sky-50 text-sky-700 border border-sky-200 dark:bg-sky-950/80 dark:text-sky-300 dark:border-sky-800/60 text-xs font-medium px-2.5 py-0.5 rounded-md">
          {getDnsProviderLabel(dom)}
        </span>
      )}
    </div>

    {/* 分隔线 */}
    <div className="border-t border-border-base my-3.5" />

    {/* 底部：交叉提示（已绑定 CF 账号的委派域名）+ DNS 按钮与更多三点下拉菜单 */}
    <div className="flex items-center gap-3 relative">
      {/* 交叉提示：委派到 Cloudflare 且同名 zone 已在绑定的 CF 账号中同步过，
          引导用户去 Cloudflare 标签页管理解析记录（纯展示层匹配，不改数据） */}
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
        {/* NOTE: 禁用理由必须让读屏用户也能拿到 —— 默认系统会为 disabled 按钮
            跳过 aria-label，所以把解释放在 title 上，同时给出可访问名称。 */}
        <Button
          variant="secondary"
          size="xs"
          icon={<Settings className="w-3.5 h-3.5" aria-hidden="true" />}
          onClick={onOpenDns}
          disabled={!checkHasDns(dom)}
          title={checkHasDns(dom) ? `管理 ${dom.full_domain} 的 DNS 解析` : "该域名未托管在当前系统，无 DNS 记录可管理"}
          aria-label={checkHasDns(dom) ? `管理 ${dom.full_domain} 的 DNS 解析` : "该域名未托管在当前系统，无 DNS 记录可管理"}
        >
          DNS
        </Button>

      <div className="relative">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={<MoreVertical className="w-4 h-4" aria-hidden="true" />}
          aria-label={`${dom.full_domain} 的更多操作`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="更多操作"
          onClick={(e) => {
            e.stopPropagation();
            onToggleMenu();
          }}
        />

        {/* 三点下拉操作菜单 */}
        {menuOpen && (
          <div 
            onClick={(e) => e.stopPropagation()}
            role="menu"
            className="absolute right-0 bottom-10 z-30 w-40 bg-elevated border border-border-base rounded-xl shadow-2xl overflow-hidden text-xs py-1 animate-in fade-in zoom-in-95"
          >
            <button
              role="menuitem"
              onClick={() => {
                onCloseMenu();
                onOpenNs();
              }}
              className="w-full text-left px-3.5 py-2.5 hover:bg-hovered text-content-secondary hover:text-content-primary flex items-center gap-2"
            >
              <Server className="w-3.5 h-3.5 text-content-muted" aria-hidden="true" /> 修改 NS 记录
            </button>
            
            <button
              role="menuitem"
              onClick={() => {
                onCloseMenu();
                onRenew();
              }}
              disabled={actionLoading === `renew-${dom.id}`}
              className="w-full text-left px-3.5 py-2.5 hover:bg-hovered text-content-secondary hover:text-content-primary flex items-center gap-2 border-t border-border-base"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-content-muted ${actionLoading === `renew-${dom.id}` ? "animate-spin" : ""}`} aria-hidden="true" />
              续期域名
            </button>

            <button
              role="menuitem"
              onClick={() => {
                onCloseMenu();
                onDelete();
              }}
              className="w-full text-left px-3.5 py-2.5 hover:bg-rose-50 text-rose-600 hover:text-rose-700 dark:hover:bg-rose-950/40 dark:text-rose-400 dark:hover:text-rose-300 flex items-center gap-2 border-t border-border-base"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> 删除域名
            </button>
          </div>
        )}
      </div>
      </div>
    </div>
  </div>
);
};
