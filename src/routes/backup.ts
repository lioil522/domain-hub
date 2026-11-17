import type { Context, Hono } from "hono";
import type { AppEnv } from "./types";
import { errorRes, successRes } from "./response";
import type { DatabaseManager } from "../db";
import { LogService } from "../services/log-service";
import { LogRepository } from "../repositories/log-repository";
import { BackupService } from "../services/backup-service";
import { AuditRepository } from "../repositories/audit-repository";
import { AuditService } from "../services/audit-service";
import { bodyLimit } from "hono/body-limit";
import { BACKUP_BODY_LIMIT } from "../db/backup-snapshot";
import { AppError, ValidationError } from "../errors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { sha256Hex } from "../db/crypto";
import { RESTORE_CHUNK_BYTES } from "../../shared/restore-wire";

export interface BackupRouteDeps {
  loginMaxFailures: number;
  loginLockWindowSeconds: number;
  loginLockedMessage: string;
  getClientIp: (c: Context<AppEnv>) => string;
  verifyTOTP: (token: string, secret: string) => Promise<boolean>;
}

export function registerBackupRoutes(app: Hono<AppEnv>, deps: BackupRouteDeps) {
  app.use("/api/data/*", bodyLimit({
    maxSize: BACKUP_BODY_LIMIT,
    onError: c => c.json(errorRes("数据请求超过 20MB 上限", "payload_too_large"), 413),
  }));
  const logs = (db: DatabaseManager) => new LogService(new LogRepository(db));
  const audit = (db: DatabaseManager) => new AuditService(new AuditRepository(db));

  const dataOpScope = (c: Context<AppEnv>): string => `dataop:${deps.getClientIp(c)}`;

  async function checkDataOpTotp(
    c: Context<AppEnv>,
    dbManager: DatabaseManager,
    token: string,
    requireConfigured: boolean,
  ): Promise<Response | null> {
    const cfg = await dbManager.getAuthConfig();
    const ipScope = dataOpScope(c);

    if (!cfg.twoFaEnabled || !cfg.twoFaSecret) {
      if (requireConfigured) {
        return c.json(
          errorRes(
            "出于安全考虑，导出功能要求先开启两步验证（2FA）。请前往「设置 → 账户安全」开启后再试。",
            "2fa_required",
          ),
          403,
        );
      }
      return null;
    }

    if ((await dbManager.countLoginFailures(ipScope)) >= deps.loginMaxFailures) {
      return c.json(errorRes(deps.loginLockedMessage, "too_many_attempts"), 429);
    }

    const code = String(token || "").trim();
    if (!code) {
      return c.json(errorRes("请输入身份验证器上的 6 位动态验证码以继续", "need_2fa"), 401);
    }

    if (!(await deps.verifyTOTP(code, cfg.twoFaSecret))) {
      await dbManager.recordLoginFailure(ipScope, deps.loginLockWindowSeconds);
      await logs(dbManager).write("warning", "auth", "数据导出/导入的动态码校验失败");
      return c.json(errorRes("动态验证码错误或已过期", "invalid_2fa"), 401);
    }

    try {
      await dbManager.clearLoginFailures(ipScope);
    } catch {
      // A successful TOTP must not be rejected because cleanup failed.
    }
    return null;
  }

  app.post("/api/data/export", async (c) => {
    const dbManager = c.get("db");
    try {
      const body = await c.req.json().catch(() => ({}));
      const denied = await checkDataOpTotp(c, dbManager, String(body?.token || ""), true);
      if (denied) return denied;

      const backup = new BackupService(dbManager);
      const snapshot = await backup.exportSnapshot();
      const counts = snapshot.counts || {};
      await logs(dbManager).write(
        "success",
        "operation",
        `已导出业务数据（账号 ${counts.accounts || 0} 个 / 域名缓存 ${counts.domains_cache || 0} 条 / 自定义域名 ${counts.custom_domains || 0} 条）`,
      );
      await audit(dbManager).write({ actor: "session", action: "export", resourceType: "backup", result: "success", details: counts });
      return c.json(successRes(snapshot));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "导出失败";
      await logs(dbManager).write("error", "operation", `数据导出失败：${message}`);
      return c.json(errorRes(message), 500);
    }
  });

  app.post("/api/data/import", async (c) => {
    const dbManager = c.get("db");
    try {
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return c.json(errorRes("请求体格式无效", "bad_request"), 400);
      }

      const denied = await checkDataOpTotp(c, dbManager, String((body as Record<string, unknown>).token || ""), false);
      if (denied) return denied;

      const snapshot = (body as Record<string, unknown>).snapshot;
      if (!snapshot || typeof snapshot !== "object") {
        return c.json(errorRes("缺少 snapshot 字段", "bad_request"), 400);
      }

      const backup = new BackupService(dbManager);
      const { imported } = await backup.restore(snapshot);
      const summary = Object.entries(imported)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${t} ${n} 条`)
        .join(" / ");
      // Data is already committed. An audit/log failure must not invite a repeat import.
      const writes = await Promise.allSettled([
        logs(dbManager).write("success", "operation", `已导入业务数据：${summary || "无数据"}`),
        audit(dbManager).write({ actor: "session", action: "restore", resourceType: "backup", result: "success", details: imported }),
      ]);
      const warnings = writes.some(result => result.status === "rejected") ? ["业务数据已提交，但部分日志或审计写入失败；请勿重复导入"] : [];
      if (warnings.length) console.error("Backup restore committed with an incomplete audit/log record");
      return c.json(successRes({
        imported,
        warnings,
        message: `导入完成（合并模式，未删除任何现有数据）：${summary || "备份中无数据"}`,
      }));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "导入失败";
      await Promise.allSettled([
        logs(dbManager).write("error", "operation", `数据导入失败：${message}`),
        audit(dbManager).write({ actor: "session", action: "restore", resourceType: "backup", result: "failure", details: { message } }),
      ]);
      return c.json(errorRes(message, e instanceof AppError ? e.code : "backup_restore_failed"), (e instanceof AppError ? e.statusCode : 400) as ContentfulStatusCode);
    }
  });

  app.post("/api/data/preview", async (c) => {
    const dbManager = c.get("db");
    try {
      const body = await c.req.json().catch(() => ({}));
      const denied = await checkDataOpTotp(c, dbManager, String(body?.token || ""), false);
      if (denied) return denied;
      const diff = await new BackupService(dbManager).preview(body?.snapshot);
      return c.json(successRes({ diff }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "备份预览失败", e instanceof AppError ? e.code : "backup_preview_failed"), (e instanceof AppError ? e.statusCode : 400) as ContentfulStatusCode);
    }
  });

  app.use("/api/data/restore/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.use("/api/data/restore/*", bodyLimit({
    maxSize: RESTORE_CHUNK_BYTES + 65536,
    onError: c => c.json(errorRes("分段请求超过大小上限", "payload_too_large"), 413),
  }));
  const owner = (c: Context<AppEnv>) => sha256Hex(c.req.header("Authorization")!.substring(7).trim());
  const stagedBody = (c: Context<AppEnv>) => c.req.json<Record<string, unknown>>().then(body => {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("分段请求体格式无效");
    return body;
  }).catch(error => { if (error instanceof ValidationError) throw error; throw new ValidationError("分段请求不是有效 JSON"); });
  const stagedError = (c: Context<AppEnv>, error: unknown) => c.json(
    errorRes(error instanceof Error ? error.message : "分段恢复失败", error instanceof AppError ? error.code : "restore_failed"),
    (error instanceof AppError ? error.statusCode : 500) as ContentfulStatusCode,
  );
  app.post("/api/data/restore/create", async c => {
    try {
      const body = await stagedBody(c);
      const denied = await checkDataOpTotp(c, c.get("db"), String(body.token || ""), false);
      if (denied) return denied;
      const session = await c.get("db").stagedRestore().create(String(body.id || ""), await owner(c), body.manifest);
      return c.json(successRes({ session }), 201);
    } catch (error) { return stagedError(c, error); }
  });
  app.get("/api/data/restore/:id", async c => {
    try { return c.json(successRes({ session: await c.get("db").stagedRestore().get(c.req.param("id"), await owner(c)) })); }
    catch (error) { return stagedError(c, error); }
  });
  app.post("/api/data/restore/:id/chunks/:index", async c => {
    try {
      const body = await stagedBody(c);
      const session = await c.get("db").stagedRestore().upload(c.req.param("id"), await owner(c), Number(c.req.param("index")), body.rows);
      return c.json(successRes({ session }));
    } catch (error) { return stagedError(c, error); }
  });
  app.post("/api/data/restore/:id/validate", async c => {
    try { return c.json(successRes({ session: await c.get("db").stagedRestore().validate(c.req.param("id"), await owner(c)) })); }
    catch (error) { return stagedError(c, error); }
  });
  app.post("/api/data/restore/:id/commit", async c => {
    try {
      const body = await stagedBody(c);
      const denied = await checkDataOpTotp(c, c.get("db"), String(body.token || ""), false);
      if (denied) return denied;
      const session = await c.get("db").stagedRestore().commit(c.req.param("id"), await owner(c));
      const writes = await Promise.allSettled([
        audit(c.get("db")).write({ actor: "session", action: "restore", resourceType: "backup", resourceId: session.id,
          result: "success", details: session.result?.imported }),
        logs(c.get("db")).write("success", "operation", `分段恢复已提交：${session.id}`),
      ]);
      return c.json(successRes({ session, imported: session.result?.imported,
        warnings: writes.some(result => result.status === "rejected") ? ["数据已提交，但部分审计或日志写入失败"] : [] }));
    } catch (error) { return stagedError(c, error); }
  });
  app.post("/api/data/restore/:id/cancel", async c => {
    try { return c.json(successRes({ session: await c.get("db").stagedRestore().cancel(c.req.param("id"), await owner(c)) })); }
    catch (error) { return stagedError(c, error); }
  });
}
