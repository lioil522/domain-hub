import React from "react";
import { CalendarClock } from "lucide-react";
import { cn } from "./cn";
import { Badge, type BadgeSource } from "./Badge";

/**
 * DomainTimeline —— 域名资产到期时间轴
 *
 * WHY 需要它：
 * 概览页原有的「到期预警」是**筛选后的**列表（只留 90 天内与已过期），
 * 它回答「哪些域名现在要处理」，但不回答「未来一年的续费压力长什么样」。
 * 用户无法从一个 90 天窗口的列表里看出「8 月会有 6 个域名集中到期」，
 * 而这恰恰是决定要不要提前续费、要不要放弃某些域名的关键信息。
 *
 * 设计决策：
 * - 12 个月固定横轴（不是按数据自适应）—— 固定的横轴才能形成「对比基线」，
 *   每次打开看到的是同一个坐标系，月份之间的高低才有可比性。
 * - 已过期与永久域名**不占月桶**：前者会全部挤在第 0 桶把真实待续量淹掉，
 *   后者根本没有到期日。两者各自单独成一项，并在页头给出解释。
 * - 柱子高度按当月数量归一，但**同时显示数字** —— 纯视觉高度在数量少时
 *   无法区分「1 个」和「0 个」，数字兜住这个精度。
 * - 颜色复用 Badge 的语义 tone：按「距今天数」分档，而不是按月份 ——
 *   用户真正在意的是「还有多久」，不是「哪个月」。
 */

/** 时间轴单桶的数据形状，与 App.tsx 里 dashboardStats.timeline.buckets 对齐 */
export interface TimelineBucketItem {
  full_domain: string;
  source: string;
  alias: string;
  daysLeft: number;
  day: number;
}

export interface TimelineBucket {
  key: string;
  label: string;
  year: number;
  month: number;
  isCurrent: boolean;
  items: TimelineBucketItem[];
}

export interface DomainTimelineProps {
  buckets: TimelineBucket[];
  /** 当前最大桶的域名数，用于归一柱高；由调用方算好以保证与实际渲染一致 */
  maxCount: number;
  scheduledTotal: number;
  permanentCount: number;
  overdueCount: number;
  /**
   * 点击某个域名时跳转。
   *
   * NOTE: 必须把 source 一起传出 —— 各服务商的域名存在**不同的列表和标签页**里，
   * 调用方需要按来源分派到对应的定位逻辑。只传域名会让调用方只能做「全局搜索」，
   * 而全局搜索只覆盖其中一个来源。
   */
  onPickDomain?: (fullDomain: string, source: string) => void;
  className?: string;
}

/** 服务商名 → Badge 的 source 键；未识别返回 undefined（退回 idle tone） */
function toBadgeSource(source: string): BadgeSource | undefined {
  const s = source.toLowerCase();
  if (s === "dnshe") return "dnshe";
  if (s === "cloudflare") return "cloudflare";
  if (s === "digitalplat") return "digitalplat";
  if (s === "自定义" || s === "custom") return "custom";
  return undefined;
}

/**
 * 剩余天数 → 语义 tone。
 * 分档与 expiryTone / 后端 renew_threshold_days 完全一致（30 / 90），
 * 刻意不引第三套阈值，否则同一批数据在不同视图里会闪现不同颜色。
 */
function urgencyTone(daysLeft: number) {
  if (daysLeft <= 30) return "danger";
  if (daysLeft <= 90) return "warn";
  return "info";
}

export function DomainTimeline(props: DomainTimelineProps) {
  const {
    buckets,
    maxCount,
    scheduledTotal,
    permanentCount,
    overdueCount,
    onPickDomain,
    className
  } = props;

  // 展开态：默认展开最近一个「有域名到期」的桶，因为那是用户最可能关心的
  const firstNonEmpty = buckets.findIndex((b) => b.items.length > 0);
  const [openKey, setOpenKey] = React.useState<string | null>(
    firstNonEmpty >= 0 ? buckets[firstNonEmpty].key : null
  );

  const openBucket = buckets.find((b) => b.key === openKey) || null;
  const hasAny = scheduledTotal > 0;

  return (
    <section
      className={cn("ui-card ui-card--default overflow-hidden", className)}
      aria-labelledby="domain-timeline-heading"
    >
      {/* 页头 */}
      <div className="px-4 sm:px-5 py-3.5 border-b border-border-base flex flex-wrap items-center gap-2">
        <CalendarClock className="w-4 h-4 text-indigo-400 shrink-0" aria-hidden="true" />
        <h3 id="domain-timeline-heading" className="font-bold text-content-primary text-sm">
          资产时间轴
        </h3>
        <span className="text-[11px] text-content-muted font-normal">未来 12 个月到期分布</span>
        <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
          {overdueCount > 0 && (
            <Badge tone="danger" size="sm">{overdueCount} 个已过期</Badge>
          )}
          {scheduledTotal > 0 && (
            <Badge tone="info" size="sm" title="未来 12 个月内有明确到期日的域名数">
              待续 {scheduledTotal} 个
            </Badge>
          )}
          {permanentCount > 0 && (
            <Badge tone="idle" size="sm" title="无到期日或标记为永久的域名，不占用月桶">
              永久 {permanentCount} 个
            </Badge>
          )}
        </div>
      </div>

      {!hasAny ? (
        <div className="px-5 py-10 text-center text-content-muted text-sm">
          未来 12 个月内没有域名到期
          {permanentCount > 0 && <span className="block mt-1 text-xs">另有 {permanentCount} 个永久域名</span>}
        </div>
      ) : (
        <>
          {/* 柱状区 —— 12 个月固定横轴 */}
          <div className="px-3 sm:px-5 pt-4 pb-2">
            <div
              className="flex items-end gap-1 sm:gap-1.5 h-32"
              role="img"
              aria-label={`未来 12 个月域名到期分布，共 ${scheduledTotal} 个域名。逐月数量：${buckets
                .map((b) => `${b.month}月 ${b.items.length} 个`)
                .join("，")}`}
            >
              {buckets.map((b) => {
                const count = b.items.length;
                const isOpen = openKey === b.key;
                // 归一高度；有域名时保底 12% 高度 —— 当某个月集中了 20 个域名时，
                // 1 个域名的那格会被压到不足 1px，与零基线无法区分。
                const heightPct = count === 0 ? 0 : Math.max(12, (count / maxCount) * 100);
                // 当前月用品牌色，其余用中性色，让「现在」在轴上可定位
                const barClass = count === 0
                  ? ""
                  : b.isCurrent
                    ? "bg-gradient-to-t from-indigo-600 to-indigo-400"
                    : "bg-slate-400/60 dark:bg-slate-500/50";

                return (
                  <button
                    key={b.key}
                    type="button"
                    onClick={() => count > 0 && setOpenKey(isOpen ? null : b.key)}
                    disabled={count === 0}
                    aria-pressed={count > 0 ? isOpen : undefined}
                    aria-label={
                      count === 0
                        ? `${b.year}年${b.month}月，无域名到期`
                        : `${b.year}年${b.month}月，${count} 个域名到期，点击展开列表`
                    }
                    title={count === 0 ? `${b.year}年${b.month}月：无` : `${b.year}年${b.month}月：${count} 个`}
                    className={cn(
                      "group flex-1 min-w-0 h-full flex flex-col justify-end items-center gap-1 rounded-md",
                      count === 0 ? "cursor-default" : "cursor-pointer"
                    )}
                  >
                    {/* 数量：始终显示，兜住「1 个 vs 0 个」的视觉精度 */}
                    <span
                      className={cn(
                        "text-[10px] sm:text-[11px] font-bold tabular-nums leading-none transition-colors",
                        count === 0
                          ? "text-content-muted/40"
                          : isOpen
                            ? "text-indigo-500 dark:text-indigo-300"
                            : "text-content-secondary"
                      )}
                    >
                      {count}
                    </span>

                    {/* 柱体：外层撑满剩余高度做定位，内层用高度百分比。
                        零值不画柱子，只留一条虚线的「零基线」—— 用虚线而非实线，
                        是为了让「这个月真的没有」和「这个月有 1 个但很矮」
                        在视觉上完全不同，不会被误读成同一回事。 */}
                    <span className="w-full flex-1 flex items-end">
                      {count === 0 ? (
                        <span
                          className="w-full h-0 border-t border-dashed border-border-base"
                          aria-hidden="true"
                        />
                      ) : (
                        <span
                          className={cn(
                            "w-full rounded-t-md transition-all duration-300 ease-out",
                            barClass,
                            isOpen ? "ring-2 ring-indigo-400/60" : "group-hover:brightness-110"
                          )}
                          style={{ height: `${heightPct}%` }}
                        />
                      )}
                    </span>

                    {/* 月份标签。跨年的那一格（1 月）额外显示年份 ——
                        12 个月必然跨一次年，不给年份的话「1月」到底指哪一年看不出来。 */}
                    <span
                      className={cn(
                        "text-[10px] sm:text-[11px] font-medium leading-none pb-0.5 transition-colors whitespace-nowrap",
                        b.isCurrent
                          ? "text-indigo-500 dark:text-indigo-300 font-bold"
                          : count === 0
                            ? "text-content-muted/60"
                            : "text-content-muted"
                      )}
                    >
                      {b.month === 1 ? `${b.year}年1月` : b.label}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* 当前月标记说明：柱图里用颜色区分「现在」，这里补一句文字，
                避免只靠颜色传达信息（色觉障碍用户同样能读懂） */}
            <div className="mt-1 px-1 text-[11px] text-content-muted flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-gradient-to-t from-indigo-600 to-indigo-400 shrink-0" aria-hidden="true" />
              深色柱为当前月份
            </div>
          </div>

          {/* 展开区：选中月份的域名清单 */}
          {openBucket && openBucket.items.length > 0 && (
            <div className="border-t border-border-base">
              <div className="px-4 sm:px-5 py-2.5 bg-hovered flex items-center gap-2">
                <span className="text-xs font-semibold text-content-primary">
                  {openBucket.year} 年 {openBucket.month} 月
                </span>
                <span className="text-[11px] text-content-muted">
                  {openBucket.items.length} 个到期
                </span>
              </div>
              <ul className="divide-y divide-border-soft">
                {openBucket.items.map((item) => {
                  const ToneBadge = (
                    <Badge tone={urgencyTone(item.daysLeft)} size="sm" className="flex-shrink-0">
                      剩 {Math.max(0, Math.ceil(item.daysLeft))} 天
                    </Badge>
                  );
                  const src = toBadgeSource(item.source);
                  const rowClass = cn(
                    "w-full px-4 sm:px-5 py-2.5 flex items-center gap-2 text-left transition-colors",
                    onPickDomain && "hover:bg-hovered"
                  );
                  const inner = (
                    <>
                      <span className="font-mono text-xs text-content-primary truncate min-w-0">
                        {item.full_domain}
                      </span>
                      {src && (
                        <Badge source={src} size="sm" className="flex-shrink-0">{item.source}</Badge>
                      )}
                      <span className="ml-auto flex items-center gap-2 flex-shrink-0">
                        <span
                          className="hidden sm:inline text-[11px] text-content-muted truncate max-w-[160px]"
                          title={item.alias}
                        >
                          {item.alias}
                        </span>
                        {ToneBadge}
                      </span>
                    </>
                  );
                  return (
                    <li key={`${item.source}-${item.full_domain}`}>
                      {onPickDomain ? (
                        <button
                          type="button"
                          onClick={() => onPickDomain(item.full_domain, item.source)}
                          className={rowClass}
                          title={`前往 ${item.source} 列表查看 ${item.full_domain}`}
                        >
                          {inner}
                        </button>
                      ) : (
                        <div className={rowClass}>{inner}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
