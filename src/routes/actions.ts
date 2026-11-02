import type { Hono } from "hono";
import type { AppEnv } from "./types";
import { errorRes, successRes } from "./response";
import { ActionRepository } from "../repositories/action-repository";
import { ActionService } from "../services/action-service";
import { isActionStatus, isActionType, type ActionStatus } from "../actions/action-types";
import { getSyncTask, cancelSyncTask, parseSyncTask, type SyncTask } from "../db/dao/sync-task-dao";
import { syncView } from "../services/sliced-sync-service";
import { AppError } from "../errors";

function service(db: AppEnv["Variables"]["db"]) {
  return new ActionService(new ActionRepository(db));
}

export function registerActionRoutes(app: Hono<AppEnv>) {
  app.get("/api/actions", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") || 50), 1), 200);
    const db = c.get("db");
    const actions = await service(db).list(limit);
    const tasks = await db.allRaw<SyncTask>(`SELECT *,CAST(strftime('%s','now') AS INTEGER) AS db_now FROM sync_tasks WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify(actions.map(a => a.id))]);
    return c.json(successRes({ actions: actions.map(a => { const task = tasks.find(t => t.id === a.id); return task ? { ...a, ...syncView(parseSyncTask(task)), sync_status: task.status, status: task.status === "completed" ? "completed" : task.status === "blocked" || task.status === "paused" ? "partial" : task.status === "cancelled" ? "cancelled" : task.status === "invalidated" ? "failed" : task.status === "running" ? "running" : "queued" } : a; }) }));
  });

  app.get("/api/actions/:id", async (c) => {
    const task = await getSyncTask(c.get("db").connection, c.req.param("id"));
    if (task) {
      const view = syncView(task);
      return c.json(successRes({ action: { ...view, id: task.id, type: "sync", sync_status: task.status, status: task.status === "completed" ? "completed" : task.status === "blocked" || task.status === "paused" ? "partial" : task.status === "cancelled" ? "cancelled" : task.status === "invalidated" ? "failed" : task.status === "running" ? "running" : "queued", metadata: { accountIds: [task.account_id], sliced: true } } }));
    }
    const action = await service(c.get("db")).get(c.req.param("id"));
    if (!action) return c.json(errorRes("未找到操作任务", "not_found"), 404);
    return c.json(successRes({ action }));
  });

  app.post("/api/actions", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const type = String(body?.type || "").trim();
      if (!isActionType(type)) return c.json(errorRes("无效的 action type", "bad_request"), 400);
      const action = await service(c.get("db")).start(type, body?.metadata);
      return c.json(successRes({ action }), 201);
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "创建操作任务失败"), 400);
    }
  });

  app.patch("/api/actions/:id", async (c) => {
    try {
      if (await getSyncTask(c.get("db").connection, c.req.param("id"))) throw new AppError("分片同步状态由数据库任务管理", 409, "sync_action_managed");
      const body = await c.req.json().catch(() => ({}));
      const status = isActionStatus(body?.status) ? body.status : undefined;
      if (body?.status !== undefined && !status) {
        return c.json(errorRes("无效的 action status", "bad_request"), 400);
      }
      if (body?.progress !== undefined && (typeof body.progress !== "number" || !Number.isFinite(body.progress) || body.progress < 0 || body.progress > 100)) {
        return c.json(errorRes("progress 必须是 0 到 100 的数值", "bad_request"), 400);
      }
      const patch: Parameters<ActionService["update"]>[1] = {
        status: status as ActionStatus | undefined,
        progress: body?.progress,
        error: body?.error === undefined ? undefined : body.error === null ? null : String(body.error),
        metadata: body?.metadata,
      };
      await service(c.get("db")).update(c.req.param("id"), patch);
      const action = await service(c.get("db")).get(c.req.param("id"));
      return c.json(successRes({ action }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "更新操作任务失败"), 400);
    }
  });

  app.post("/api/actions/:id/complete", async (c) => {
    try {
      if (await getSyncTask(c.get("db").connection, c.req.param("id"))) throw new AppError("不能人工标记完整同步成功", 409, "sync_action_managed");
      const action = await service(c.get("db")).complete(c.req.param("id"));
      return c.json(successRes({ action }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "完成操作任务失败"), 400);
    }
  });

  app.post("/api/actions/:id/fail", async (c) => {
    try {
      if (await getSyncTask(c.get("db").connection, c.req.param("id"))) throw new AppError("分片同步状态由数据库任务管理", 409, "sync_action_managed");
      const body = await c.req.json().catch(() => ({}));
      const action = await service(c.get("db")).fail(c.req.param("id"), String(body?.error || "操作失败"));
      return c.json(successRes({ action }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "标记操作任务失败"), 400);
    }
  });

  app.post("/api/actions/:id/cancel", async (c) => {
    try {
      const task = await getSyncTask(c.get("db").connection, c.req.param("id"));
      if (!task) return c.json(errorRes("该操作没有持久化取消协议；不能把状态标记为已撤销。请停止客户端后续请求并只读核验已发送结果；不自动补偿", "cancel_not_supported"), 409);
      if (task) await cancelSyncTask(c.get("db").connection, task);
      const action = await service(c.get("db")).cancel(c.req.param("id"));
      return c.json(successRes({ action }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "取消操作任务失败"), 400);
    }
  });
}
