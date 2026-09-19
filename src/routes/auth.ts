import type { Hono, Context } from "hono";
import type { AppEnv } from "./types";
import { successRes, errorRes } from "./response";
import { DatabaseManager, timingSafeEqual } from "../db";
import { LogService } from "../services/log-service";
import { LogRepository } from "../repositories/log-repository";
import { AuditService } from "../services/audit-service";
import { AuditRepository } from "../repositories/audit-repository";

export interface AuthRouteDeps {
  loginMaxFailures: number;
  loginLockWindowSeconds: number;
  loginLockedMessage: string;
  capText: (value: string) => string;
  getClientIp: (c: Context<AppEnv>) => string;
  verifyTOTP: (token: string, secret: string) => Promise<boolean>;
  generateBase32Secret: () => string;
  buildOtpAuthUri: (secret: string, username: string) => string;
}

/** Authentication endpoints. Session middleware remains in the application composition layer. */
export function registerAuthRoutes(app: Hono<AppEnv>, deps: AuthRouteDeps) {
  const logs = (db: DatabaseManager) => new LogService(new LogRepository(db));
  const audit = (db: DatabaseManager) => new AuditService(new AuditRepository(db));

  app.get("/api/auth/status", async (c) => {
    const db = c.get("db");
    try {
      const cfg = await db.getAuthConfig();
      return c.json(successRes({ initialized: cfg.initialized, two_fa_enabled: cfg.twoFaEnabled }));
    } catch (e: unknown) {
      return c.json(errorRes(`读取鉴权状态失败: ${e instanceof Error ? e.message : "服务端内部错误"}`), 500);
    }
  });

  app.post("/api/auth/setup", async (c) => {
    const db = c.get("db");
    try {
      const cfg = await db.getAuthConfig();
      if (cfg.initialized) return c.json(errorRes("系统已完成初始化，无法再次通过此接口设置密码", "already_initialized"), 403);
      const body = await c.req.json().catch(() => ({}));
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      if (!username || username.length < 3) return c.json(errorRes("用户名至少需要 3 个字符", "bad_request"), 400);
      if (password.length < 8) return c.json(errorRes("密码至少需要 8 个字符", "bad_request"), 400);
      await db.setPassword(username, password);
      await logs(db).write("success", "auth", `系统完成首次初始化，已创建管理员账户 [${username}]`);
      await audit(db).write({ actor: deps.capText(username), action: "setup", resourceType: "auth", result: "success" });
      const sessionToken = await db.createSession();
      return c.json(successRes({ session_token: sessionToken, message: "🎉 初始化成功！管理员账户已创建并自动登录" }));
    } catch (e: unknown) {
      console.error("Setup process error:", e);
      return c.json(errorRes(`初始化失败: ${e instanceof Error ? e.message : "服务端内部错误"}`), 500);
    }
  });

  app.post("/api/auth/login", async (c) => {
    const db = c.get("db");
    const emergencyToken = c.env.ADMIN_TOKEN || "";
    try {
      const cfg = await db.getAuthConfig();
      const body = await c.req.json().catch(() => ({}));
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const totpToken = String(body.token || "").trim();
      const clientIp = deps.getClientIp(c);
      const userScope = `u:${deps.capText(username)}@${clientIp}`;
      const ipScope = `ip:${clientIp}`;
      const isLocked = async () => (await db.countLoginFailures(userScope)) >= deps.loginMaxFailures || (await db.countLoginFailures(ipScope)) >= deps.loginMaxFailures;
      const noteFailure = async () => { await db.recordLoginFailure(userScope, deps.loginLockWindowSeconds); await db.recordLoginFailure(ipScope, deps.loginLockWindowSeconds); };
      const noteSuccess = async () => { await db.clearLoginFailures(userScope); await db.clearLoginFailures(ipScope); };

      if (!cfg.initialized) return c.json(errorRes("系统尚未初始化，请先设置管理员账户与密码", "not_initialized"), 409);
      if (await isLocked()) return c.json(errorRes(deps.loginLockedMessage, "too_many_attempts"), 429);

      if (emergencyToken && !username && (totpToken || password)) {
        const candidate = totpToken || password;
        if (await deps.verifyTOTP(candidate, emergencyToken) || timingSafeEqual(candidate, emergencyToken)) {
          const sessionToken = await db.createSession();
          await logs(db).write("warning", "auth", "管理员通过应急令牌 (ADMIN_TOKEN) 登录");
          await audit(db).write({ actor: "emergency", action: "login", resourceType: "session", resourceId: sessionToken.slice(0, 12), result: "success", details: { method: "admin_token" } });
          return c.json(successRes({ session_token: sessionToken, message: "已通过应急令牌登录，建议尽快在设置中重置密码" }));
        }
        await noteFailure();
      }

      if (!username || !password) return c.json(errorRes("请输入用户名与密码", "bad_request"), 400);
      const userMatch = timingSafeEqual(username, cfg.username);
      const passMatch = await db.verifyPassword(password);
      if (!userMatch || !passMatch) {
        await logs(db).write("warning", "auth", `管理员登录失败：用户名或密码错误 (输入用户名: ${deps.capText(username)})`);
        await noteFailure();
        return c.json(errorRes("用户名或密码错误", "invalid_credentials"), 401);
      }
      if (cfg.twoFaEnabled) {
        if (!totpToken) return c.json(errorRes("请输入 6 位动态验证码", "need_2fa"), 401);
        if (!(await deps.verifyTOTP(totpToken, cfg.twoFaSecret))) {
          await logs(db).write("warning", "auth", "管理员登录失败：2FA 动态验证码错误或已过期");
          await noteFailure();
          return c.json(errorRes("2FA 动态验证码错误或已过期", "invalid_2fa"), 401);
        }
      }
      const sessionToken = await db.createSession();
      await noteSuccess();
      await logs(db).write("success", "auth", `管理员 [${deps.capText(username)}] 登录成功${cfg.twoFaEnabled ? "（含 2FA 校验）" : ""}`);
      await audit(db).write({ actor: deps.capText(username), action: "login", resourceType: "session", resourceId: sessionToken.slice(0, 12), result: "success" });
      return c.json(successRes({ session_token: sessionToken, message: "🎉 登录成功" }));
    } catch (e: unknown) {
      console.error("Login process error:", e);
      return c.json(errorRes(`登录鉴权失败: ${e instanceof Error ? e.message : "服务端内部错误"}`), 500);
    }
  });

  app.post("/api/auth/logout", async (c) => {
    const db = c.get("db");
    try {
      const authHeader = c.req.header("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : "";
      if (token) { await db.revokeSession(token); await logs(db).write("info", "auth", "管理员注销了当前登录会话"); await audit(db).write({ actor: "session", action: "logout", resourceType: "session", resourceId: token.slice(0, 12), result: "success" }); }
      return c.json(successRes({ message: "已退出登录" }));
    } catch (e: unknown) {
      return c.json(errorRes(`注销失败: ${e instanceof Error ? e.message : "服务端内部错误"}`), 500);
    }
  });

  app.get("/api/auth/sessions", async (c) => {
    const db = c.get("db");
    try {
      const rows = await db.allRaw<{ key: string; value: string; updated_at: string }>(
        "SELECT key, value, updated_at FROM settings WHERE key LIKE 'sess_%' ORDER BY updated_at DESC"
      );
      const now = Math.floor(Date.now() / 1000);
      const sessions = rows.filter((row) => Number(row.value) > now).map((row) => ({
        id: row.key.slice(5, 17),
        expires_at: Number(row.value),
        updated_at: row.updated_at,
      }));
      return c.json(successRes({ sessions }));
    } catch (e: unknown) {
      return c.json(errorRes(`读取会话失败: ${e instanceof Error ? e.message : "服务端内部错误"}`), 500);
    }
  });

  app.delete("/api/auth/sessions/:id", async (c) => {
    const db = c.get("db");
    const id = String(c.req.param("id") || "").trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return c.json(errorRes("无效的会话 ID", "bad_request"), 400);
    try {
      await db.executeRaw("DELETE FROM settings WHERE key LIKE ?", [`sess_${id}%`]);
      await audit(db).write({ actor: "session", action: "revoke_session", resourceType: "session", resourceId: id, result: "success" });
      return c.json(successRes({ message: "会话已撤销" }));
    } catch (e: unknown) {
      return c.json(errorRes(`撤销会话失败: ${e instanceof Error ? e.message : "服务端内部错误"}`), 500);
    }
  });

  app.post("/api/auth/sessions/revoke-all", async (c) => {
    const db = c.get("db");
    try {
      await db.executeRaw("DELETE FROM settings WHERE key LIKE 'sess_%'");
      await logs(db).write("warning", "auth", "管理员撤销了全部登录会话");
      await audit(db).write({ actor: "session", action: "revoke_all_sessions", resourceType: "session", result: "success" });
      return c.json(successRes({ message: "已撤销全部登录会话" }));
    } catch (e: unknown) {
      return c.json(errorRes(`撤销会话失败: ${e instanceof Error ? e.message : "服务端内部错误"}`), 500);
    }
  });

  app.get("/api/auth/account", async (c) => {
    const db = c.get("db");
    try {
      const cfg = await db.getAuthConfig();
      return c.json(successRes({ username: cfg.username, two_fa_enabled: cfg.twoFaEnabled }));
    } catch (e: unknown) {
      return c.json(errorRes(`读取账户信息失败: ${e instanceof Error ? e.message : "服务端内部错误"}`), 500);
    }
  });

  app.post("/api/auth/change-password", async (c) => {
    const db = c.get("db");
    try {
      const body = await c.req.json().catch(() => ({}));
      const oldPassword = String(body.old_password || "");
      const newPassword = String(body.new_password || "");
      const newUsername = body.username !== undefined ? String(body.username).trim() : undefined;
      const cfg = await db.getAuthConfig();
      if (!(await db.verifyPassword(oldPassword))) {
        await logs(db).write("warning", "auth", "修改密码失败：原密码校验不通过");
        return c.json(errorRes("原密码错误", "invalid_credentials"), 401);
      }
      if (newPassword.length < 8) return c.json(errorRes("新密码至少需要 8 个字符", "bad_request"), 400);
      if (newUsername !== undefined && newUsername.length > 0 && newUsername.length < 3) return c.json(errorRes("用户名至少需要 3 个字符", "bad_request"), 400);
      const finalUsername = newUsername && newUsername.length >= 3 ? newUsername : cfg.username;
      await db.setPassword(finalUsername, newPassword);
      await db.executeRaw("DELETE FROM settings WHERE key LIKE 'sess_%'");
      await logs(db).write("success", "auth", `管理员 [${finalUsername}] 修改了登录密码`);
      await audit(db).write({ actor: finalUsername, action: "change_password", resourceType: "auth", result: "success" });
      return c.json(successRes({ message: "密码修改成功，请使用新密码重新登录" }));
    } catch (e: unknown) {
      return c.json(errorRes(`修改密码失败: ${e instanceof Error ? e.message : "服务端内部错误"}`), 500);
    }
  });

  app.post("/api/auth/2fa/setup", async (c) => {
    const db = c.get("db");
    try {
      const cfg = await db.getAuthConfig();
      const secret = deps.generateBase32Secret();
      await db.setTwoFaSecret(secret);
      return c.json(successRes({ secret, otpauth_uri: deps.buildOtpAuthUri(secret, cfg.username), message: "请用身份验证器扫码或手动录入密钥，然后输入动态码完成开启" }));
    } catch (e: unknown) {
      return c.json(errorRes(`生成 2FA 密钥失败: ${e instanceof Error ? e.message : "服务端内部错误"}`), 500);
    }
  });

  app.post("/api/auth/2fa/enable", async (c) => {
    const db = c.get("db");
    try {
      const body = await c.req.json().catch(() => ({}));
      const token = String(body.token || "").trim();
      if (!token) return c.json(errorRes("请输入身份验证器上的 6 位动态码", "bad_request"), 400);
      const cfg = await db.getAuthConfig();
      if (!cfg.twoFaSecret) return c.json(errorRes("尚未生成 2FA 密钥，请先执行密钥生成步骤", "bad_request"), 400);
      if (!(await deps.verifyTOTP(token, cfg.twoFaSecret))) return c.json(errorRes("动态码校验失败，请确认时间同步后重试", "invalid_2fa"), 401);
      await db.setTwoFaEnabled(true);
      await logs(db).write("success", "auth", "管理员已开启两步验证 (2FA)");
      await audit(db).write({ actor: "session", action: "enable_2fa", resourceType: "auth", result: "success" });
      return c.json(successRes({ message: "🎉 两步验证已开启，下次登录需输入动态码" }));
    } catch (e: unknown) {
      return c.json(errorRes(`开启 2FA 失败: ${e instanceof Error ? e.message : "服务端内部错误"}`), 500);
    }
  });

  app.post("/api/auth/2fa/disable", async (c) => {
    const db = c.get("db");
    try {
      const body = await c.req.json().catch(() => ({}));
      const token = String(body.token || "").trim();
      if (!token) return c.json(errorRes("请输入身份验证器上的 6 位动态码", "bad_request"), 400);
      const cfg = await db.getAuthConfig();
      if (!cfg.twoFaEnabled || !cfg.twoFaSecret) return c.json(errorRes("两步验证当前未开启", "bad_request"), 400);
      if (!(await deps.verifyTOTP(token, cfg.twoFaSecret))) {
        await logs(db).write("warning", "auth", "关闭 2FA 失败：动态验证码错误或已过期");
        return c.json(errorRes("动态验证码错误或已过期，无法关闭 2FA", "invalid_2fa"), 401);
      }
      await db.setTwoFaEnabled(false);
      await logs(db).write("warning", "auth", "管理员已关闭两步验证 (2FA)");
      await audit(db).write({ actor: "session", action: "disable_2fa", resourceType: "auth", result: "success" });
      return c.json(successRes({ message: "两步验证已关闭" }));
    } catch (e: unknown) {
      return c.json(errorRes(`关闭 2FA 失败: ${e instanceof Error ? e.message : "服务端内部错误"}`), 500);
    }
  });
}
