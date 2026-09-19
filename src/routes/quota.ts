import type { Hono } from "hono";
import type { AppEnv } from "./types";
import { successRes, errorRes } from "./response";
import { QUOTA_CACHE_KEY } from "../db";
import { LogService } from "../services/log-service";
import { LogRepository } from "../repositories/log-repository";

interface QuotaDeps {
  fetchAllQuotas: (db: AppEnv["Variables"]["db"]) => Promise<{ accounts: unknown[]; quotas: unknown[] }>;
}

export function registerQuotaRoutes(app: Hono<AppEnv>, deps: QuotaDeps) {
  app.get("/api/quota", async (c) => {
    const db = c.get("db");
    const forceRefresh = c.req.query("refresh") === "1";
    try {
      if (!forceRefresh) {
        const cached = await db.getCache(QUOTA_CACHE_KEY);
        if (cached) return c.json(successRes({ quotas: JSON.parse(cached) }));
      }
      const { accounts, quotas } = await deps.fetchAllQuotas(db);
      if (accounts.length > 0) {
        await new LogService(new LogRepository(db)).write("success", "api", `查询了 ${accounts.length} 个账号的账户配额`);
        await db.setCache(QUOTA_CACHE_KEY, JSON.stringify(quotas));
      }
      return c.json(successRes({ quotas }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 500);
    }
  });
}
