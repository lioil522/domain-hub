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
import { normalizeDomainKey } from "./domain-keys";

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
export function parseCatalogDate(raw: string, timezoneOffset = 0): number {
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(raw)) {
    return Date.parse(raw.replace(" ", "T") + "Z") + timezoneOffset * 60_000;
  }
  return Date.parse(raw);
}
/** Bounded, request-local memo; never retain inventory/date state globally. */
export function createCatalogDateParser(timezoneOffset: number) {
  const cache = new Map<string, number>();
  return (raw: string) => {
    const old = cache.get(raw);
    if (old !== undefined) return old; // NaN is cached too.
    const time = parseCatalogDate(raw, timezoneOffset);
    if (cache.size < 2048) cache.set(raw, time);
    return time;
  };
}

function insertBounded<T>(items: T[], item: T, limit: number, compare: (a: T, b: T) => number) {
  if (limit === 0) return;
  // Insert after equal values: same stable tie order as Array.sort + slice.
  let index = items.length;
  while (index > 0 && compare(items[index - 1], item) > 0) index--;
  if (index >= limit) return;
  items.splice(index, 0, item);
  if (items.length > limit) items.pop();
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

interface ExpiryEntry {
  full_domain: string;
  daysLeft: number;
  expired: boolean;
  source: string;
  alias: string;
  time: number;
}
interface DomainAggregate {
  expired: boolean;
  permanent: boolean;
  expiryIndex: number;
  recentRow: SummaryDomain | undefined;
  recentSource: string;
  recentTime: number;
  recentOrdinal: number;
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
}: DashboardStatsOptions, now = Date.now(), timelineLimit = Infinity, timezoneOffset = new Date(now).getTimezoneOffset(),
parseTime = createCatalogDateParser(timezoneOffset)) {
  // A small conversion memo helps highly duplicated/mixed-case inventories
  // without restoring a full-sized raw-name cache alongside the canonical map.
  const keyMemo = new Map<string, string>();
  const keyOf = (raw: string) => {
    const cached = keyMemo.get(raw);
    if (cached !== undefined) return cached;
    const key = normalizeDomainKey(raw);
    if (keyMemo.size < 512) keyMemo.set(raw, key);
    return key;
  };
  const calendarDate = (time: number) => new Date(time - timezoneOffset * 60_000);
  // 归一到期判断：空/非法/「永久」占位(0000 前缀) → 视为永久（未过期）
  const isExpired = (expiresAt?: string, status?: string): boolean => {
    if (status === "已过期") return true;
    if (!expiresAt || expiresAt.startsWith("0000")) return false;
    const t = parseTime(expiresAt);
    return !isNaN(t) && t < now;
  };

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
  const expiryAtKey = (key: string) => {
    const entry = cfExpiryMap[key];
    return entry?.manual ? (entry.expires_at || "0000-00-00") : entry?.expires_at;
  };
  const resolveExpiry = (fullDomain: string, key: string, fallback: string): string | undefined => {
    const raw = expiryAtKey(key);
    if (raw) return raw;
    const clean = fullDomain.replace(/[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g, "");
    if (clean !== fullDomain) {
      const stripped = expiryAtKey(keyOf(clean));
      if (stripped) return stripped;
    }
    // 兜底：来源自身带的到期时间（自定义域名没有 cfExpiryMap 条目，全靠这条）
    return fallback;
  };

  // One aggregate per canonical domain replaces the full raw-key/candidate caches,
  // separate seen/recent/expiry maps and expired/permanent sets.
  const byKey = new Map<string, DomainAggregate>();
  // First finite expiry insertion order is NOT canonical-domain insertion
  // order: a domain may be permanent/invalid in its first source.
  const expiryEntries: ExpiryEntry[] = [];
  let recentOrdinal = 0, finiteRecent = true;
  let selectedRecent: DomainAggregate[] = [];
  const addDomain = (full_domain: string, fallback: string, source: string, alias: string,
    status?: string, registration?: SummaryDomain, rawExpiry = true) => {
    const key = keyOf(full_domain);
    if (!key) return;
    let aggregate = byKey.get(key);
    if (!aggregate) {
      aggregate = { expired: false, permanent: false, expiryIndex: -1,
        recentRow: undefined, recentSource: "", recentTime: NaN, recentOrdinal: -1 };
      byKey.set(key, aggregate);
    }
    // Raw status/expiry OR is distinct from the chosen resolved expiry. A raw
    // expired status with a future resolved date still keeps its timeline row.
    if (rawExpiry && isExpired(fallback, status)) aggregate.expired = true;
    // Retain the FIRST truthy created_at, even when it is an invalid date.
    if (!aggregate.recentRow && registration?.created_at) {
      aggregate.recentRow = registration; aggregate.recentSource = source;
      aggregate.recentTime = parseTime(registration.created_at); aggregate.recentOrdinal = recentOrdinal++;
      finiteRecent &&= Number.isFinite(aggregate.recentTime);
      if (finiteRecent) insertBounded(selectedRecent, aggregate, 6, (a, b) => b.recentTime - a.recentTime);
    }
    const expires_at = resolveExpiry(full_domain, key, fallback);
    // 永久占位（0000 前缀）与空值：不算过期，也不进预警
    const permanent = !expires_at || expires_at.startsWith("0000");
    if (permanent) {
      aggregate.permanent = true;
      return;
    }
    const time = parseTime(expires_at!);
    if (isNaN(time)) return;
    const daysLeft = (time - now) / 86400000;
    const isExp = daysLeft < 0;
    if (isExp) aggregate.expired = true;
    const prev = expiryEntries[aggregate.expiryIndex];
    // 去重取更紧急的一条：已过期优先，其次剩余天数更少
    if (prev) {
      if (prev.expired && !isExp) return;
      if (prev.expired === isExp && prev.daysLeft <= daysLeft) return;
    }
    if (aggregate.expiryIndex < 0) aggregate.expiryIndex = expiryEntries.length;
    expiryEntries[aggregate.expiryIndex] = { full_domain, daysLeft, expired: isExp, source, alias: alias || "", time };
  };
  for (const d of domains) addDomain(d.full_domain, d.expires_at, "DNSHE", d.account_alias, d.status, d);
  // Cloudflare ignores raw status/expiry, but still uses resolved expiry.
  for (const d of cfZones) addDomain(d.full_domain, d.expires_at, "Cloudflare", d.account_alias, undefined, d, false);
  for (const d of dpDomains) addDomain(d.full_domain, d.expires_at, "DigitalPlat", d.account_alias, d.status, d);
  for (const d of customDomains) addDomain(d.full_domain, d.expires_at, "自定义", groupNameById.get(d.group_id) || "");
  for (const key of MULTI_PROVIDER_ORDER) for (const d of multiProviderDomains[key]) {
    addDomain(d.full_domain, d.expires_at, MULTI_PROVIDER_META[key].label, d.account_alias, d.status, d);
  }

  let recent;
  if (!finiteRecent) {
    // NaN makes the historical comparator non-total. Reconstruct FIRST
    // registration insertion order before applying the original stable sort;
    // sorting canonical map order here would silently change legacy results.
    const ordered: DomainAggregate[] = [];
    for (const item of byKey.values()) if (item.recentRow) ordered[item.recentOrdinal] = item;
    // Keep both the legacy row shape and date-parsing comparator. Replacing
    // NaN comparisons with cached numeric fields can select a different V8
    // sorting path for this non-total comparator, even within the same runtime.
    recent = Array.from(ordered, item => ({
      full_domain: item.recentRow!.full_domain, created_at: item.recentRow!.created_at,
      source: item.recentSource, alias: item.recentRow!.account_alias,
    })).sort((a, b) => parseTime(b.created_at!) - parseTime(a.created_at!)).slice(0, 6);
  } else {
    recent = selectedRecent.map(item => ({
      full_domain: item.recentRow!.full_domain, created_at: item.recentRow!.created_at,
      source: item.recentSource, alias: item.recentRow!.account_alias,
    }));
  }
  let expired = 0, permanentCount = 0;
  for (const aggregate of byKey.values()) {
    if (aggregate.expired) expired++;
    if (aggregate.permanent && !aggregate.expired && aggregate.expiryIndex < 0) permanentCount++;
  }
  const total = byKey.size;
  const active = Math.max(0, total - expired);

  const EXPIRY_WARN_DAYS = 90;
  const expiring: ExpiryEntry[] = [];
  let expiringTotal = 0;
  for (const x of expiryEntries) {
    if (!x.expired && x.daysLeft > EXPIRY_WARN_DAYS) continue;
    expiringTotal++;
    insertBounded(expiring, x, 8, (a, b) => a.daysLeft - b.daysLeft);
  }

  /**
   * 未来 12 个月到期分布（时间轴数据源）。
   *
   * WHY 单独算而不是复用预警列表：预警列表只保留「90 天内或已过期」这一个
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
  const boundedTimeline = Number.isInteger(timelineLimit) && timelineLimit >= 0 && Number.isFinite(timelineLimit);

  // Iterate canonical entries in FIRST finite expiry insertion order, retaining
  // the historical stable tie order after a later source replaces its date.
  for (const r of expiryEntries) {
    if (r.expired) continue; // 已过期 → 走 overdue，不占月桶
    const due = calendarDate(r.time);
    const bucket = bucketByKey.get(monthKeyOf(due));
    if (!bucket) continue; // 落在 12 个月之外
    const item = {
      full_domain: r.full_domain,
      source: r.source,
      alias: r.alias || "",
      daysLeft: r.daysLeft,
      day: due.getUTCDate(),
    };
    bucket.count++;
    if (boundedTimeline) insertBounded(bucket.items, item, timelineLimit, (a, b) => a.day - b.day);
    else bucket.items.push(item);
  }
  // 桶内按自然日升序，让「这个月先到期的排前面」
  buckets.forEach((b) => {
    if (!boundedTimeline) {
      b.items.sort((a, b2) => a.day - b2.day);
      b.items = b.items.slice(0, timelineLimit);
    }
  });

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
    expiring,
    expiringTotal,
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
