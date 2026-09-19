import type { Hono } from "hono";
import type { AppEnv } from "./types";
import { successRes } from "./response";
import { AuditRepository } from "../repositories/audit-repository";
import { AuditService } from "../services/audit-service";

export function registerAuditRoutes(app: Hono<AppEnv>) {
  app.get("/api/audit", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") || 100), 1), 500);
    const rows = await new AuditService(new AuditRepository(c.get("db"))).list(limit);
    return c.json(successRes({ audit: rows }));
  });
}
