import type { Hono } from "hono";
import type { AppEnv } from "./types";
import { errorRes, successRes } from "./response";
import { ActionRepository } from "../repositories/action-repository";
import { ActionService } from "../services/action-service";
import { isActionStatus, isActionType, type ActionStatus } from "../actions/action-types";

function service(db: AppEnv["Variables"]["db"]) {
  return new ActionService(new ActionRepository(db));
}

export function registerActionRoutes(app: Hono<AppEnv>) {
  app.get("/api/actions", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") || 50), 1), 200);
    return c.json(successRes({ actions: await service(c.get("db")).list(limit) }));
  });

  app.get("/api/actions/:id", async (c) => {
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
      const body = await c.req.json().catch(() => ({}));
      const status = isActionStatus(body?.status) ? body.status : undefined;
      if (body?.status !== undefined && !status) {
        return c.json(errorRes("无效的 action status", "bad_request"), 400);
      }
      const patch: Parameters<ActionService["update"]>[1] = {
        status: status as ActionStatus | undefined,
        progress: Number.isFinite(Number(body?.progress)) ? Number(body.progress) : undefined,
        error: body?.error == null ? undefined : String(body.error),
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
      const action = await service(c.get("db")).complete(c.req.param("id"));
      return c.json(successRes({ action }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "完成操作任务失败"), 400);
    }
  });

  app.post("/api/actions/:id/fail", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const action = await service(c.get("db")).fail(c.req.param("id"), String(body?.error || "操作失败"));
      return c.json(successRes({ action }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "标记操作任务失败"), 400);
    }
  });

  app.post("/api/actions/:id/cancel", async (c) => {
    try {
      const action = await service(c.get("db")).cancel(c.req.param("id"));
      return c.json(successRes({ action }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "取消操作任务失败"), 400);
    }
  });
}
