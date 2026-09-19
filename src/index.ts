import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { sendTelegramNotification, sendWebhookNotification } from "./cron";
import type { WebhookType } from "./cron";
import type { Bindings, Variables } from "./routes/types";
import { DatabaseManager, timingSafeEqual } from "./db";
import { AppError } from "./errors";
// NOTE: 同一模块既要把 isRegistrableDomain 转出给外部（见下方 export ... from），
// 又要在本文件内直接调用它 —— `export { x } from` 只做转出、不建立本地绑定，
// 所以必须再显式导入一次，否则本文件内的调用点会报 TS2304。
import { isRegistrableDomain } from "./punycode";
import { AccountRepository } from "./repositories/account-repository";
import { DomainRepository } from "./repositories/domain-repository";
import { LogRepository } from "./repositories/log-repository";
import { AccountService } from "./services/account-service";
import { LogService } from "./services/log-service";
import { runDailySyncAndRenewal } from "./cron/jobs/daily-sync";
import { PROVIDER_IDS, PROVIDER_LABELS, normalizeProvider } from "./providers/registry";
import { resyncAccountsInBackground, ensureDefaultAccount, sleep, cacheNewlyRegisteredDomain } from "./services/account-sync-service";
import { fetchAllQuotas } from "./services/quota-service";
import { registerQuotaRoutes } from "./routes/quota";

import { registerSettingsRoutes } from "./routes/settings";

import { registerLogRoutes } from "./routes/logs";
import { registerAuthRoutes } from "./routes/auth";
import { registerCustomGroupRoutes } from "./routes/custom-groups";
import { registerBackupRoutes } from "./routes/backup";
import { registerAccountRoutes } from "./routes/accounts";
import { registerDomainRoutes } from "./routes/domains";
import { registerDnsRoutes } from "./routes/dns";
import { registerWhoisRoutes } from "./routes/whois";
import { registerNsRoutes } from "./routes/ns";
import { registerExpiryRoutes } from "./routes/expiry";
import { registerRegistrationRoutes } from "./routes/registration";

import { registerActionRoutes } from "./routes/actions";
import { registerAuditRoutes } from "./routes/audit";
import { registerSearchRoutes } from "./routes/search";
import { registerScannerRoutes } from "./routes/scanner";

import { successRes, errorRes } from "./routes/response";

// Phase 2 提取的模块
import { verifyTOTP, generateBase32Secret, buildOtpAuthUri } from "./auth/totp";
import { withSecurityHeaders } from "./middleware/security-headers";
import { LOGIN_MAX_FAILURES, LOGIN_LOCK_WINDOW_SECONDS, LOGIN_LOCKED_MESSAGE } from "./middleware/rate-limit";
import { getClientIp, capText } from "./middleware/auth-helpers";


// Service factories keep the legacy route handlers thin while centralizing repository wiring.
// They are intentionally request-scoped: DatabaseManager is the request binding and must not be cached globally.
function accountService(dbManager: DatabaseManager): AccountService {
  return new AccountService(new AccountRepository(dbManager));
}

function logService(dbManager: DatabaseManager): LogService {
  return new LogService(new LogRepository(dbManager));
}

/**
 * 归一化请求里的 provider 字段
 */
const ACCOUNT_PROVIDERS = PROVIDER_IDS;
const normalizeAccountProvider = normalizeProvider;
const PROVIDER_DISPLAY_NAMES = PROVIDER_LABELS;

// Account synchronization/default-account bootstrap/post-registration cache live in account-sync-service.ts.

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * CORS 中间件 — 默认仅允许同源访问，生产环境通过 ALLOWED_ORIGIN 环境变量配置
 */
app.use(
  "/api/*",
  async (c, next) => {
    const requestOrigin = c.req.header("Origin") || "";

    const allowList = (c.env.ALLOWED_ORIGIN || "")
      .split(",")
      .map((o) => o.trim().replace(/\/$/, ""))
      .filter(Boolean);
    const allowOrigin =
      allowList.length === 0
        ? requestOrigin || "*"
        : allowList.includes(requestOrigin)
        ? requestOrigin
        : "";

    if (c.req.method === "OPTIONS") {
      const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      };
      if (allowOrigin) {
        headers["Access-Control-Allow-Origin"] = allowOrigin;
      }
      return new Response(null, { status: 204, headers });
    }

    const corsMiddleware = cors({
      origin: allowList.length > 0 ? allowList : requestOrigin || "*",
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      maxAge: 86400,
    });
    return corsMiddleware(c, next);
  }
);

/**
 * 表结构自举 — 每个 isolate 只执行一次
 */
let schemaReady: Promise<boolean> | null = null;

function ensureSchemaOnce(dbManager: DatabaseManager): Promise<boolean> {
  if (!schemaReady) {
    schemaReady = dbManager
      .ensureTables()
      .then((ok) => {
        if (!ok) schemaReady = null;
        return ok;
      })
      .catch((e) => {
        schemaReady = null;
        console.error("ensureSchemaOnce failed:", e);
        return false;
      });
  }
  return schemaReady;
}

/**
 * DatabaseManager 实例化中间件 — 注入 dbManager 到 context
 */
app.use("/api/*", async (c, next) => {
  const dbManager = new DatabaseManager(c.env.DB, c.env.AES_KEY);
  await ensureSchemaOnce(dbManager);
  c.set("db", dbManager);
  return next();
});

/**
 * 鉴权中间件 — 验证受保护 API 的 Session 会话 Token
 */
app.use("/api/*", async (c, next) => {
  const publicPaths = ["/api/auth/login", "/api/auth/setup", "/api/auth/status"];
  if (publicPaths.includes(c.req.path)) {
    return next();
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json(errorRes("未提供有效的 Authorization 头部，格式应为: Bearer <session_token>", "unauthorized"), 401);
  }

  const token = authHeader.substring(7).trim();
  const dbManager = c.get("db");
  const emergencyToken = c.env.ADMIN_TOKEN || "";

  // 1. 校验登录成功后签发的 Session Token
  if (token.startsWith(DatabaseManager.SESSION_PREFIX)) {
    try {
      if (await dbManager.validateSession(token)) {
        return next();
      }
    } catch (e) {}
  }

  // 2. 应急令牌通道
  if (emergencyToken) {
    if (timingSafeEqual(token, emergencyToken) || await verifyTOTP(token, emergencyToken)) {
      return next();
    }
  }

  // 3. 限流
  if (!token.startsWith(DatabaseManager.SESSION_PREFIX)) {
    const ipScope = `ip:${getClientIp(c)}`;
    if ((await dbManager.countLoginFailures(ipScope)) >= LOGIN_MAX_FAILURES) {
      return c.json(errorRes(LOGIN_LOCKED_MESSAGE, "too_many_attempts"), 429);
    }
    await dbManager.recordLoginFailure(ipScope, LOGIN_LOCK_WINDOW_SECONDS);
  }

  return c.json(errorRes("认证失败：会话凭据已失效，请重新登录", "forbidden"), 403);
});

registerAccountRoutes(app, {
  normalizeProvider: normalizeAccountProvider,
  providerLabels: PROVIDER_DISPLAY_NAMES,
  ensureDefaultAccount,
  resyncAccountsInBackground,
  sleep,
  accountService,
});

registerCustomGroupRoutes(app, { accountService });

registerDomainRoutes(app, {
  resyncAccountsInBackground,
  fetchAllQuotas,
});

registerDnsRoutes(app, { sleep });
registerWhoisRoutes(app, {
  logService: (db) => ({
    write: (level: string, source: string, message: string, meta?: unknown) =>
      logService(db).write(level as any, source as any, message, meta),
  }),
});
registerNsRoutes(app, {
  logService: (db) => ({
    write: (level: string, source: string, message: string, meta?: unknown) =>
      logService(db).write(level as any, source as any, message, meta),
  }),
});
registerExpiryRoutes(app, {});
registerRegistrationRoutes(app, {
  fetchAllQuotas,
  logService: (db) => ({
    write: (level: string, source: string, message: string, meta?: unknown) =>
      logService(db).write(level as any, source as any, message, meta),
  }),
  cacheNewlyRegisteredDomain,
});

registerAuthRoutes(app, {
  loginMaxFailures: LOGIN_MAX_FAILURES,
  loginLockWindowSeconds: LOGIN_LOCK_WINDOW_SECONDS,
  loginLockedMessage: LOGIN_LOCKED_MESSAGE,
  capText,
  getClientIp,
  verifyTOTP,
  generateBase32Secret,
  buildOtpAuthUri,
});
registerLogRoutes(app);
registerSettingsRoutes(app, { sendTelegramNotification, sendWebhookNotification });
registerQuotaRoutes(app, { fetchAllQuotas });
registerActionRoutes(app);
registerAuditRoutes(app);
registerSearchRoutes(app);
registerScannerRoutes(app);
registerBackupRoutes(app, {
  loginMaxFailures: LOGIN_MAX_FAILURES,
  loginLockWindowSeconds: LOGIN_LOCK_WINDOW_SECONDS,
  loginLockedMessage: LOGIN_LOCKED_MESSAGE,
  getClientIp,
  verifyTOTP,
});

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(errorRes(err.message, err.code, err.details), err.statusCode as any);
  }
  console.error("Unhandled Exception:", err);
  return c.json(errorRes("服务器内部错误", "internal_error"), 500);
});

app.notFound((c) => {
  return c.json(errorRes(`路径 ${c.req.path} 不存在`, "not_found"), 404);
});

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const res = await app.fetch(request, env, ctx);
    return withSecurityHeaders(res);
  },

  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    const dbManager = new DatabaseManager(env.DB, env.AES_KEY);
    const webhookType = (env.WEBHOOK_TYPE || "custom") as WebhookType;
    ctx.waitUntil(runDailySyncAndRenewal(dbManager, env.WEBHOOK_URL, webhookType, true));
  }
};

// 下游直接 re-export 的模块（不要删除这些行）
export { isRegistrableDomain } from "./punycode";
