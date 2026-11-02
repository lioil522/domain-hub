import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./types";
import { successRes, errorRes } from "./response";
import { AppError } from "../errors";
import { syncPlan, syncStep } from "../services/sliced-sync-service";
import { maintainSyncHistory } from "../services/sync-history-service";

export function registerSyncRoutes(app: Hono<AppEnv>) {
  app.post("/api/sync/history/maintenance", bodyLimit({ maxSize: 1024,
    onError: c => c.json(errorRes("历史维护请求过大", "bad_request"), 413) }), async c => {
    const body: unknown = await c.req.json().catch(() => { throw new AppError("历史维护请求必须为JSON对象", 400, "bad_request"); });
    return c.json(successRes(await maintainSyncHistory(c.get("db"), body)));
  });
  app.post("/api/sync/plan", async c => {
    const body = await c.req.json().catch(() => ({}));
    if (body.after !== undefined && (!Number.isSafeInteger(body.after) || body.after < 0) || body.accountIds !== undefined && (!Array.isArray(body.accountIds) || body.accountIds.length > 50 || body.accountIds.some((v: unknown) => !Number.isSafeInteger(v) || Number(v) < 1))) throw new AppError("计划参数无效", 400, "bad_request");
    return c.json(successRes(await syncPlan(c.get("db"), { manual: body.manual === true, provider: body.provider, after: body.after, accountIds: body.accountIds })));
  });
  app.post("/api/accounts/:id/sync-step", async c => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id < 1) throw new AppError("账号 ID 无效", 400, "bad_request");
    const body = await c.req.json().catch(() => ({}));
    return c.json(successRes(await syncStep(c.get("db"), id, { manual: body.manual === true, taskId: body.taskId })));
  });
}
