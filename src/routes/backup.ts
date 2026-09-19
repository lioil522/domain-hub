import type { Context, Hono } from "hono";
import type { AppEnv } from "./types";
import { errorRes, successRes } from "./response";
import type { DatabaseManager } from "../db";
import { LogService } from "../services/log-service";
import { LogRepository } from "../repositories/log-repository";
import { BackupService } from "../services/backup-service";
import { AuditRepository } from "../repositories/audit-repository";
import { AuditService } from "../services/audit-service";

export interface BackupRouteDeps {
  loginMaxFailures: number;
  loginLockWindowSeconds: number;
  loginLockedMessage: string;
  getClientIp: (c: Context<AppEnv>) => string;
  verifyTOTP: (token: string, secret: string) => Promise<boolean>;
}

export function registerBackupRoutes(app: Hono<AppEnv>, deps: BackupRouteDeps) {
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
      if (!backup.validate(snapshot)) {
        return c.json(errorRes("备份文件格式无效或版本不受支持", "bad_request"), 400);
      }
      const { imported } = await backup.restore(snapshot);
      const summary = Object.entries(imported)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${t} ${n} 条`)
        .join(" / ");
      await logs(dbManager).write("success", "operation", `已导入业务数据：${summary || "无数据"}`);
      await audit(dbManager).write({ actor: "session", action: "restore", resourceType: "backup", result: "success", details: imported });
      return c.json(successRes({
        imported,
        message: `导入完成（合并模式，未删除任何现有数据）：${summary || "备份中无数据"}`,
      }));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "导入失败";
      await logs(dbManager).write("error", "operation", `数据导入失败：${message}`);
      await audit(dbManager).write({ actor: "session", action: "restore", resourceType: "backup", result: "failure", details: { message } });
      return c.json(errorRes(message), 400);
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
      return c.json(errorRes(e instanceof Error ? e.message : "备份预览失败"), 400);
    }
  });
}
