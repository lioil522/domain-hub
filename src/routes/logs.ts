import type { Hono } from "hono";
import type { AppEnv } from "./types";
import { successRes, errorRes } from "./response";
import { LogService } from "../services/log-service";
import { LogRepository } from "../repositories/log-repository";
import { AppError } from "../errors";

export function registerLogRoutes(app: Hono<AppEnv>) {
  app.get("/api/logs", async (c) => {
    const db = c.get("db");
    const cursor = c.req.query("after_id");
    const afterId = cursor === undefined ? undefined : Number(cursor);
    if (cursor !== undefined && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(afterId) || afterId! < 0)) throw new AppError("日志游标无效", 400, "bad_request");
    try {
      const logs = await new LogService(new LogRepository(db)).list(100, undefined, afterId);
      return c.json(successRes({ logs, nextCursor: Math.max(afterId ?? 0, ...logs.map(log => log.id)) }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 500);
    }
  });

  app.post("/api/logs/clear", async (c) => {
    const db = c.get("db");
    try {
      await new LogService(new LogRepository(db)).clear();
      return c.json(successRes({ message: "日志已清空" }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 500);
    }
  });
}
