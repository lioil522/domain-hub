/**
 * useDashboardStats —— 「概览（Dashboard）」标签页的聚合统计（纯前端计算）。
 *
 * 由 App.tsx 纯搬运抽出（Phase 10）。原始 useMemo 体逐字未改，仅把消费的
 * 数据源改为选项参数，便于在 App 之外单元化与复用。
 *
 * 聚合 DNSHE + Cloudflare + DigitalPlat + 自定义服务商，按归一化 full_domain 去重。
 */
import { useMemo } from "react";
import { normalizeDomainKey, domainKeyCandidates } from "../../../lib/domain-keys";
import { useCfExpiry } from "../../cloudflare/hooks/useCfExpiry";
import type { Domain } from "../../../types/domain";
import type { Account } from "../../../types/account";
import type { CustomDomain } from "../../../types/custom";

export interface UseDashboardStatsOptions {
  domains: Domain[];
  cfZones: Domain[];
  dpDomains: Domain[];
  customDomains: CustomDomain[];
  dnsheAccounts: Account[];
  cfAccountList: Account[];
  dpAccountList: Account[];
  customGroupList: Array<{ id: number; alias: string }>;
  cfExpiryMap: ReturnType<typeof useCfExpiry>["cfExpiryMap"];
}

export function useDashboardStats({
  domains,
  cfZones,
  dpDomains,
  customDomains,
  dnsheAccounts,
  cfAccountList,
  dpAccountList,
  customGroupList,
  cfExpiryMap,
}: UseDashboardStatsOptions) {
  // Dashboard 概览统计（纯前端计算，聚合 DNSHE + Cloudflare + DigitalPlat + 自定义服务商）
  // NOTE: 同一域名可能同时存在于多个来源（如 it.us.ci 在 DNSHE 与 Cloudflare 各一条），
  // 因此按归一化的 full_domain 去重，避免总域名/活跃/过期重复计数。
  return useMemo(() => {
    const now = Date.now();
    // 归一到期判断：空/非法/「永久」占位(0000 前缀) → 视为永久（未过期）
    const isExpired = (expiresAt?: string, status?: string): boolean => {
      if (status === "已过期") return true;
      if (!expiresAt || expiresAt.startsWith("0000")) return false;
      const t = new Date(expiresAt).getTime();
      return !isNaN(t) && t < now;
    };

    // 按归一化域名去重的聚合记录：value 记录「是否过期」；任一来源过期即算过期
    const seen = new Map<string, boolean>(); // key → 是否过期
    const record = (fullDomain: string, expiredFlag: boolean) => {
      const key = normalizeDomainKey(fullDomain);
      if (!key) return;
      // 已存在时：任一来源判定过期则整体算过期（取 OR）
      seen.set(key, seen.has(key) ? (seen.get(key)! || expiredFlag) : expiredFlag);
    };

    domains.forEach((d) => record(d.full_domain, isExpired(d.expires_at, d.status)));
    cfZones.forEach((z) => record(z.full_domain, false)); // CF 恒永久，算未过期
    dpDomains.forEach((d) => record(d.full_domain, isExpired(d.expires_at, d.status)));
    customDomains.forEach((d) => record(d.full_domain, isExpired(d.expires_at)));

    const total = seen.size;

    // 统一取每个域名的「真实到期时间」：按 cfZoneDateInfo 的优先级链
    // （手动覆盖 > DNSHE 上游 > DigitalPlat 上游 > RDAP 自动查询）。
    //
    // NOTE: 这里必须用这条链而不是直接读 d.expires_at ——
    //   · Cloudflare zone 本身没有任何到期字段（有效期登记在注册商处）；
    //   · DNSHE 对部分域名不返回到期时间（空串）；
    // 真正查到的值只存在于 cfExpiryMap（RDAP 缓存 + 用户手动录入）里，
    // 早先统计只读 d.expires_at 才导致「已过期」永远是 0。
    // 自定义域名的归属：CustomDomain 只带 group_id，分组名要从 customGroupList 里反查。
    const groupNameById = new Map(customGroupList.map((g) => [g.id, g.alias]));
    const resolveExpiry = (fullDomain: string, fallback?: string): string | undefined => {
      const candidates = domainKeyCandidates(fullDomain);
      for (const k of candidates) {
        const entry = cfExpiryMap[k];
        const manual = entry?.manual ? entry : undefined;
        const raw = manual ? (manual.expires_at || "0000-00-00") : entry?.expires_at;
        if (raw) return raw;
      }
      // 兜底：来源自身带的到期时间（自定义域名没有 cfExpiryMap 条目，全靠这条）
      return fallback;
    };

    const expiryRecords = [
      ...domains.map((d) => ({ full_domain: d.full_domain, expires_at: resolveExpiry(d.full_domain, d.expires_at), status: d.status, source: "DNSHE" as const, alias: d.account_alias })),
      ...cfZones.map((z) => ({ full_domain: z.full_domain, expires_at: resolveExpiry(z.full_domain, z.expires_at), status: undefined, source: "Cloudflare" as const, alias: z.account_alias })),
      ...dpDomains.map((d) => ({ full_domain: d.full_domain, expires_at: resolveExpiry(d.full_domain, d.expires_at), status: d.status, source: "DigitalPlat" as const, alias: d.account_alias })),
      ...customDomains.map((d) => ({ full_domain: d.full_domain, expires_at: resolveExpiry(d.full_domain, d.expires_at), status: undefined, source: "自定义" as const, alias: groupNameById.get(d.group_id) || "" }))
    ];

    // 最近注册：跨来源按 created_at 倒序（自定义服务商无 created_at，排除）。
    // 同名域名去重时优先保留有 created_at 的那条，避免同一域名占多行。
    const recentRaw = [
      ...domains.map((d) => ({ full_domain: d.full_domain, created_at: d.created_at, source: "DNSHE" as const, alias: d.account_alias })),
      ...cfZones.map((z) => ({ full_domain: z.full_domain, created_at: z.created_at, source: "Cloudflare" as const, alias: z.account_alias })),
      ...dpDomains.map((d) => ({ full_domain: d.full_domain, created_at: d.created_at, source: "DigitalPlat" as const, alias: d.account_alias }))
    ].filter((x) => x.created_at);
    const recentByName = new Map<string, (typeof recentRaw)[number]>();
    recentRaw.forEach((x) => {
      const key = normalizeDomainKey(x.full_domain);
      if (!key) return;
      if (!recentByName.has(key)) recentByName.set(key, x);
    });
    const recent = Array.from(recentByName.values())
      .sort((a, b) => new Date(b.created_at!).getTime() - new Date(a.created_at!).getTime())
      .slice(0, 6);

    // 到期统计 + 预警共用同一张表：按归一化域名去重，任一来源过期即算过期（取 OR），
    // 到期时间取最先出现的非空值（多来源通常同值，冲突时以列表顺序在前者为准）。
    const expiredKeys = new Set<string>();
    const expiryByKey = new Map<string, { full_domain: string; daysLeft: number; expired: boolean; source: string; alias: string }>();
    for (const r of expiryRecords) {
      const key = normalizeDomainKey(r.full_domain);
      if (!key) continue;
      // 永久占位（0000 前缀）与空值：不算过期，也不进预警
      const permanent = !r.expires_at || r.expires_at.startsWith("0000");
      if (permanent) continue;
      const t = new Date(r.expires_at!).getTime();
      if (isNaN(t)) continue;
      const daysLeft = (t - now) / 86400000;
      const isExp = daysLeft < 0;
      if (isExp) expiredKeys.add(key);
      const prev = expiryByKey.get(key);
      // 去重取更紧急的一条：已过期优先，其次剩余天数更少
      if (prev && (prev.expired && !isExp)) continue;
      if (!(prev && !prev.expired && isExp) && prev && prev.expired === isExp && prev.daysLeft <= daysLeft) continue;
      expiryByKey.set(key, { full_domain: r.full_domain, daysLeft, expired: isExp, source: r.source, alias: r.alias || "" });
    }

    // 已过期口径：RDAP/手动链算出的过期域名，并上原有 isExpired 判定的过期域名
    // （后者覆盖 expires_at 为空但 status 已标过期的场景）。
    seen.forEach((expiredFlag, key) => {
      if (expiredFlag) expiredKeys.add(key);
    });
    const expired = expiredKeys.size;
    const active = Math.max(0, total - expired);

    const EXPIRY_WARN_DAYS = 90;
    const expiringAll = Array.from(expiryByKey.values())
      .filter((x) => x.expired || x.daysLeft <= EXPIRY_WARN_DAYS)
      .sort((a, b) => a.daysLeft - b.daysLeft);

    /**
     * 未来 12 个月到期分布（时间轴数据源）。
     *
     * WHY 单独算而不是复用 expiryByKey：预警列表只保留「90 天内或已过期」这一个
     * 紧急维度，是**筛选后的**子集；时间轴要回答的是「未来一年的续费压力长什么样」，
     * 需要完整分布。两者的筛选口径不同，共用一张表会让「第 7 个月有 3 个到期」
     * 这类信息被静默丢掉。
     *
     * 分桶口径：
     * - 以「本月」为第 0 桶，往后共 12 桶（本月含今天之前的日子，所以本桶可能混有
     *   刚过期的域名，用 expired 计数单独标出，不混淆）。
     * - 已过期（daysLeft < 0）单独归入 overdue，不占月桶 —— 否则它们会全部挤在
     *   第 0 桶里，把「本月真实待续」的数量淹掉。
     * - 永久域名（无到期日 / 0000 占位）单独归入 permanent，同样不进月桶。
     */
    const timelineStart = new Date();
    timelineStart.setHours(0, 0, 0, 0);
    timelineStart.setDate(1); // 对齐到本月 1 日
    const monthKeyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

    const buckets: Array<{
      key: string;
      label: string;
      year: number;
      month: number; // 1-12
      isCurrent: boolean;
      items: Array<{ full_domain: string; source: string; alias: string; daysLeft: number; day: number }>;
    }> = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(timelineStart.getFullYear(), timelineStart.getMonth() + i, 1);
      buckets.push({
        key: monthKeyOf(d),
        // 跨年时补上年份，避免 12 月与次年 1 月看起来一样
        label: `${d.getMonth() + 1}月`,
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        isCurrent: i === 0,
        items: []
      });
    }
    const bucketByKey = new Map(buckets.map((b) => [b.key, b]));
    let permanentCount = 0;

    // NOTE: 用 expiryRecords（含 resolveExpiry 优先级链）而非原始的 d.expires_at ——
    // 与上面「已过期」统计保持同一口径，否则时间轴和概览卡片会对不上数。
    for (const r of expiryRecords) {
      const key = normalizeDomainKey(r.full_domain);
      if (!key) continue;
      const permanent = !r.expires_at || r.expires_at.startsWith("0000");
      if (permanent) {
        permanentCount++;
        continue;
      }
      const t = new Date(r.expires_at!).getTime();
      if (isNaN(t)) continue;
      const daysLeft = (t - now) / 86400000;
      if (daysLeft < 0) continue; // 已过期 → 走 overdue，不占月桶
      const due = new Date(t);
      const bucket = bucketByKey.get(monthKeyOf(due));
      if (!bucket) continue; // 落在 12 个月之外
      bucket.items.push({
        full_domain: r.full_domain,
        source: r.source,
        alias: r.alias || "",
        daysLeft,
        day: due.getDate()
      });
    }
    // 桶内按自然日升序，让「这个月先到期的排前面」
    buckets.forEach((b) => b.items.sort((a, b2) => a.day - b2.day));

    return {
      total,
      active,
      expired,
      // 账号口径：DNSHE 账号 + Cloudflare 账号 + DigitalPlat 账号 + 自定义分组
      accounts: dnsheAccounts.length + cfAccountList.length + dpAccountList.length + customGroupList.length,
      recent,
      expiring: expiringAll.slice(0, 8),
      expiringTotal: expiringAll.length,
      // 时间轴
      timeline: {
        buckets,
        maxCount: Math.max(1, ...buckets.map((b) => b.items.length)),
        scheduledTotal: buckets.reduce((sum, b) => sum + b.items.length, 0),
        permanentCount,
        overdueCount: expired
      }
    };
  }, [domains, cfZones, dpDomains, customDomains, dnsheAccounts, cfAccountList, dpAccountList, customGroupList, cfExpiryMap]);
}

export type DashboardStats = ReturnType<typeof useDashboardStats>;
