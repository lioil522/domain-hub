import type { Hono, Context } from "hono";
import type { AppEnv } from "./types";
import { DatabaseManager } from "../db";
import { toASCII, isRegistrableDomain } from "../punycode";
import { successRes, errorRes } from "./response";
import { WhoisService } from "../services/whois-service";
import type { Bindings, Variables } from "./types";

export interface WhoisRouteDeps {
  logService: (db: DatabaseManager) => { write: (level: string, source: string, message: string, meta?: unknown) => Promise<unknown> };
}

export function registerWhoisRoutes(app: Hono<AppEnv>, deps: WhoisRouteDeps) {
/**
 * 8. WHOIS 查询域名可注册性 (代理接口)
 */
app.get("/api/whois", async (c) => {
  const domain = c.req.query("domain");
  const accountIdParam = c.req.query("account_id");
  if (!domain) {
    return c.json(errorRes("必须提供完整的域名参数 (例如 test.us.ci)", "bad_request"), 400);
  }

  const dbManager = c.get("db");
  try {
    const accountId = accountIdParam ? Number(accountIdParam) : undefined;
    const asciiDomain = toASCII(domain.trim());
    const res = await new WhoisService(dbManager).query(asciiDomain, accountId);

    // 查重池回填：确认已注册的域名写入池子（7 天 TTL），供后续批量扫描直接跳过
    if (res && res.registered === true) {
      await dbManager.addToWhoisPool(asciiDomain);
    }

    // 批量扫描（batch=1）单轮可达数万次查询，逐条写日志会让 logs 表爆炸式增长
    // 并拖慢整库，这里按 1/50 采样；单次手动查询仍然全量记录。
    const isBatch = c.req.query("batch") === "1";
    if (!isBatch) {
      await deps.logService(dbManager).write("success", "api", `WHOIS 查询域名 [${asciiDomain}]`);
    } else if (Math.random() < 0.02) {
      await deps.logService(dbManager).write("info", "api", `批量查重采样：WHOIS 查询域名 [${asciiDomain}]（每 50 次采样记录 1 条）`);
    }
    return c.json(successRes({ whois: res }));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "WHOIS 查询异常";
    return c.json(errorRes(message), 400);
  }
});

/**
 * 8.5 批量查询查重池 —— 返回其中已确认「已注册」且未过期的域名
 *
 * 供前端批量扫描在发起 WHOIS 前先行过滤，避免重复消耗上游 API 配额。
 *
 * 提供 POST（推荐，域名走请求体，不受 URL 长度限制）与 GET（兼容旧前端）两种入口。
 * 入参域名非 ASCII 会统一转 Punycode 后匹配。
 */
async function queryWhoisPool(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  rawDomains: string[]
) {
  const dbManager = c.get("db");
  try {
    const domains = rawDomains
      .map(d => toASCII(String(d || "").trim()))
      .filter(Boolean);

    if (domains.length === 0) {
      return c.json(successRes({ registered: [] }));
    }
    // 单次查询上限（服务端内部会再按语句长度自动分批）
    if (domains.length > 500) {
      return c.json(errorRes("单次最多查询 500 个域名", "bad_request"), 400);
    }

    const registered = await dbManager.getWhoisPool(domains);
    return c.json(successRes({ registered }));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "查重池查询异常";
    return c.json(errorRes(message), 400);
  }
}

app.post("/api/whois/pool", async (c) => {
  let body: { domains?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(errorRes("请求体必须为 JSON", "bad_request"), 400);
  }
  if (!Array.isArray(body.domains)) {
    return c.json(errorRes("必须提供 domains 数组", "bad_request"), 400);
  }
  return queryWhoisPool(c, body.domains as string[]);
});

app.get("/api/whois/pool", async (c) => {
  const domainsParam = c.req.query("domains");
  if (!domainsParam) {
    return c.json(errorRes("必须提供 domains 参数（逗号分隔）", "bad_request"), 400);
  }
  return queryWhoisPool(c, domainsParam.split(","));
});

}
