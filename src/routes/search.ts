import type { Hono } from "hono";
import type { AppEnv } from "./types";
import { errorRes, successRes } from "./response";
import { SearchService } from "../services/search-service";
import { AppError } from "../errors";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function registerSearchRoutes(app: Hono<AppEnv>) {
  app.get("/api/search", async (c) => {
    const q = String(c.req.query("q") || "").trim();
    c.header("Cache-Control", "private, no-store");
    if (!q) return c.json(successRes({ results: [] }));
    const limit = c.req.query("limit") === undefined ? 20 : Number(c.req.query("limit"));
    try {
      const results = await new SearchService(c.get("db")).search(q, limit);
      return c.json(successRes({ results, dns_scope: "valid_cached_records" }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof AppError ? e.message : "搜索失败，请稍后重试", e instanceof AppError ? e.code : "internal_error"),
        (e instanceof AppError ? e.statusCode : 500) as ContentfulStatusCode);
    }
  });
}
