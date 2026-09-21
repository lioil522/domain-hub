import type { Domain, CfExpiryEntry } from "../../../types/domain";
import { displayDomainSmart } from "../../../lib/display-domain";
import { useAppData } from "../../../state/AppDataContext";
import { ExternalLink, Globe, Pencil, Settings } from "lucide-react";

/** `cfZoneDateInfo` 的返回形状（由 useCfExpiry 提供） */
export interface CfZoneDateInfo {
  isDnsheRegistered: boolean;
  isDpRegistered: boolean;
  dnsheMatch?: Domain;
  dpMatch?: Domain;
  entry?: CfExpiryEntry;
  manualEntry?: CfExpiryEntry;
  registeredText: string;
  expiryText: string;
}

export interface CfZoneCardProps {
  zone: Domain;
  /** 是否为本卡高亮定位（父级 cfHighlightZoneId === zone.id） */
  highlighted: boolean;
  /** 注册/到期信息的统一推导（与编辑弹窗共用，来自 useCfExpiry） */
  cfZoneDateInfo: (zone: Domain) => CfZoneDateInfo;
  /** 打开注册信息手动编辑弹窗 */
  onOpenEdit: () => void;
  /** 打开 DNS 解析记录面板 */
  onOpenDns: () => void;
  /** 跳转到 DNSHE 标签页并定位同名域名 */
  onGotoDnshe: () => void;
  /** 跳转到 DigitalPlat 标签页并定位同名域名 */
  onGotoDp: () => void;
}

/**
 * Cloudflare zone 卡片（Phase 5-4b 从 App.tsx 的 `renderCfZoneCard` 抽出）
 *
 * **纯搬运**：JSX 与样式逐字保留，仅做必要的「App 闭包 → props」改写：
 *   - `zone.id === cfHighlightZoneId` → `highlighted`
 *   - `openCfEditZone(zone)` → `onOpenEdit()`
 *   - `gotoDnsheDomain(zone.full_domain)` → `onGotoDnshe()`
 *   - `gotoDpDomain(zone.full_domain)` → `onGotoDp()`
 *   - `handleCfOpenDnsModal(zone)` → `onOpenDns()`
 *   - 去掉 `key={zone.id}`（由调用方在 map 中提供）
 *
 * `cfZoneDateInfo` 由父级从 `useCfExpiry` 注入（该 hook 需 activeTab/cfZones/domains/
 * dpDomains/两个集合，无法在卡片内自取）。
 */
export function CfZoneCard({
  zone,
  highlighted,
  cfZoneDateInfo,
  onOpenEdit,
  onOpenDns,
  onGotoDnshe,
  onGotoDp,
}: CfZoneCardProps) {
  const { showToast } = useAppData();


    const unicodeDomain = displayDomainSmart(zone.full_domain);
    const isActive = String(zone.status || "").toLowerCase() === "active";
    // 注册/到期时间与来源的完整推导（与编辑弹窗共用：手动覆盖 > 上游缓存 > RDAP，查不到显示 —）
    const {
      isDnsheRegistered,
      isDpRegistered,
      dnsheMatch,
      dpMatch,
      entry,
      manualEntry,
      registeredText,
      expiryText,
    } = cfZoneDateInfo(zone);

    const handleCopyZone = () => {
      navigator.clipboard.writeText(zone.full_domain).then(() => {
        showToast("success", `已复制：${zone.full_domain}`);
      }).catch(() => {
        showToast("error", "复制失败，请手动选择");
      });
    };

    return (
      <div
        id={`cf-zone-card-${zone.id}`}
        className={`bg-surface border rounded-2xl p-5 flex flex-col justify-between transition-all duration-300 shadow-xl ${
          highlighted
            ? "card-highlighted border-sky-400 ring-2 ring-sky-400/50"
            : "border-border-base"
        }`}
      >
        {/* 顶部：域名名称与状态 */}
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={handleCopyZone}
            className="font-mono text-sm sm:text-base font-bold text-content-primary tracking-wide truncate min-w-0 hover:text-accent transition-colors cursor-pointer text-left"
            title={`点击复制：${zone.full_domain}`}
          >
            {unicodeDomain}
          </button>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ${isActive ? "bg-emerald-500" : "bg-amber-500"}`}
              title={isActive ? "已激活" : "待激活"}
            />
            <button
              onClick={() => onOpenEdit()}
              className="p-1.5 -mr-0.5 text-content-muted hover:text-accent hover:bg-hovered rounded-lg transition-colors cursor-pointer"
              title="手动编辑注册/到期时间与注册来源（RDAP 查不到的域名可自行录入）"
              aria-label="编辑注册信息"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* 中间：元信息（注册/到期时间 = 手动覆盖优先，其次 DNSHE/DigitalPlat 上游缓存，
            最后 RDAP 查询的注册商侧数据；右上角编辑图标可手动录入） */}
        <div className="mt-4 space-y-2 text-xs">
          <div className="flex justify-between items-center">
            <span className="text-content-muted font-medium">注册时间</span>
            <span
              className="font-mono text-content-secondary"
              title={
                manualEntry?.registered_at
                  ? "手动录入的注册时间（优先于自动查询）"
                  : dnsheMatch?.created_at
                    ? "DNSHE 上游缓存日期"
                    : dpMatch?.created_at
                      ? "DigitalPlat 上游缓存日期"
                      : "注册商侧注册时间（RDAP 查询，7 天缓存）"
              }
            >
              {registeredText}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-content-muted font-medium">到期时间</span>
            <span
              className="font-mono text-content-secondary"
              title={
                manualEntry?.expires_at
                  ? "手动录入的到期时间（优先于自动查询）"
                  : dnsheMatch?.expires_at
                    ? "DNSHE 上游缓存日期"
                    : dpMatch?.expires_at
                      ? "DigitalPlat 上游缓存日期"
                      : "注册商侧到期时间（RDAP 查询，7 天缓存）"
              }
            >
              {expiryText}
            </span>
          </div>
          {isDnsheRegistered && (
            <div className="flex justify-between items-center">
              <span className="text-content-muted font-medium">注册来源</span>
              <button
                onClick={() => onGotoDnshe()}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-source-dnshe-fg bg-source-dnshe-bg border border-source-dnshe-border px-2.5 py-0.5 rounded-md transition-colors cursor-pointer"
                title="点击前往 DNSHE 标签页管理该域名"
              >
                <Globe className="w-3 h-3" /> DNSHE
              </button>
            </div>
          )}
          {isDpRegistered && (
            <div className="flex justify-between items-center gap-2">
              <span className="text-content-muted font-medium">注册来源</span>
              <button
                onClick={() => onGotoDp()}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:text-emerald-500 dark:hover:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-900/60 px-2.5 py-0.5 rounded-md transition-colors cursor-pointer"
                title="点击前往 DigitalPlat 标签页管理该域名"
              >
                <Globe className="w-3 h-3" /> DigitalPlat
              </button>
            </div>
          )}
          {/* 手动录入来源：仅在非 DNSHE/DigitalPlat 注册的 zone 上展示（避免与上方徽章重复） */}
          {manualEntry && !isDnsheRegistered && !isDpRegistered && (
            <div className="flex justify-between items-center gap-2 min-w-0">
              <span className="text-content-muted font-medium flex-shrink-0">注册来源</span>
              <span
                className="text-xs font-medium px-2.5 py-0.5 rounded-md bg-elevated text-content-secondary border border-border-base truncate max-w-[65%]"
                title="手动录入，优先于自动查询（右上角编辑图标可修改）"
              >
                {manualEntry.source || "手动录入"}
              </span>
            </div>
          )}
          {/* RDAP 自动查询的注册商作为最低优先级“注册来源”：仅当无 DNSHE/DP/手动 时展示 */}
          {!isDnsheRegistered && !isDpRegistered && !manualEntry && entry?.registrar && (
            <div className="flex justify-between items-center gap-2 min-w-0">
              <span className="text-content-muted font-medium flex-shrink-0">注册来源</span>
              <span
                className="text-xs font-medium px-2.5 py-0.5 rounded-md bg-elevated text-content-secondary border border-border-base truncate max-w-[65%]"
                title="注册来源（RDAP 自动查询，7 天缓存）"
              >
                {entry.registrar}
              </span>
            </div>
          )}
        </div>

        <div className="border-t border-border-base my-3.5" />

        {/* 底部：DNS 管理按钮与 Cloudflare 控制台外链 */}
        <div className="flex items-center justify-end gap-2">
          <a
            href={zone.provider_account_id
              ? `https://dash.cloudflare.com/${zone.provider_account_id}/${zone.full_domain}/dns/records`
              : "https://dash.cloudflare.com/"}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-semibold px-3 py-2 rounded-lg flex items-center gap-1.5 bg-elevated hover:bg-hovered text-content-secondary transition-all"
            title={zone.provider_account_id
              ? "在 Cloudflare 控制台打开该 zone 的 DNS 记录页"
              : "点击「同步 zones」后可直达该 zone 的 DNS 记录页（当前缺账号信息，先打开控制台首页）"}
          >
            控制台 <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <button
            onClick={() => onOpenDns()}
            className="text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 bg-elevated hover:bg-hovered text-content-secondary cursor-pointer transition-all shadow-inner"
          >
            <Settings className="w-3.5 h-3.5 text-content-muted" /> DNS
          </button>
        </div>
      </div>
    );
}
