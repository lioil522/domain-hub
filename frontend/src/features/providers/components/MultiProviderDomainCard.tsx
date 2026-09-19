/**
 * 四个新托管商（DNSPod / 阿里云 / 华为云 / Vercel）共用的域名卡片
 * （Phase 4-G 从 App.tsx 抽出）
 *
 * WHY 共用一份而不是复制四份：卡片信息结构完全相同（域名 / 状态徽章 / 同步时间 /
 * NS 归属 / DNS 按钮），差异只有托管商名与配色。传 providerKey 进来后用
 * MULTI_PROVIDER_META 取文案，避免四份代码各自演化。
 *
 * 与 DNSHE DomainCard / DigitalPlat DpDomainCard 刻意保留的三个差异（不合并）：
 * 1. 四家都是纯解析服务商，没有注册有效期 —— 不渲染「到期时间」，只显示同步时间；
 * 2. 不提供「删除域名」—— 四家的 API 只能删解析记录，不能删域名本身；
 * 3. 不提供「修改 NS 记录」—— 四家都不开放 NS 改写接口（NS 由注册商侧决定）。
 */

import type { Domain } from "../../../types/domain";
import type { MultiProviderKey } from "../../../types/provider";
import { Badge } from "../../../components/Badge";
import { displayDomainSmart, formatDate } from "../../../lib/display-domain";
import { checkHasDns, getDnsProviderLabel } from "../../../lib/dns-status";
import { useAppData } from "../../../state/AppDataContext";
import { MULTI_PROVIDER_META } from "../providerMeta";
import { Settings } from "lucide-react";

export interface MultiProviderDomainCardProps {
  /** 托管商短键（dnspod / alidns / huaweicloud / vercel） */
  providerKey: MultiProviderKey;
  dom: Domain;
  /** 打开该域名的解析记录弹窗 */
  onOpenDns: () => void;
}

/**
 * 四个新托管商共用的域名卡片渲染。
 *
 * WHY 共用一份而不是复制四份：卡片的信息结构完全相同（域名 / 状态 / 注册时间 /
 * NS 归属 / DNS 按钮 / 操作菜单），差异只有托管商名与配色。传 key 进来后用
 * MULTI_PROVIDER_META 取文案，避免四份代码各自演化。
 *
 * NOTE: 与 DP 卡片的三个差异：
 * 1. 四家都是**纯解析服务商**，没有域名注册有效期，所以「到期时间」直接不渲染，
 *    而不是显示一个 0000 占位（后端 expires_at 就是 0000）。
 * 2. 「删除域名」不提供 —— 四家的 API 只能删解析记录，不能删域名本身。
 *    提供这个按钮会让用户误以为点了会释放域名，实际只会报错。删除操作
 *    引导用户去各自控制台。
 * 3. 「修改 NS 记录」也不提供 —— 四家都不开放 NS 改写接口（NS 由注册商侧
 *    决定），要改 NS 得去域名注册商后台。
 */
export function MultiProviderDomainCard({
  providerKey,
  dom,
  onOpenDns,
}: MultiProviderDomainCardProps) {
  const { showToast } = useAppData();
  const meta = MULTI_PROVIDER_META[providerKey];
  const unicodeDomain = displayDomainSmart(dom.full_domain);
  const hostedHere = checkHasDns(dom);

  const handleCopyDomain = () => {
    navigator.clipboard
      .writeText(dom.full_domain)
      .then(() => showToast("success", `已复制：${dom.full_domain}`))
      .catch(() => showToast("error", "复制失败，请手动选择"));
  };

  return (
    <div
      id={`${providerKey}-domain-card-${dom.id}`}
      className="bg-surface border border-border-base hover:border-border-base rounded-2xl p-5 flex flex-col justify-between transition-all duration-300 shadow-xl"
    >
      {/* 顶部：域名名称与状态 */}
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={handleCopyDomain}
          className="font-mono text-sm sm:text-base font-bold text-content-primary tracking-wide truncate min-w-0 hover:text-accent transition-colors cursor-pointer text-left"
          title={`点击复制：${dom.full_domain}`}
        >
          {unicodeDomain}
        </button>
        <Badge tone="idle" className="flex-shrink-0">
          {String(dom.status || "正常")}
        </Badge>
      </div>

      {/* 中间：注册时间（四家均为纯解析服务商，无到期时间） */}
      <div className="mt-4 space-y-2 text-xs">
        <div className="flex justify-between items-center">
          <span className="text-content-muted font-medium">同步时间</span>
          <span className="font-mono text-content-secondary">{formatDate(dom.created_at, false)}</span>
        </div>
      </div>

      <div className="border-t border-border-base my-3.5" />

      {/* 当前 DNS 服务器归属 */}
      <div className="flex justify-between items-center text-xs">
        <span className="text-content-muted font-medium">当前 DNS 服务器</span>
        {hostedHere ? (
          <span className="bg-elevated text-content-secondary border border-border-base text-xs font-medium px-2.5 py-0.5 rounded-md">
            {meta.label} 托管
          </span>
        ) : (
          <span className="bg-sky-50 text-sky-700 border border-sky-200 dark:bg-sky-950/80 dark:text-sky-300 dark:border-sky-800/60 text-xs font-medium px-2.5 py-0.5 rounded-md">
            {getDnsProviderLabel(dom)}
          </span>
        )}
      </div>

      <div className="border-t border-border-base my-3.5" />

      {/* 底部：解析按钮。四家都能直接管解析记录（只要 NS 指向该托管商） */}
      <div className="flex items-center gap-3 relative">
        <button
          onClick={onOpenDns}
          disabled={!hostedHere}
          title={hostedHere ? undefined : `该域名 NS 未指向 ${meta.label}，解析记录请在对应服务商管理`}
          className={`text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 transition-all shadow-inner ml-auto ${
            hostedHere
              ? "bg-elevated hover:bg-hovered text-content-secondary cursor-pointer"
              : "bg-elevated text-content-muted opacity-50 cursor-not-allowed"
          }`}
        >
          <Settings className="w-3.5 h-3.5 text-content-muted" /> DNS
        </button>
      </div>
    </div>
  );
};
