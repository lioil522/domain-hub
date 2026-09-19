import { useEffect, useState } from "react";
import { useAppData } from "../../../state/AppDataContext";
import { fetchExpiryDirect } from "../../../lib/rdap";
import { formatDate } from "../../../lib/display-domain";
import { domainKeyCandidates, isRegistrableDomain, normalizeDomainKey } from "../../../lib/domain-keys";
import type { CfExpiryEntry, Domain } from "../../../types/domain";

/** CF zone 注册/到期时间的本地兜底缓存键（localStorage） */
export const CF_EXPIRY_LS_KEY = "DOMAIN_HUB_CF_EXPIRY_CACHE_V1";
/** 本地缓存「新鲜」窗口：6 小时内只查新增域名，过期才全量回源校验 */
export const CF_EXPIRY_FRESH_MS = 6 * 3600 * 1000;

/** `useCfExpiry` 的外部依赖 —— 由 `App.tsx` 注入 */
export interface UseCfExpiryOptions {
  /** 当前激活标签页（仅 "cloudflare" 时触发拉取） */
  activeTab: string;
  /** 当前 CF zones 列表 */
  cfZones: Domain[];
  /** DNSHE 全量域名（用于判定 zone 是否由 DNSHE 注册） */
  domains: Domain[];
  /** DigitalPlat 全量域名（用于判定 zone 是否由 DP 注册） */
  dpDomains: Domain[];
  /** DNSHE 注册域名键集合（App 内已建） */
  dnsheFullDomainSet: Set<string>;
  /** DigitalPlat 注册域名键集合（App 内已建） */
  dpDomainFullDomainSet: Set<string>;
}

/**
 * Cloudflare zone 的注册/到期时间：本地兜底缓存 + 手动覆盖 + RDAP 自动查询
 *
 * 从 `App.tsx` 抽出（Phase 5-1，Cloudflare 第一批「API 与状态」）。**纯搬运**：
 * 缓存键、fresh 窗口、请求路径、合并优先级与全部注释逐字保留。
 *
 * 五块内容：
 *   1. `cfExpiryMap` 状态（冷启动先读 localStorage 秒显）
 *   2. `persistCfExpiryMap` 落盘（含 touchTs 语义）
 *   3. `fetchCfExpiry`（合并 `/api/date-overrides` + `/api/expiry` + 浏览器直查兜底）
 *   4. 进入 CF 页 / zones 变化时的自动拉取 effect
 *   5. `cfZoneDateInfo`（单个 zone 的日期推导，卡片与编辑弹窗共用）
 *
 * NOTE: `cfZoneDateInfo` 依赖 `domains` / `dpDomains`（DNSHE / DP 上游缓存），
 * 由 App 作为参数注入 —— 不把整个 `domains` 状态搬进 CF hook，保持模块边界清晰。
 */
export function useCfExpiry({
  activeTab,
  cfZones,
  domains,
  dpDomains,
  dnsheFullDomainSet,
  dpDomainFullDomainSet,
}: UseCfExpiryOptions) {
  const { apiFetch } = useAppData();

  // CF zone 注册/到期时间：DNSHE 注册的取本地缓存，其余经后端 RDAP 查注册商（后端缓存 7 天）
  const [cfExpiryMap, setCfExpiryMap] = useState<Record<string, CfExpiryEntry>>(() => {
    try {
      const raw = localStorage.getItem(CF_EXPIRY_LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { map?: Record<string, CfExpiryEntry> };
        if (parsed && parsed.map && typeof parsed.map === "object") return parsed.map;
      }
    } catch {
      // 本地缓存损坏/不可解析时置空，重新向后端拉取
    }
    return {};
  });

  // 写入 cfExpiryMap（state + localStorage 兜底缓存同步落盘）
  //
  // NOTE: touchTs=false 表示本次并没有真的回源（没有待查域名）。此时必须保留原有 ts，
  // 否则每进一次 Cloudflare 页都会把 ts 刷成 now，6 小时的强制校验窗口永远到不了，
  // 一次查询失败留下的空条目就被永久钉死在「—」。
  const persistCfExpiryMap = (map: Record<string, CfExpiryEntry>, touchTs = true) => {
    setCfExpiryMap(map);
    try {
      let ts = Date.now();
      if (!touchTs) {
        const raw = localStorage.getItem(CF_EXPIRY_LS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { ts?: number };
          if (parsed && typeof parsed.ts === "number") ts = parsed.ts;
        }
      }
      localStorage.setItem(CF_EXPIRY_LS_KEY, JSON.stringify({ ts, map }));
    } catch {
      // 写入失败（如隐私模式配额）不影响本次展示
    }
  };

  // 拉取并合并 Cloudflare zone 注册/到期时间的两类服务端数据：
  //   1. GET /api/date-overrides —— 用户手动覆盖（随账号存后端，manual 条目以此为准重建，
  //      避免跨设备残留本地旧值；拉取失败时保留本地已有 manual 条目）
  //   2. GET /api/expiry —— RDAP/WHOIS 自动查询（后端 D1 缓存 7 天），永不回写 manual
  // 结果统一落本地兜底缓存（localStorage），刷新时先秒显旧值再后台校验。
  // force=true 表示本地结果已过期，忽略已存键强制回源（后端命中热缓存，仍很快）。
  const fetchCfExpiry = async (zoneList: Domain[], force = false) => {
    let next: Record<string, CfExpiryEntry> = { ...cfExpiryMap };

    // 1) 手动覆盖：以服务端为准重建 manual 条目
    try {
      const res = await apiFetch("/api/date-overrides");
      const data = await res.json();
      if (data.success && Array.isArray(data.overrides)) {
        for (const k of Object.keys(next)) {
          if (next[k]?.manual) delete next[k];
        }
        for (const row of data.overrides as Array<{ full_domain: string; registered_at?: string | null; expires_at?: string | null; source?: string | null }>) {
          const key = normalizeDomainKey(String(row.full_domain || ""));
          if (!key) continue;
          const prev = next[key];
          next[key] = {
            found: prev?.found ?? false,
            registered_at: row.registered_at || undefined,
            expires_at: row.expires_at || undefined,
            source: row.source || undefined,
            manual: true
          };
        }
      }
    } catch {
      // 手动覆盖拉取失败不打扰用户：保留本地已有 manual 条目，避免误清已录入数据
    }

    // 2) RDAP/WHOIS 自动查询：排除 manual 覆盖的域名；子域（非注册域）直接跳过不查。
    //    DNSHE 注册的域名也一并查询 —— 注册/到期时间仍优先走 DNSHE 上游（见 cfZoneDateInfo），
    //    但 RDAP 额外返回的 registrar（真实 TLD 注册商）正是 DNSHE 域名缺失的信息，需要补上。
    const targets = Array.from(
      new Set(
        zoneList
          .map((z) => normalizeDomainKey(String(z.full_domain || "")))
          .filter((k) => isRegistrableDomain(k))
      )
    ).filter((k) => {
      const prev = next[k];
      if (prev?.manual) return false;
      if (force || !(k in next)) return true;
      // 上次没查到的下次继续重试：否则后端一次抽风留下的空条目会永久卡在「—」
      return !prev.found;
    });

    let queried = false;
    if (targets.length > 0) {
      queried = true;
      // 后端回源失败的域名交给浏览器直查兜底（注册局拦的是 Worker 出口 IP，不是你的 IP）
      let needDirect: string[] = [];
      try {
        const res = await apiFetch(`/api/expiry?domains=${encodeURIComponent(targets.join(","))}`);
        const data = await res.json();
        if (data.success && data.expiry) {
          for (const [k, v] of Object.entries(data.expiry as Record<string, CfExpiryEntry>)) {
            if (next[k]?.manual) continue;
            if (v.found) {
              next[k] = v;
            } else if (v.error) {
              // 没查成（多为注册局 403 拦 CF 出口）：换浏览器再试一次。
              // 直查出结果前保留已有的好值，别先抹成空。
              needDirect.push(k);
              if (!next[k]?.found) next[k] = v;
            } else {
              // 注册局明确答「查无此记录」——这是有效结论，照常写入
              next[k] = v;
            }
          }
        } else {
          needDirect = targets.filter((k) => !next[k]?.manual);
        }
      } catch {
        // 后端整体不可达时，也给浏览器直查一次机会
        needDirect = targets.filter((k) => !next[k]?.manual);
      }

      if (needDirect.length > 0) {
        // 限个上限，避免域名特别多时对 rdap.org 瞬间打出太多请求；这次没轮到的
        // 下次进页面还会重试（targets 过滤已放行 found=false 的条目）
        const direct = await Promise.all(
          needDirect.slice(0, 25).map(async (k) => ({ k, entry: await fetchExpiryDirect(k) }))
        );
        for (const { k, entry } of direct) {
          if (entry && !next[k]?.manual) next[k] = entry;
        }
      }
    }

    persistCfExpiryMap(next, queried);
  };

  // 进入 Cloudflare 页或 zones 更新时：同步服务端手动覆盖 + 拉取到期时间。
  // 本地缓存新鲜（fresh 窗口内）时只查新增域名；过期则全量回源校验（后端 D1 热缓存 + 并行读）。
  useEffect(() => {
    if (activeTab !== "cloudflare" || cfZones.length === 0) return;
    let stale = true;
    try {
      const raw = localStorage.getItem(CF_EXPIRY_LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { ts?: number };
        stale = !parsed.ts || Date.now() - parsed.ts > CF_EXPIRY_FRESH_MS;
      }
    } catch {
      stale = true;
    }
    void fetchCfExpiry(cfZones, stale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, cfZones]);

  // 单个 CF zone 注册日期信息的统一推导（卡片渲染与编辑弹窗共用）：
  // 手动覆盖值优先，其次 DNSHE/DigitalPlat 上游缓存，最后 RDAP 查询结果（查不到显示 —）。
  // manual 只覆盖「用户实际填写」的字段，空字段自动回落上游/RDAP，避免误锁自动值。
  // 注意：DNSHE/DigitalPlat 的「永久」占位值（0000-00-00）是有意义的语义 —— 上游明确
  // 标注该域名为永久，CF 侧应透传这个语义（formatDate 遇 0000 显示「永久」）。
  // 同时：DNSHE 命中的域名在 fetchCfExpiry 里已被排除查 RDAP，所以一旦命中且上游
  // expires_at 为空串（DNSHE 对部分域名不返回到期时间），也要显示「永久」，
  // 而不是落到「—」，否则两边对永久域名的展示不一致。
  const cfZoneDateInfo = (zone: Domain) => {
    const zoneKeys = domainKeyCandidates(String(zone.full_domain || ""));
    const isDnsheRegistered = zoneKeys.some((k) => dnsheFullDomainSet.has(k));
    const isDpRegistered = zoneKeys.some((k) => dpDomainFullDomainSet.has(k));
    const dnsheMatch = isDnsheRegistered
      ? domains.find((d) => domainKeyCandidates(String(d.full_domain || "")).some((k) => zoneKeys.includes(k)))
      : undefined;
    const dpMatch = isDpRegistered
      ? dpDomains.find((d) => domainKeyCandidates(String(d.full_domain || "")).some((k) => zoneKeys.includes(k)))
      : undefined;
    const key = normalizeDomainKey(String(zone.full_domain || ""));
    // RDAP 结果按注册域（即完整域名本身，子域已被过滤不查）存，直接按完整域名取 key。
    const entry = cfExpiryMap[key];
    const manualEntry = entry?.manual ? entry : undefined;
    // DNSHE 命中：透传上游语义（空值用 0000 占位 → formatDate 显示「永久」）。
    // DNSHE 未命中：DP 优先，其次 RDAP。
    const dnsheExpiryStr = dnsheMatch?.expires_at;
    const autoExpiryRaw = isDnsheRegistered
      ? (dnsheExpiryStr || "0000-00-00 00:00:00")
      : (dpMatch?.expires_at || entry?.expires_at);
    const dnsheRegisteredStr = dnsheMatch?.created_at;
    const autoRegisteredRaw = isDnsheRegistered
      ? (dnsheRegisteredStr || "0000-00-00 00:00:00")
      : (dpMatch?.created_at || entry?.registered_at);
    const registeredRaw = manualEntry?.registered_at || autoRegisteredRaw;
    // 到期：存过手动值但到期留空 → 用户主动标记「永久」（0000 占位，formatDate 显示「永久」），
    // 与「没有任何手动覆盖、RDAP 也查不到」时的「—」区分开。无手动覆盖则沿用自动查询值。
    const expiryRaw = manualEntry
      ? (manualEntry.expires_at || "0000-00-00")
      : autoExpiryRaw;
    // 注册商：手动来源优先，其次 RDAP 自动查到的 registrar
    const registrar = manualEntry?.source || entry?.registrar;
    return {
      isDnsheRegistered,
      isDpRegistered,
      dnsheMatch,
      dpMatch,
      key,
      entry,
      manualEntry,
      autoRegisteredRaw,
      autoExpiryRaw,
      registeredRaw,
      expiryRaw,
      registrar,
      registeredText: registeredRaw ? formatDate(registeredRaw, false) : "—",
      expiryText: expiryRaw ? formatDate(expiryRaw, true) : "—"
    };
  };

  return { cfExpiryMap, setCfExpiryMap, persistCfExpiryMap, fetchCfExpiry, cfZoneDateInfo };
}
