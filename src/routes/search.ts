import type { Hono } from "hono";
import type { AppEnv } from "./types";
import { errorRes, successRes } from "./response";
import { SearchService } from "../services/search-service";

export function registerSearchRoutes(app: Hono<AppEnv>) {
  app.get("/api/search", async (c) => {
    const q = String(c.req.query("q") || "").trim();
    if (!q) return c.json(successRes({ results: [] }));
    const limit = Math.min(Math.max(Number(c.req.query("limit") || 20), 1), 100);
    try {
      const results = await new SearchService(c.get("db")).search(q, limit);
      return c.json(successRes({ results }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "搜索失败"), 500);
    }
  });
}
