import type { Hono } from "hono";
import type { AppEnv } from "./types";
import { ValidationError } from "../errors";
import { successRes } from "./response";

/** Authenticated operational view. No payload, destination URL, or credential is exposed. */
export function registerNotificationRoutes(app: Hono<AppEnv>) {
  app.get("/api/notifications", async c => {
    const status = c.req.query("status"), limit = Number(c.req.query("limit") || 50);
    if (status && !["queued", "running", "sent", "dead", "cancelled"].includes(status)) throw new ValidationError("通知状态无效");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ValidationError("通知列表 limit 必须为 1–100");
    const outbox = c.get("db").notificationOutbox();
    return c.json(successRes({ notifications: await outbox.list(status, limit), counts: await outbox.counts() }));
  });
  for (const operation of ["retry", "cancel"] as const) {
    app.post(`/api/notifications/:id/${operation}`, async c => {
      const id = c.req.param("id");
      if (!/^[a-f0-9]{64}$/.test(id)) throw new ValidationError("通知 ID 无效");
      const body: unknown = operation === "retry" ? await c.req.json().catch(() => null) : null;
      const acknowledged = !!body && typeof body === "object" && "acknowledge_duplicate_risk" in body &&
        body.acknowledge_duplicate_risk === true;
      await c.get("db").notificationOutbox().control(id, operation, acknowledged);
      return c.json(successRes({ message: operation === "retry" ? "通知已重新排队（沿用原加密目标快照）" : "通知已取消；已在途的网络请求无法撤回" }));
    });
  }
}
