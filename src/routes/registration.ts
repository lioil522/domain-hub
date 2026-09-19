import type { Hono } from "hono";
import type { AppEnv } from "./types";
import { DatabaseManager, QUOTA_CACHE_KEY } from "../db";
import { successRes, errorRes } from "./response";
import { RegistrationService } from "../services/registration-service";

export interface RegistrationRouteDeps {
  fetchAllQuotas: (db: DatabaseManager) => Promise<{ accounts: Array<{ id: number; alias: string }>; quotas: unknown[] }>;
  logService: (db: DatabaseManager) => { write: (level: string, source: string, message: string, meta?: unknown) => Promise<unknown> };
  cacheNewlyRegisteredDomain: (db: DatabaseManager, accountId: number, subdomainId: number, fullDomain: string) => Promise<unknown>;
}

export function registerRegistrationRoutes(app: Hono<AppEnv>, deps: RegistrationRouteDeps) {
  app.post("/api/domains/register", async (c) => {
    const db = c.get("db");
    try {
      const body = await c.req.json().catch(() => ({}));
      const accountId = Number(body?.account_id);
      const subdomain = String(body?.subdomain || "").trim();
      const rootdomain = String(body?.rootdomain || "").trim();
      if (!accountId || !subdomain || !rootdomain) return c.json(errorRes("必须提供 account_id, subdomain 及 rootdomain", "bad_request"), 400);

      const result = await new RegistrationService(db).register(accountId, subdomain, rootdomain);
      await deps.logService(db).write("success", "api", `成功在账号 [ID: ${accountId}] 下注册了免费域名: [${result.full_domain}]`);
      try {
        const { accounts, quotas } = await deps.fetchAllQuotas(db);
        if (accounts.length > 0) await db.setCache(QUOTA_CACHE_KEY, JSON.stringify(quotas));
      } catch (e) {
        console.error("注册后刷新配额缓存失败:", e);
      }
      try {
        await deps.cacheNewlyRegisteredDomain(db, accountId, result.subdomain_id, result.full_domain);
      } catch (e) {
        console.error("注册后同步错误:", e);
      }
      return c.json(successRes({ message: `域名 [${result.full_domain}] 注册成功！`, subdomain_id: result.subdomain_id, full_domain: result.full_domain }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "注册子域名发生错误"), 400);
    }
  });
}
