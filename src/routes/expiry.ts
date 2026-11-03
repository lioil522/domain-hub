import type { Hono } from "hono";
import type { AppEnv } from "./types";
import { DatabaseManager } from "../db";
import { toASCII, isRegistrableDomain } from "../punycode";
import { successRes, errorRes } from "./response";
import { RDAP_CACHE_PREFIX } from "../db";

/**
 * RDAP 查询域名在注册商侧的到期时间
 *
 * NOTE: Cloudflare 的 zone 对象没有到期字段（有效期登记在注册商处）。rdap.org 是
 * IANA 的公共 RDAP 重定向入口，按 TLD 302 到对应注册局的 RDAP 服务，无需任何凭据。
 * 结果写入 D1 缓存 7 天：到期时间以年为单位变化，没有更细粒度拉取的意义；
 * 查不到（404，常见于 zone 是别人根域的子域）同样落缓存避免反复打上游；
 * 查询失败（结果带 error 字段）不落缓存、下次重试；键前缀带版本号，改判读逻辑时
 * 换号即可让旧版本留下的脏缓存整批失效（早期版本曾把 403 等失败结果也写进缓存）。
 */
const RDAP_CACHE_KEY_PREFIX = RDAP_CACHE_PREFIX;
const RDAP_CACHE_TTL = 7 * 24 * 3600;

// 常见的「多段公共后缀」（public suffix）。RDAP 注册局只登记「注册域」，二级/三级子域
// （foo.example.com）在注册局 RDAP 里查不到（404）。子域直接不查（跳过），避免把注册域
// 的日期错误套到子域上；命中下表则注册域 = 最后三段（如 a.b.co.uk → b.co.uk），
// 否则注册域 = 最后两段（a.com）。表只覆盖最常见二级公共后缀，无需引入完整 PSL 依赖。
//
// NOTE: 该表与 isRegistrableDomain 的判定实现同属一体，已一起挪到 punycode.ts。

/**
 * 判断是否为「注册域」（而非子域）。非注册域返回 false，RDAP 查询直接跳过。
 *
 * NOTE: 实现已挪到零依赖的 punycode.ts —— cron.ts（定时任务的 CF 到期提醒）也要用它，
 * 若从 index.ts 导入会形成 index → cron → index 的循环依赖。这里原样转出，
 * 保持既有调用点与外部导入路径不变。
 */

// rdap.org 与各注册局 RDAP 服务（Verisign 等）会拒绝不带浏览器 UA 的请求（403），
// 而 Cloudflare Worker / Node 的 fetch 默认不发 UA。用这个 UA 伪装浏览器才能拿到数据。
// 实测裸 UA 或纯应用名都会被 403 / 连接失败，Mozilla/5.0 前缀开头即可放行。
const RDAP_USER_AGENT = "Mozilla/5.0 (compatible; Domain-Hub/1.0)";

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}

interface RdapExpiryResult {
  found: boolean;
  expires_at?: string;
  registered_at?: string;
  /** 注册商（registrar）名称，来自 RDAP entities 里 roles 含 registrar 的实体 */
  registrar?: string;
  /** 结论来源：rdap = 注册局 RDAP；stackryze = Stackryze 免费域名 WHOIS（仅五个自有后缀） */
  source?: "rdap" | "stackryze";
  error?: string;
}

async function fetchExpiryViaRdap(domain: string): Promise<RdapExpiryResult> {
  const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
    headers: { accept: "application/rdap+json", "user-agent": RDAP_USER_AGENT }
  });
  // 404 = 该名字不是可注册域名（多为子域 zone）或注册局无此记录
  if (res.status === 404) {
    return { found: false, source: "rdap" };
  }
  if (!res.ok) {
    throw new Error(`RDAP HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    events?: RdapEvent[];
    entities?: Array<{
      roles?: string[];
      handle?: string;
      vcardArray?: [string, unknown[]];
    }>;
  };
  const eventDate = (action: string) =>
    (data.events || []).find((e) => e.eventAction === action)?.eventDate || "";
  // 提取注册商：entities 里 roles 含 registrar 的实体，取 vcardArray 的 fn（或 handle 兜底）
  let registrar: string | undefined;
  const registrarEntity = (data.entities || []).find(
    (e) => Array.isArray(e.roles) && e.roles.some((r) => String(r).toLowerCase() === "registrar")
  );
  if (registrarEntity) {
    // vcardArray 形如 ["vcard", [["fn", {}, "text", "Namecheap, Inc."], ...]]
    const vcard = registrarEntity.vcardArray;
    if (Array.isArray(vcard) && Array.isArray(vcard[1])) {
      const fnRow = vcard[1].find(
        (row) => Array.isArray(row) && String(row[0]).toLowerCase() === "fn"
      );
      if (Array.isArray(fnRow) && fnRow[3]) {
        registrar = String(fnRow[3]).trim();
      }
    }
    if (!registrar) registrar = registrarEntity.handle || undefined;
  }
  return {
    found: true,
    expires_at: eventDate("expiration") || undefined,
    registered_at: eventDate("registration") || undefined,
    registrar,
    source: "rdap"
  };
}

/**
 * Stackryze 免费域名 WHOIS —— 仅用于注册/到期时间补查，不做可注册性判定（查重）
 *
 * NOTE: Stackryze 的免费三级域名（*.indevs.in 等）在注册局 RDAP 里查不到，
 * CF zone 卡片的到期时间会一直显示「—」。这个公开接口无需登录也无人机验证
 * （质询只挡在 domain.stackryze.com 网页上），返回 expiresAt/createdAt 字段，
 * 恰好补上这五个后缀的注册/到期信息。判定语义：200 = 已注册；404 = 未注册；
 * 400 = 后缀不支持。失败一律降级为错误结果，绝不误判为「查到了」。
 */
const STACKRYZE_WHOIS_ENDPOINT = "https://api-domains.stackryze.com/subdomains/whois";
const STACKRYZE_SUFFIXES = [".indevs.in", ".sryze.cc", ".ryzedns.org", ".nx.kg", ".ryzn.pro"];

function isStackryzeDomain(domain: string): boolean {
  return STACKRYZE_SUFFIXES.some((suffix) => domain.endsWith(suffix));
}

async function fetchExpiryViaStackryze(domain: string): Promise<RdapExpiryResult> {
  const res = await fetch(`${STACKRYZE_WHOIS_ENDPOINT}?query=${encodeURIComponent(domain)}`, {
    headers: { accept: "application/json", "user-agent": RDAP_USER_AGENT }
  });
  if (res.status === 404) {
    return { found: false, source: "stackryze" };
  }
  if (!res.ok) {
    throw new Error(`Stackryze WHOIS HTTP ${res.status}`);
  }
  const data = (await res.json()) as { expiresAt?: string; createdAt?: string };
  return {
    found: true,
    expires_at: data.expiresAt || undefined,
    registered_at: data.createdAt || undefined,
    source: "stackryze"
  };
}

/**
 * 到期时间查询总入口：先走 RDAP（权威、覆盖所有正式 TLD），
 * 查不到且域名属于 Stackryze 免费后缀时，用其 WHOIS 接口补查注册/到期时间。
 */
async function lookupDomainExpiry(domain: string): Promise<RdapExpiryResult> {
  let rdapFailed: string | undefined;
  try {
    const rdap = await fetchExpiryViaRdap(domain);
    if (rdap.found) return rdap;
  } catch (err) {
    // RDAP 失败不直接返回错误：Stackryze 后缀还有兜底查询的机会
    rdapFailed = err instanceof Error ? err.message : "RDAP 查询失败";
  }
  if (isStackryzeDomain(domain)) {
    try {
      return await fetchExpiryViaStackryze(domain);
    } catch (err) {
      const stackryzeError = err instanceof Error ? err.message : "Stackryze 查询失败";
      return { found: false, source: "stackryze", error: rdapFailed ? `${rdapFailed}; ${stackryzeError}` : stackryzeError };
    }
  }
  return rdapFailed
    ? { found: false, error: rdapFailed }
    : { found: false, source: "rdap" };
}

// GET /api/expiry?domains=a.com,b.com — 批量查询域名注册商侧到期时间（RDAP，7 天缓存）

export interface ExpiryRouteDeps {}

export function registerExpiryRoutes(app: Hono<AppEnv>, _deps: ExpiryRouteDeps) {
app.get("/api/expiry", async (c) => {
  const dbManager = c.get("db");
  // 查询前过滤掉非注册域（子域）：RDAP 注册局只登记注册域，子域查不到也白查，
  // 直接跳过（前端对子域显示 —，日期由用户在编辑弹窗手动补）。
  const domains = Array.from(
    new Set(
      (c.req.query("domains") || "")
        .split(",")
        .map((d) => toASCII(String(d || "").trim().toLowerCase()))
        .filter((d) => isRegistrableDomain(d))
    )
  ).slice(0, 50);

  if (domains.length === 0) {
    return c.json(successRes({ expiry: {} }));
  }

  const expiry: Record<string, RdapExpiryResult> = {};
  const toQuery: string[] = [];

  // 1. 先命中 D1 缓存（历史版本前缀 rdap: 下的脏缓存统一不认，随 TTL 自然过期）。
  //    并发读：热缓存命中时，串行逐个 await 会让每个域名都付一次 D1 往返，
  //    几十个域名叠加就是好几秒——这是刷新慢的最大来源。
  const cachedRows = await Promise.all(
    domains.map(async (d) => ({ d, cached: await dbManager.getCache(`${RDAP_CACHE_KEY_PREFIX}${d}`) }))
  );
  for (const { d, cached } of cachedRows) {
    if (cached) {
      try {
        expiry[d] = JSON.parse(cached) as RdapExpiryResult;
        continue;
      } catch {
        // 缓存脏了按未命中处理
      }
    }
    toQuery.push(d);
  }

  // 2. 未命中的并发回源（RDAP 按注册局分散，Stackryze 后缀在 RDAP 查不到时走其 WHOIS 补查）。
  //    只缓存成功结论（含正常的 404 未查到）；带 error 的失败结果不落缓存，下次请求重试。
  const settled = await Promise.allSettled(
    toQuery.map((d) =>
      lookupDomainExpiry(d)
        .then(async (result) => {
          if (!result.error) {
            await dbManager.setCache(`${RDAP_CACHE_KEY_PREFIX}${d}`, JSON.stringify(result), RDAP_CACHE_TTL);
          }
          return { d, result };
        })
        .catch((err: unknown) => ({
          d,
          result: {
            found: false,
            error: err instanceof Error ? err.message : "查询失败"
          } as RdapExpiryResult
        }))
    )
  );
  for (const item of settled) {
    if (item.status === "fulfilled") {
      expiry[item.value.d] = item.value.result;
    }
  }

  return c.json(successRes({ expiry }));
});

}
