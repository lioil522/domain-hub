import type { Hono } from "hono";
import type { AppEnv } from "./types";
import { successRes, errorRes } from "./response";
import { LogService } from "../services/log-service";
import { LogRepository } from "../repositories/log-repository";

export function registerLogRoutes(app: Hono<AppEnv>) {
  app.get("/api/logs", async (c) => {
    const db = c.get("db");
    try {
      const logs = await new LogService(new LogRepository(db)).list(100);
      return c.json(successRes({ logs }));
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
