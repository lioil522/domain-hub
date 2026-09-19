/**
 * DashboardPage —— 「概览」标签页（activeTab === "dashboard"）。
 *
 * 由 App.tsx 纯搬运抽出（Phase 10）。DOM / className / 文案逐字未改，行为保持一致。
 * 统计数据来自 useDashboardStats；本组件只负责渲染。
 *
 * 原 App 内的 DomainSourceBadge 局部组件一并迁入（仅概览页使用）。
 */
import {
  LayoutDashboard,
  RefreshCw,
  Globe,
  CheckCircle2,
  AlertTriangle,
  Key,
  Activity,
} from "lucide-react";
import { DomainTimeline } from "../../../components/DomainTimeline";
import { Badge, type BadgeSource } from "../../../components/Badge";
import { BrandLogo, toBrandKey } from "../../../components/BrandLogo";
import type { JumpSource } from "../../../types/provider";
import type { DashboardStats } from "../hooks/useDashboardStats";

/**
 * 跨来源「来源徽章」：DNSHE / Cloudflare / DigitalPlat / 自定义 等按品牌色渲染。
 * 未识别的来源（后端新增服务商但前端未同步）退回 idle 中性色，
 * 而不是崩掉或渲染成 undefined class。
 */
const DomainSourceBadge = ({ source }: { source: string }) => {
  const key = toBrandKey(source);
  if (!key) {
    return <Badge tone="idle" size="sm" className="flex-shrink-0">{source}</Badge>;
  }
  return (
    <Badge
      source={key as BadgeSource}
      size="sm"
      className="flex-shrink-0"
      icon={<BrandLogo brand={key} size={12} className="mr-1" />}
    >
      {source}
    </Badge>
  );
};

interface DashboardPageProps {
  stats: DashboardStats;
  /** 当前是否正在全量同步（actionLoading === "sync-all"） */
  syncing: boolean;
  /** 全量同步（唯一入口） */
  onSyncAll: () => void;
  /** 点击统计卡跳转标签页 */
  onGotoTab: (tab: "domains" | "accounts") => void;
  /** 点击时间轴 / 预警行：按来源跳转并定位高亮 */
  onJump: (source: JumpSource, fullDomain: string) => void;
  /** 把展示名（DNSHE/Cloudflare/...）映射为 JumpSource */
  toJumpSource: (displayName: string) => JumpSource;
}

export function DashboardPage({
  stats,
  syncing,
  onSyncAll,
  onGotoTab,
  onJump,
  toJumpSource,
}: DashboardPageProps) {
  return (
    <div className="space-y-6 pt-5 md:pt-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-2xl font-black text-content-primary flex items-center gap-2">
            <LayoutDashboard className="w-6 h-6 text-accent" /> 概览
          </h2>
          <p className="text-content-muted mt-1 text-sm">域名资产总览与到期预警</p>
        </div>
        {/* 全量同步（唯一入口）：跨所有服务商回源，子请求量最大，日常优先用各页的「同步域名」 */}
        <button
          onClick={onSyncAll}
          disabled={syncing}
          className="px-4 py-2 text-sm font-semibold bg-accent-gradient hover:shadow-accent rounded-lg transition-all flex items-center justify-center gap-2 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
          title="同步所有服务商的账号与域名"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
          同步所有账号
        </button>
      </div>

      {/* 顶部统计卡片 */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {[
          { label: "总域名", value: stats.total, icon: <Globe className="w-5 h-5" />, color: "text-accent", tab: "domains" as const },
          { label: "活跃域名", value: stats.active, icon: <CheckCircle2 className="w-5 h-5" />, color: "text-emerald-400", tab: "domains" as const },
          { label: "已过期", value: stats.expired, icon: <AlertTriangle className="w-5 h-5" />, color: "text-red-400", tab: "domains" as const },
          { label: "API 账号", value: stats.accounts, icon: <Key className="w-5 h-5" />, color: "text-amber-400", tab: "accounts" as const },
        ].map((card) => (
          <button
            key={card.label}
            onClick={() => onGotoTab(card.tab)}
            className="glass-card rounded-2xl p-4 sm:p-5 text-left flex flex-col gap-2 sm:gap-3 group"
          >
            <div className={`flex items-center gap-2 min-w-0 ${card.color}`}>
              <span className="flex-shrink-0">{card.icon}</span>
              <span className="text-[11px] sm:text-xs font-semibold text-content-muted uppercase tracking-wide truncate">{card.label}</span>
            </div>
            <div className="text-2xl sm:text-3xl font-black text-content-primary">{card.value}</div>
          </button>
        ))}
      </div>

      {/* 资产时间轴：未来 12 个月的到期分布。
          放在统计卡之后、两个明细列表之前 —— 它提供的是「全局压力感」，
          先看分布再看具体哪几个，认知顺序比反过来更顺。
          NOTE: 与下方「到期预警」口径不同：预警只筛 90 天内，
          时间轴是全量 12 个月，所以两张卡的域名数不必相等。 */}
      <DomainTimeline
        buckets={stats.timeline.buckets}
        maxCount={stats.timeline.maxCount}
        scheduledTotal={stats.timeline.scheduledTotal}
        permanentCount={stats.timeline.permanentCount}
        overdueCount={stats.timeline.overdueCount}
        onPickDomain={(fullDomain, source) => {
          // NOTE: 必须按来源分派，不能只「填搜索 + 切到域名页」——
          // 域名列表页（domains）只有 DNSHE 数据，groupedDomains /
          // domainSearchIndex 都只扫 domains 数组，所以一个 DigitalPlat
          // 或 Cloudflare 域名填进搜索框后命中数恒为 0，用户看到的是
          // 「搜索了但什么都没有」。这里复用跨来源搜索同一套 gotoXxx
          // 定位链（切到对应标签页 + 展开账号分组 + 高亮滚动）。
          onJump(toJumpSource(source), fullDomain);
        }}
      />

      {/* 中间：最近注册 */}
      <div className="bg-surface border border-border-base rounded-2xl overflow-hidden">
        <div className="px-4 sm:px-5 py-3.5 border-b border-border-base flex items-center gap-2">
          <Activity className="w-4 h-4 text-accent" />
          <h3 className="font-bold text-content-primary text-sm">最近注册</h3>
        </div>
        <div className="divide-y divide-border-soft">
          {stats.recent.length === 0 ? (
            <div className="px-5 py-10 text-center text-content-muted text-sm">暂无数据</div>
          ) : (
            stats.recent.map((d) => (
              /* NOTE: 手机上域名与账号别名各占一行 —— 挤在一行里两者都会被截断，
                 而这两个信息都要看（长别名在 390px 下会丢掉一半） */
              <div key={`${d.source}-${d.full_domain}`} className="px-4 sm:px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-2 hover:bg-hovered transition-colors">
                <span className="font-mono text-xs sm:text-sm text-content-primary truncate min-w-0 flex items-center gap-2">
                  {d.full_domain}
                  <DomainSourceBadge source={d.source} />
                </span>
                <span className="text-[11px] sm:text-xs text-content-muted truncate min-w-0 sm:flex-shrink-0 sm:max-w-[35%]">{d.alias}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 到期预警：已过期 + 90 天内到期，最紧急排最前 */}
      <div className="bg-surface border border-border-base rounded-2xl overflow-hidden">
        <div className="px-4 sm:px-5 py-3.5 border-b border-border-base flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-400" />
          <h3 className="font-bold text-content-primary text-sm">到期预警</h3>
          <span className="text-[11px] text-content-muted font-normal">
            已过期 / 90 天内到期
          </span>
          {stats.expiringTotal > 0 && (
            <span className="ml-auto text-[11px] font-semibold text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 px-2 py-0.5 rounded-full flex-shrink-0">
              {stats.expiringTotal} 个
            </span>
          )}
        </div>
        <div className="divide-y divide-border-soft">
          {stats.expiring.length === 0 ? (
            <div className="px-5 py-10 text-center text-content-muted text-sm">
              暂无临期或已过期域名
            </div>
          ) : (
            stats.expiring.map((d) => (
              /* 与时间轴的域名行保持同一交互：点击按来源跳到对应标签页并定位高亮。
                 两处展示的是同一批数据，一处可点一处不可点会让人以为后者是坏的。 */
              <button
                key={`${d.source}-${d.full_domain}`}
                type="button"
                onClick={() => onJump(toJumpSource(d.source), d.full_domain)}
                title={`前往 ${d.source} 列表查看 ${d.full_domain}`}
                className="w-full text-left px-4 sm:px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-2 hover:bg-hovered transition-colors"
              >
                <span className="font-mono text-xs sm:text-sm text-content-primary truncate min-w-0 flex items-center gap-2">
                  {d.full_domain}
                  <DomainSourceBadge source={d.source} />
                </span>
                <span className="flex items-center gap-2 min-w-0 sm:flex-shrink-0">
                  <span className="text-[11px] sm:text-xs text-content-muted truncate min-w-0 max-w-[160px] sm:max-w-[200px]" title={d.alias}>{d.alias}</span>
                  {/* 二态语义：已过期走 danger（不可逆），临期走 warn。
                      阈值与 expiryBadge / 时间轴同档（30 天），全站一致。 */}
                  <Badge
                    tone={d.expired ? "danger" : d.daysLeft <= 30 ? "warn" : "info"}
                    size="sm"
                    className="flex-shrink-0 whitespace-nowrap"
                  >
                    {d.expired ? `已过期 ${Math.ceil(-d.daysLeft)} 天` : `剩 ${Math.ceil(d.daysLeft)} 天`}
                  </Badge>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
