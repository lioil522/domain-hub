import type { Context, Hono } from "hono";
import type { AppEnv } from "./types";
import { errorRes, successRes } from "./response";
import { ScannerRepository } from "../repositories/scanner-repository";
import { ScannerService } from "../services/scanner-service";
import { isScannerJobStatus } from "../types/scanner";

function service(c: Context<AppEnv>) {
  return new ScannerService(new ScannerRepository(c.get("db")));
}

export function registerScannerRoutes(app: Hono<AppEnv>) {
  app.get("/api/scanner/jobs", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") || 50), 1), 200);
    return c.json(successRes({ jobs: await service(c).list(limit) }));
  });

  app.get("/api/scanner/jobs/:id", async (c) => {
    const job = await service(c).get(c.req.param("id"));
    if (!job) return c.json(errorRes("未找到扫描任务", "not_found"), 404);
    return c.json(successRes({ job }));
  });

  app.post("/api/scanner/jobs", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const scanner = service(c);
      const job = await scanner.create(body?.id ? String(body.id) : crypto.randomUUID(), String(body?.cursor || ""));
      return c.json(successRes({ job }), 201);
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "创建扫描任务失败"), 400);
    }
  });

  app.patch("/api/scanner/jobs/:id", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const scanner = service(c);
      const status = body?.status === undefined ? undefined : (isScannerJobStatus(body.status) ? body.status : null);
      if (body?.status !== undefined && !status) {
        return c.json(errorRes("无效的 scanner 状态", "bad_request"), 400);
      }
      await scanner.update(c.req.param("id"), {
        status: status || undefined,
        cursor: body?.cursor,
        totalChecked: body?.totalChecked,
        available: body?.available,
        registered: body?.registered,
        failed: body?.failed,
        finishedAt: body?.finishedAt,
        error: body?.error,
      });
      return c.json(successRes({ job: await scanner.get(c.req.param("id")) }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "更新扫描任务失败"), 400);
    }
  });

  app.post("/api/scanner/jobs/:id/pause", async (c) => {
    try { return c.json(successRes({ job: await service(c).pause(c.req.param("id")) })); }
    catch (e: unknown) { return c.json(errorRes(e instanceof Error ? e.message : "暂停扫描任务失败"), 400); }
  });
  app.post("/api/scanner/jobs/:id/resume", async (c) => {
    try { return c.json(successRes({ job: await service(c).resume(c.req.param("id")) })); }
    catch (e: unknown) { return c.json(errorRes(e instanceof Error ? e.message : "恢复扫描任务失败"), 400); }
  });
}

