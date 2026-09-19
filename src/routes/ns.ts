import type { Hono } from "hono";
import type { AppEnv } from "./types";
import { DatabaseManager } from "../db";
import { toASCII, isRegistrableDomain } from "../punycode";
import { successRes, errorRes } from "./response";
import { RDAP_CACHE_PREFIX } from "../db";

/**
 * 8.6 查询根域名的 NS 记录（DoH 代理 + D1 缓存）
 *
 * 用途：判断「该根域下的子域名是否支持按线路（运营商/地域）解析」。上游 API 没有
 * 任何线路能力字段，但根域的 NS 记录暴露了它实际托管在谁家 DNS 上 —— 挂阿里云
 * (vip*.alidns.com) 的支持线路，挂 DNSHE 自建 NS (*.ns/nic.dnshe.org) 的不支持。
 * 前端据此对照一份可编辑的 NS 后缀名单做判定（见 DNSHE_LINE_NS_SUFFIXES）。
 *
 * NOTE: 放在后端而不是前端直连 DoH，有三个理由：结论可进 D1 让所有设备共享；
 * 不依赖用户本地网络能否访问 DoH 域名（大陆网络常被干扰）；与本项目「出站一律
 * 走 Worker，结果落 D1 缓存」的既有模型一致。
 */

/**
 * 公共 DoH 解析器（JSON API），按顺序尝试；三家返回同一 JSON 形状
 *
 * NOTE: 前两家在 Cloudflare 上必通，但自建（Docker）版跑在用户自己的网络里，
 * 大陆环境下 cloudflare-dns.com 与 dns.google 基本不可用，因此补一个国内可达的
 * 兜底解析器。顺序不变 —— Worker 上第一家就命中，第三家永远不会被访问到。
 */
const DOH_ENDPOINTS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
  "https://dns.alidns.com/resolve"
];

/**
 * 单次 DoH 查询超时
 *
 * NOTE: 被墙的解析器多数表现为「连上不回包」而不是立刻拒绝，没有超时的话
 * 请求会一直挂着、根本走不到下一家。结论会缓存 30 天，这点等待只付一次。
 */
const DOH_TIMEOUT_MS = 5000;

/** NS 结论缓存 30 天 —— NS 极少变动，但仍给一个到期时间以便厂商换 DNS 后能自愈 */
const NS_CACHE_TTL = 30 * 24 * 3600;

/** 单次请求最多查询的根域数（每个最坏 2 次子请求，Workers 单请求 50 subrequest 上限） */
const NS_MAX_ROOTS = 20;

/** DoH JSON 响应（RFC 8427 风格，Cloudflare / Google 通用） */
interface DohResponse {
  Status?: number;
  Answer?: Array<{ name?: string; type?: number; data?: string }>;
  Authority?: Array<{ name?: string; type?: number; data?: string }>;
}

/**
 * 向公共 DoH 查询单个域名的 NS 记录
 *
 * @returns NS 主机名数组（已去尾点/转小写/去重/排序）；查询失败或无 NS 时返回 null，
 *          调用方据此区分「不支持线路」与「未知」——后者不写缓存，下次再试。
 */
async function resolveNsViaDoh(name: string): Promise<string[] | null> {
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const res = await fetch(`${endpoint}?name=${encodeURIComponent(name)}&type=NS`, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(DOH_TIMEOUT_MS)
      });
      if (!res.ok) continue;

      const data = (await res.json()) as DohResponse;
      // NOTE: 权威区自己应答时 NS 在 Answer；若该名字是从父区委派下来的，
      //       记录会出现在 Authority 段，两处都要看。type 2 = NS。
      const sections = [data.Answer, data.Authority];
      for (const section of sections) {
        const hosts = (section || [])
          .filter((r) => r.type === 2 && r.data)
          .map((r) => String(r.data).trim().toLowerCase().replace(/\.$/, ""))
          .filter(Boolean);
        if (hosts.length > 0) {
          return Array.from(new Set(hosts)).sort();
        }
      }
      // 该解析器答成功但没给 NS（NXDOMAIN 等），换下一家没有意义
      if (data.Status === 0 || data.Status === 3) return null;
    } catch (e: unknown) {
      // NOTE: 自建版在大陆网络下前两家必然失败（重置或超时），是预期路径而非故障。
      // 这里只记一行原因，不打整个堆栈，否则 docker compose logs 会被刷得没法看。
      const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error(`DoH NS 查询失败 [${endpoint}] [${name}]: ${reason}`);
    }
  }
  return null;
}


export interface NsRouteDeps {
  logService: (db: DatabaseManager) => { write: (level: string, source: string, message: string, meta?: unknown) => Promise<unknown> };
}

export function registerNsRoutes(app: Hono<AppEnv>, deps: NsRouteDeps) {
app.get("/api/dns/ns", async (c) => {
  const dbManager = c.get("db");
  const rootsParam = c.req.query("roots");
  const forceRefresh = c.req.query("refresh") === "1";

  if (!rootsParam) {
    return c.json(errorRes("必须提供 roots 参数（逗号分隔的根域名）", "bad_request"), 400);
  }

  // DNSHE 根域 NS 结论只用于 DNSHE 线路支持判定。未添加 DNSHE 账号时，提前查询
  // 没有业务收益；尤其在大陆网络环境中会触发公共 DoH 的无意义超时/重试。
  const dnsheAccounts = await dbManager.getAccounts("dnshe");
  if (dnsheAccounts.length === 0) {
    return c.json(successRes({ ns: {} }));
  }

  // 去重后截断到上限：超出部分静默丢弃，前端本来就分批请求
  const roots = Array.from(
    new Set(
      rootsParam
        .split(",")
        .map((r) => toASCII(String(r || "").trim().toLowerCase()))
        .filter(Boolean)
    )
  ).slice(0, NS_MAX_ROOTS);

  if (roots.length === 0) {
    return c.json(successRes({ ns: {} }));
  }

  const ns: Record<string, string[] | null> = {};
  let queried = 0;
  let failed = 0;

  await Promise.all(
    roots.map(async (root) => {
      const cacheKey = `ns:${root}`;
      if (!forceRefresh) {
        const cached = await dbManager.getCache(cacheKey);
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed) && parsed.length > 0) {
              ns[root] = parsed.map((h: unknown) => String(h));
              return;
            }
          } catch (e) {
            // 缓存脏了当未命中处理，下面回源覆盖
          }
        }
      }

      queried++;
      const hosts = await resolveNsViaDoh(root);
      ns[root] = hosts;
      if (hosts && hosts.length > 0) {
        // 只缓存有效结论：查询失败不落库，避免把一次网络抖动固化成 30 天的「未知」
        await dbManager.setCache(cacheKey, JSON.stringify(hosts), NS_CACHE_TTL);
      } else {
        failed++;
      }
    })
  );

  // 回源的全军覆没才值得留痕（通常是 Worker 出站被墙或两家 DoH 同时故障）；
  // 个别根域查不到只体现在响应里，不刷日志。
  if (queried > 0 && failed === queried) {
    await deps.logService(dbManager).write(
      "warning",
      "system",
      `根域 NS 查询全部失败（${queried} 个），线路支持判定将回退到 provider_account_id`,
      { roots, endpoints: DOH_ENDPOINTS }
    );
  }

  return c.json(successRes({ ns }));
});

}
