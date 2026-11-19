/**
 * 概览聚合（纯函数，无 React 依赖）
 *
 * 抽出的原因：同一份统计既要给页面渲染，也要能在 Node 测试里直接断言
 * 「跨来源同域只计一次」「四家新托管商会计入」。若继续把逻辑埋在 useMemo 里，
 * 任何回归都只能靠浏览器肉眼发现。
 *
 * 口径：
 * - DNSHE / Cloudflare / DigitalPlat / 自定义 / DNSPod / 阿里云 / 华为云 / Vercel
 *   统一按归一化 full_domain 去重。
 * - 到期时间沿用 cfExpiryMap 的优先级链（手动覆盖 > 上游 > RDAP）。
 * - 时间轴同样按域名去重，一个域名只占一个月份格子。
 */
import { normalizeDomainKey, domainKeyCandidates } from "./domain-keys";

export type MultiProviderKey = "dnspod" | "alidns" | "huaweicloud" | "vercel";
export const MULTI_PROVIDER_ORDER: MultiProviderKey[] = ["dnspod", "alidns", "huaweicloud", "vercel"];
const MULTI_PROVIDER_META = {
  dnspod: { label: "DNSPod" }, alidns: { label: "阿里云 DNS" },
  huaweicloud: { label: "华为云 DNS" }, vercel: { label: "Vercel" },
};
export interface SummaryDomain {
  full_domain: string;
  expires_at: string;
  status?: string;
  created_at?: string;
  account_alias: string;
}
interface CustomDomain {
  full_domain: string;
  expires_at: string;
  group_id: number;
}
export interface SummaryExpiry {
  found: boolean;
  manual?: boolean;
  expires_at?: string;
}

export interface DashboardStatsOptions {
  domains: SummaryDomain[];
  cfZones: SummaryDomain[];
  dpDomains: SummaryDomain[];
  customDomains: CustomDomain[];
  multiProviderDomains: Record<MultiProviderKey, SummaryDomain[]>;
  dnsheAccounts: unknown[];
  cfAccountList: unknown[];
  dpAccountList: unknown[];
  customGroupList: Array<{ id: number; alias: string }>;
  multiProviderAccounts: Record<MultiProviderKey, unknown[]>;
  cfExpiryMap: Record<string, SummaryExpiry>;
}

interface ExpiryRecord {
  full_domain: string;
  expires_at?: string;
  status?: string;
  source: string;
  alias: string;
}

interface ExpiryEntry {
  full_domain: string;
  daysLeft: number;
  expired: boolean;
  source: string;
  alias: string;
  time: number;
}

export function computeDashboardStats({
  domains,
  cfZones,
  dpDomains,
  customDomains,
  multiProviderDomains,
  dnsheAccounts,
  cfAccountList,
  dpAccountList,
  customGroupList,
  multiProviderAccounts,
  cfExpiryMap,
}: DashboardStatsOptions, now = Date.now(), timelineLimit = Infinity, timezoneOffset = new Date(now).getTimezoneOffset()) {
  const parseTime = (raw: string) => {
    // SQLite-style timestamps have no zone; preserve the requesting browser's
    // interpretation instead of silently treating them as Worker UTC.
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(raw)) {
      return Date.parse(raw.replace(" ", "T") + "Z") + timezoneOffset * 60_000;
    }
    return Date.parse(raw);
  };
  const calendarDate = (time: number) => new Date(time - timezoneOffset * 60_000);
  // 归一到期判断：空/非法/「永久」占位(0000 前缀) → 视为永久（未过期）
  const isExpired = (expiresAt?: string, status?: string): boolean => {
    if (status === "已过期") return true;
    if (!expiresAt || expiresAt.startsWith("0000")) return false;
    const t = parseTime(expiresAt);
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

  const multiRecords = MULTI_PROVIDER_ORDER.flatMap((key) => {
    const label = MULTI_PROVIDER_META[key].label;
    return multiProviderDomains[key].map((d) => ({ domain: d, source: label }));
  });
  multiRecords.forEach(({ domain: d }) => record(d.full_domain, isExpired(d.expires_at, d.status)));

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

  const expiryRecords: ExpiryRecord[] = [
    ...domains.map((d) => ({ full_domain: d.full_domain, expires_at: resolveExpiry(d.full_domain, d.expires_at), status: d.status, source: "DNSHE", alias: d.account_alias })),
    ...cfZones.map((z) => ({ full_domain: z.full_domain, expires_at: resolveExpiry(z.full_domain, z.expires_at), status: undefined, source: "Cloudflare", alias: z.account_alias })),
    ...dpDomains.map((d) => ({ full_domain: d.full_domain, expires_at: resolveExpiry(d.full_domain, d.expires_at), status: d.status, source: "DigitalPlat", alias: d.account_alias })),
    ...customDomains.map((d) => ({ full_domain: d.full_domain, expires_at: resolveExpiry(d.full_domain, d.expires_at), status: undefined, source: "自定义", alias: groupNameById.get(d.group_id) || "" })),
    ...multiRecords.map(({ domain: d, source }) => ({ full_domain: d.full_domain, expires_at: resolveExpiry(d.full_domain, d.expires_at), status: d.status, source, alias: d.account_alias })),
  ];

  // 最近注册：跨来源按 created_at 倒序（自定义服务商无 created_at，排除）。
  // 同名域名去重时优先保留有 created_at 的那条，避免同一域名占多行。
  const recentRaw = [
    ...domains.map((d) => ({ full_domain: d.full_domain, created_at: d.created_at, source: "DNSHE", alias: d.account_alias })),
    ...cfZones.map((z) => ({ full_domain: z.full_domain, created_at: z.created_at, source: "Cloudflare", alias: z.account_alias })),
    ...dpDomains.map((d) => ({ full_domain: d.full_domain, created_at: d.created_at, source: "DigitalPlat", alias: d.account_alias })),
    ...multiRecords.map(({ domain: d, source }) => ({ full_domain: d.full_domain, created_at: d.created_at, source, alias: d.account_alias })),
  ].filter((x) => x.created_at);
  const recentByName = new Map<string, (typeof recentRaw)[number]>();
  recentRaw.forEach((x) => {
    const key = normalizeDomainKey(x.full_domain);
    if (!key) return;
    if (!recentByName.has(key)) recentByName.set(key, x);
  });
  const recent = Array.from(recentByName.values())
    .sort((a, b) => parseTime(b.created_at!) - parseTime(a.created_at!))
    .slice(0, 6);

  // 到期统计 + 预警共用同一张表：按归一化域名去重，任一来源过期即算过期（取 OR），
  // 到期时间冲突时保留更紧急的一条（已过期优先，其次剩余天数更少）。
  const expiredKeys = new Set<string>();
  // 只是「某个来源声称永久」的候选集合。同一域名可能在 A 来源为永久、
  // 在 B 来源有真实到期日；最终必须按域名只归一类，否则时间轴会把
  // permanentCount 与 scheduledTotal 各加一次。
  const permanentCandidates = new Set<string>();
  const expiryByKey = new Map<string, ExpiryEntry>();
  for (const r of expiryRecords) {
    const key = normalizeDomainKey(r.full_domain);
    if (!key) continue;
    // 永久占位（0000 前缀）与空值：不算过期，也不进预警
    const permanent = !r.expires_at || r.expires_at.startsWith("0000");
    if (permanent) {
      permanentCandidates.add(key);
      continue;
    }
    const time = parseTime(r.expires_at!);
    if (isNaN(time)) continue;
    const daysLeft = (time - now) / 86400000;
    const isExp = daysLeft < 0;
    if (isExp) expiredKeys.add(key);
    const prev = expiryByKey.get(key);
    // 去重取更紧急的一条：已过期优先，其次剩余天数更少
    if (prev) {
      if (prev.expired && !isExp) continue;
      if (prev.expired === isExp && prev.daysLeft <= daysLeft) continue;
    }
    expiryByKey.set(key, { full_domain: r.full_domain, daysLeft, expired: isExp, source: r.source, alias: r.alias || "", time });
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
  const timelineStart = calendarDate(now);
  timelineStart.setUTCHours(0, 0, 0, 0);
  timelineStart.setUTCDate(1);
  const monthKeyOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

  const buckets: Array<{
    key: string;
    label: string;
    year: number;
    month: number; // 1-12
    isCurrent: boolean;
    items: Array<{ full_domain: string; source: string; alias: string; daysLeft: number; day: number }>;
    count: number;
  }> = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(timelineStart.getUTCFullYear(), timelineStart.getUTCMonth() + i, 1));
    buckets.push({
      key: monthKeyOf(d),
      // 跨年时补上年份，避免 12 月与次年 1 月看起来一样
      label: `${d.getUTCMonth() + 1}月`,
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      isCurrent: i === 0,
      items: [],
      count: 0,
    });
  }
  const bucketByKey = new Map(buckets.map((b) => [b.key, b]));

  // NOTE: 迭代已去重的 expiryByKey（含 resolveExpiry 优先级链），而不是原始
  // expiryRecords —— 后者会把同一域名在多个来源各推一次，导致时间轴计数虚高。
  for (const r of expiryByKey.values()) {
    if (r.expired) continue; // 已过期 → 走 overdue，不占月桶
    const due = calendarDate(r.time);
    const bucket = bucketByKey.get(monthKeyOf(due));
    if (!bucket) continue; // 落在 12 个月之外
    bucket.items.push({
      full_domain: r.full_domain,
      source: r.source,
      alias: r.alias || "",
      daysLeft: r.daysLeft,
      day: due.getUTCDate(),
    });
  }
  // 桶内按自然日升序，让「这个月先到期的排前面」
  buckets.forEach((b) => {
    b.items.sort((a, b2) => a.day - b2.day);
    b.count = b.items.length;
    b.items = b.items.slice(0, timelineLimit);
  });

  // 按域名归一类：只有当该域名没有任何真实到期日、且没有被判过期时，才算永久。
  let permanentCount = 0;
  for (const key of permanentCandidates) {
    if (expiryByKey.has(key) || expiredKeys.has(key)) continue;
    permanentCount++;
  }

  return {
    total,
    active,
    expired,
    // 账号口径：全部来源的账号数，四家新托管商不能只算域名不算账号
    accounts:
      dnsheAccounts.length +
      cfAccountList.length +
      dpAccountList.length +
      customGroupList.length +
      MULTI_PROVIDER_ORDER.reduce((sum, key) => sum + multiProviderAccounts[key].length, 0),
    recent,
    expiring: expiringAll.slice(0, 8),
    expiringTotal: expiringAll.length,
    // 时间轴
    timeline: {
      buckets,
      maxCount: Math.max(1, ...buckets.map((b) => b.count)),
      scheduledTotal: buckets.reduce((sum, b) => sum + b.count, 0),
      permanentCount,
      overdueCount: expired,
    },
  };
}

export type DashboardStats = ReturnType<typeof computeDashboardStats>;
