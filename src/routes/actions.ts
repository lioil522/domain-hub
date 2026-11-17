import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "./types";
import { errorRes, successRes } from "./response";
import { ActionRepository } from "../repositories/action-repository";
import { ActionService } from "../services/action-service";
import { isActionStatus, isActionType } from "../actions/action-types";
import { enqueueSyncAction, kickSyncWork } from "../services/sync-dispatch";
import { AppError, ConflictError, ValidationError } from "../errors";

const service = (db: AppEnv["Variables"]["db"]) => new ActionService(new ActionRepository(db));
const fail = (c: Context<AppEnv>, error: unknown) => c.json(
  errorRes(error instanceof Error ? error.message : "任务操作失败", error instanceof AppError ? error.code : "internal_error"),
  (error instanceof AppError ? error.statusCode : 500) as ContentfulStatusCode,
);
async function body(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const value: unknown = await c.req.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("请求体不是有效 JSON 对象");
  return value as Record<string, unknown>;
}
const kick = (c: Context<AppEnv>) => kickSyncWork(c.get("db"), task => c.executionCtx.waitUntil(task), c.env);
async function unmanaged(c: Context<AppEnv>) {
  const action = await service(c.get("db")).get(c.req.param("id") || "");
  if (action?.type === "sync") throw new ConflictError("同步状态由执行器管理，请使用暂停、重试或取消接口", "managed_action");
}

export function registerActionRoutes(app: Hono<AppEnv>) {
  app.get("/api/actions", async c => {
    await c.get("db").syncQueue().recover();
    const limit = Math.min(Math.max(Number(c.req.query("limit") || 50), 1), 200);
    const actions = await service(c.get("db")).list(limit);
    if (actions.some(action => action.type === "sync" && ["queued", "running"].includes(action.status))) kick(c);
    return c.json(successRes({ actions }));
  });
  app.get("/api/actions/:id", async c => {
    await c.get("db").syncQueue().recover();
    const action = await service(c.get("db")).get(c.req.param("id"));
    if (!action) return c.json(errorRes("未找到操作任务", "not_found"), 404);
    if (action.type === "sync" && ["queued", "running"].includes(action.status)) kick(c);
    return c.json(successRes({ action }));
  });
  app.post("/api/actions", async c => {
    try {
      const input = await body(c), type = String(input?.type || "");
      if (!isActionType(type)) throw new ValidationError("无效的 action type");
      if (type !== "sync") return c.json(successRes({ action: await service(c.get("db")).start(type, input.metadata) }), 201);
      const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata as Record<string, unknown> : {};
      const id = await enqueueSyncAction(c.get("db"), { label: String(metadata.label || "同步"),
        accountIds: Array.isArray(metadata.accountIds) ? metadata.accountIds : [], renew: metadata.renew === true },
        task => c.executionCtx.waitUntil(task), c.env);
      return c.json(successRes({ action: await service(c.get("db")).get(id) }), 201);
    } catch (error) { return fail(c, error); }
  });
  app.patch("/api/actions/:id", async c => {
    try {
      await unmanaged(c);
      const input = await body(c);
      const patch: Parameters<ActionService["update"]>[1] = {};
      if (input.status !== undefined) {
        if (!isActionStatus(input.status)) throw new ValidationError("无效的 action status");
        patch.status = input.status;
      }
      if (input.progress !== undefined) {
        if (!Number.isFinite(Number(input.progress))) throw new ValidationError("无效的 progress");
        patch.progress = Math.min(100, Math.max(0, Number(input.progress)));
      }
      if ("metadata" in input) patch.metadata = input.metadata;
      if ("error" in input) patch.error = input.error == null ? null : String(input.error);
      return c.json(successRes({ action: await service(c.get("db")).update(c.req.param("id"), patch) }));
    } catch (error) { return fail(c, error); }
  });
  app.post("/api/actions/:id/complete", async c => {
    try { await unmanaged(c); return c.json(successRes({ action: await service(c.get("db")).complete(c.req.param("id")) })); }
    catch (error) { return fail(c, error); }
  });
  app.post("/api/actions/:id/fail", async c => {
    try { await unmanaged(c); return c.json(successRes({ action: await service(c.get("db")).fail(c.req.param("id"), String((await body(c)).error || "操作失败")) })); }
    catch (error) { return fail(c, error); }
  });
  app.post("/api/actions/:id/cancel", async c => {
    try {
      const queue = c.get("db").syncQueue(), id = c.req.param("id");
      if (await queue.hasAction(id)) await queue.control(id, "cancel");
      else await service(c.get("db")).cancel(id);
      return c.json(successRes({ action: await service(c.get("db")).get(id) }));
    } catch (error) { return fail(c, error); }
  });
  app.post("/api/actions/:id/pause", async c => {
    try {
      await c.get("db").syncQueue().control(c.req.param("id"), "pause");
      return c.json(successRes({ action: await service(c.get("db")).get(c.req.param("id")) }));
    } catch (error) { return fail(c, error); }
  });
  app.post("/api/actions/:id/retry", async c => {
    try {
      const id = c.req.param("id"), queue = c.get("db").syncQueue();
      let nextId = id;
      if (await queue.hasAction(id)) await queue.control(id, "retry");
      else {
        const previous = await service(c.get("db")).get(id);
        const metadata = previous?.metadata as { accountIds?: number[]; label?: string; renew?: boolean } | undefined;
        if (previous?.type !== "sync" || !Array.isArray(metadata?.accountIds)) throw new ValidationError("旧任务缺少账号清单，请在对应页面重新同步");
        nextId = await enqueueSyncAction(c.get("db"), { accountIds: metadata.accountIds, label: metadata.label || "旧任务重试", renew: metadata.renew },
          task => c.executionCtx.waitUntil(task), c.env);
      }
      kick(c);
      return c.json(successRes({ action_id: nextId, action: await service(c.get("db")).get(nextId) }));
    } catch (error) { return fail(c, error); }
  });
}
