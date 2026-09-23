import type { Hono } from "hono";
import type { AppEnv } from "./types";
import type { AccountProvider } from "../db";
import { DatabaseManager, QUOTA_CACHE_KEY } from "../db";
import type { WebhookType } from "../cron";
import { runDailySyncAndRenewal } from "../cron";
import { toASCII } from "../punycode";
import { AccountRepository } from "../repositories/account-repository";
import { DomainRepository } from "../repositories/domain-repository";
import { LogRepository } from "../repositories/log-repository";
import { AccountService } from "../services/account-service";
import { DomainService } from "../services/domain-service";
import { LogService } from "../services/log-service";
import { AuditService } from "../services/audit-service";
import { AuditRepository } from "../repositories/audit-repository";
import { successRes, errorRes } from "./response";
import { UNDELETABLE_STATUS, translateDeleteError } from "../services/domain-operations";
import { createDomainProviderAdapter } from "../providers/adapters";
import { detectDnsProvider } from "../dns-provider";

function accountService(db: DatabaseManager) { return new AccountService(new AccountRepository(db)); }
function domainService(db: DatabaseManager) { return new DomainService(new DomainRepository(db)); }
function logService(db: DatabaseManager) { return new LogService(new LogRepository(db)); }
function auditService(db: DatabaseManager) { return new AuditService(new AuditRepository(db)); }

export interface DomainRouteDeps {
  resyncAccountsInBackground: (db: DatabaseManager, accountIds: number[], trigger?: "manual" | "auto") => Promise<void>;
  fetchAllQuotas: (db: DatabaseManager) => Promise<{ accounts: Array<{ id: number; alias: string }>; quotas: unknown[] }>;
}

export function registerDomainRoutes(app: Hono<AppEnv>, deps: DomainRouteDeps) {
  /**
   * 域名管理 API
   */

  // 1. 跨账号列出所有域名
  //
  // NOTE: provider 查询参数 —— 传某个托管商名时只返回该托管商账号的行（各自的独立标签页
  // 使用）；缺省时排除这些行，DNSHE 域名页的数据结构保持不变。
  // 白名单校验：不在允许集合里的值（含拼写错误）一律当作未传，走 DNSHE 默认分支。
  const DOMAIN_PROVIDER_FILTERS: readonly AccountProvider[] = [
    "cloudflare",
    "digitalplat",
    "dnspod",
    "alidns",
    "huaweicloud",
    "vercel",
    "dnshe",
  ];

  app.get("/api/domains", async (c) => {
    const dbManager = c.get("db");
    const search = c.req.query("search") || "";
    const status = c.req.query("status") || "";
    const accountIdStr = c.req.query("account_id");
    const accountId = accountIdStr ? parseInt(accountIdStr, 10) : undefined;
    const providerParam = String(c.req.query("provider") || "").trim().toLowerCase();
    const provider = (DOMAIN_PROVIDER_FILTERS as readonly string[]).includes(providerParam)
      ? (providerParam as AccountProvider)
      : undefined;

    try {
      const domains = await domainService(dbManager).list(search, status, accountId, provider);
      return c.json(successRes({ domains }));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "未知错误";
      return c.json(errorRes(message), 500);
    }
  });

  /**
   * 1.5 在指定云服务商账号中添加/托管新域名（支持主域与子域）
   */
  app.post("/api/domains", async (c) => {
    const dbManager = c.get("db");
    try {
      const body = await c.req.json().catch(() => ({}));
      const accountId = Number(body?.account_id);
      const rawDomain = String(body?.domain || "").trim();
      if (!accountId || !rawDomain) {
        return c.json(errorRes("必须提供 account_id 和 domain", "bad_request"), 400);
      }

      const domainName = toASCII(rawDomain.toLowerCase().replace(/\.+$/, ""));
      if (!domainName) {
        return c.json(errorRes("域名格式不正确", "bad_request"), 400);
      }

      const { client, alias, provider } = await dbManager.getClientForAccount(accountId);
      const adapter = createDomainProviderAdapter(provider, client);

      if (!adapter.createDomain) {
        return c.json(errorRes(`${adapter.label} 暂不支持在面板中直接添加域名`, "not_supported"), 400);
      }

      const result = await adapter.createDomain(domainName);
      if (!result.success || !result.data?.domain) {
        if (result.need_txt_verify) {
          return c.json({
            success: false,
            error_code: "need_txt_verify",
            message: result.message || "添加该子域名需先在主域名原 DNS 处完成 TXT 授权校验",
            need_txt_verify: true,
            verify_info: result.verify_info,
          }, 400);
        }
        return c.json(errorRes(result.message || "添加域名失败"), 400);
      }

      const createdUpstream = result.data.domain;
      // 立即写入数据库缓存，无需等待定时同步
      await dbManager.upsertAccountDomains(accountId, [createdUpstream]);

      // 获取入库后的 Domain 实体以提供前端直接跳转解析所需的 domain_id
      const domainRepo = new DomainRepository(dbManager);
      const matched = await domainRepo.list(domainName, undefined, accountId);
      const insertedDomain = matched.find(
        (d) => d.full_domain.toLowerCase() === domainName.toLowerCase() || d.domain.toLowerCase() === domainName.toLowerCase()
      ) || matched[0];

      const nsList = result.data.nameservers || [];
      const msg = `已成功在 [${alias}] (${adapter.label}) 下添加域名 [${domainName}]！`;
      await logService(dbManager).write("success", "api", msg, { domain: domainName, nameservers: nsList });
      await auditService(dbManager).write({
        actor: "session",
        action: "create",
        resourceType: "domain",
        resourceId: String(createdUpstream.id),
        provider,
        result: "success",
        details: { domain: domainName, nameservers: nsList },
      });

      return c.json(
        successRes({
          message: msg,
          domain: createdUpstream,
          domain_id: insertedDomain?.id,
          nameservers: nsList,
        })
      );
    } catch (e: unknown) {
      if (typeof e === "object" && e !== null && "verifyInfo" in e) {
        const verifyError = e as { message: string; verifyInfo: unknown };
        return c.json({
          success: false,
          error_code: "need_txt_verify",
          message: verifyError.message,
          need_txt_verify: true,
          verify_info: verifyError.verifyInfo,
        }, 400);
      }
      const message = e instanceof Error ? e.message : "添加域名发生错误";
      return c.json(errorRes(message), 400);
    }
  });

  // 2. 立即全量同步所有账号的域名
  app.post("/api/domains/sync", async (c) => {
    const dbManager = c.get("db");
    try {
      // 异步执行同步以防止 HTTP 响应超时 (Cloudflare Worker 允许在 waitUntil 里跑异步)
      const webhookType = (c.env.WEBHOOK_TYPE || "custom") as WebhookType;
      c.executionCtx.waitUntil(runDailySyncAndRenewal(dbManager, c.env.WEBHOOK_URL, webhookType));
      return c.json(successRes({ message: "域名同步后台任务已启动，请稍后刷新查看最新数据" }));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "未知错误";
      return c.json(errorRes(message), 500);
    }
  });

  /**
   * 2.1 单账号同步：只同步指定账号的域名，不触发全局续期/通知流程
   *
   * NOTE: 单账号同步的子请求数远小于全量同步，在免费计划 50 次配额下也能完成，
   * 是规避 "Too many subrequests" 的最佳实践。复用 resyncAccountsInBackground
   * 的逐账号深度同步逻辑（含 DNS 记录拉取与状态计算）。
   */
  app.post("/api/accounts/:id/sync", async (c) => {
    const dbManager = c.get("db");
    const accountId = parseInt(c.req.param("id"), 10);
    if (isNaN(accountId)) {
      return c.json(errorRes("无效的账号 ID"), 400);
    }
    try {
      const { provider } = await dbManager.getClientForAccount(accountId);
      if (provider === "custom") {
        return c.json(successRes({ message: "自定义分组无需同步（手动管理域名）" }));
      }
      c.executionCtx.waitUntil(deps.resyncAccountsInBackground(dbManager, [accountId], "manual"));
      return c.json(successRes({ message: "该账号的域名同步已在后台启动，请稍后刷新" }));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "未知错误";
      return c.json(errorRes(message), 500);
    }
  });

  /**
   * 2.2 按服务商同步：只同步指定 provider 下的全部账号
   *
   * WHY 需要这个接口：CF / DP 页面上的「同步」按钮原先都调 /api/domains/sync（全量同步
   * 所有账号），与按钮所在页面的语义不符 —— 用户在 CF 页点同步，期望的是「只刷 CF」。
   * 全量同步在免费计划下还容易撞 50 次子请求上限，把本来只需 1~2 次子请求的操作放大成
   * 一次高危操作。
   *
   * NOTE: provider 必须走白名单校验 —— 这个值会参与账号筛选，虽然 getAccounts(provider)
   * 走的是绑定参数不会注入，但放任意字符串进来会让接口语义变得不可预期（比如传 "custom"
   * 应当被明确拒绝，而不是静默同步 0 个账号后回一句「已启动」）。
   */
  const SYNCABLE_PROVIDERS = [
    "dnshe",
    "cloudflare",
    "digitalplat",
    "dnspod",
    "alidns",
    "huaweicloud",
    "vercel",
  ] as const;

  app.post("/api/providers/:provider/sync", async (c) => {
    const dbManager = c.get("db");
    const provider = String(c.req.param("provider") || "").trim().toLowerCase();

    if (provider === "custom") {
      return c.json(successRes({ message: "自定义分组无需同步（手动管理域名）" }));
    }
    if (!(SYNCABLE_PROVIDERS as readonly string[]).includes(provider)) {
      return c.json(
        errorRes(`不支持的服务商类型：${provider}（可选：${SYNCABLE_PROVIDERS.join(" / ")}）`, "bad_provider"),
        400
      );
    }

    try {
      const accounts = await accountService(dbManager).list(provider as (typeof SYNCABLE_PROVIDERS)[number]);
      if (accounts.length === 0) {
        return c.json(successRes({ message: `没有绑定任何 ${provider} 账号，无需同步` }));
      }
      const ids = accounts.map((a) => a.id);
      c.executionCtx.waitUntil(deps.resyncAccountsInBackground(dbManager, ids, "manual"));
      return c.json(
        successRes({
          message: `${provider} 的 ${ids.length} 个账号同步已在后台启动，请稍后刷新`,
          count: ids.length
        })
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "未知错误";
      return c.json(errorRes(message), 500);
    }
  });

  // 3. 手动续期子域名
  app.post("/api/domains/:id/renew", async (c) => {
    const dbManager = c.get("db");
    const domainId = parseInt(c.req.param("id"), 10);
    try {
      const domainInfo = await domainService(dbManager).get(domainId);
      if (!domainInfo) return c.json(errorRes("未在缓存中找到该域名的记录，请先同步数据", "not_found"), 404);

      const { client, alias, provider } = await dbManager.getClientForAccount(domainInfo.account_id);
      const adapter = createDomainProviderAdapter(provider, client);
      const result = await adapter.renew(domainInfo);
      if (!result.success) return c.json(errorRes(result.message || "续期失败", "not_supported"), 400);

      const newExpiresAt = result.data?.newExpiresAt || "";
      await domainService(dbManager).markRenewed(domainId, newExpiresAt);
      await logService(dbManager).write("success", "api", `域名 [${domainInfo.full_domain}] (账户: ${alias}) 手动续期成功！新有效期至: ${newExpiresAt}`, result.data);
      await auditService(dbManager).write({ actor: "session", action: "renew", resourceType: "domain", resourceId: String(domainId), provider, result: "success", details: result.data });
      try {
        const { accounts, quotas } = await deps.fetchAllQuotas(dbManager);
        if (accounts.length > 0) await dbManager.setCache(QUOTA_CACHE_KEY, JSON.stringify(quotas));
      } catch (e) {
        console.error("续期后刷新配额缓存失败:", e);
      }
      return c.json(successRes({ message: "续期成功", new_expires_at: newExpiresAt }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 400);
    }
  });

  /**
   * 3.5 删除子域名 (代理接口)
   *
   * ⚠️ 上游对删除有硬限制，以下情形一律拒绝，且限制不可绕过：
   *   1. 域名存在 DNS 解析记录历史；
   *   2. 域名处于「转赠 / ServerHold / PendingDelete」等特殊状态。
   *
   * 因此这里做两道防线：
   *   - 事前拦截：先查状态与解析记录，命中限制直接返回可读原因，不浪费上游调用；
   *   - 事后兜底：上游仍拒绝时，把它的英文错误翻译成中文原因回传前端。
   *
   * 需前端传入 confirm_domain（完整域名）二次确认，防止误删。
   */

  app.post("/api/domains/:id/delete", async (c) => {
    const dbManager = c.get("db");
    const domainId = parseInt(c.req.param("id"), 10);
    if (!Number.isInteger(domainId) || domainId <= 0) return c.json(errorRes("无效的域名 ID", "bad_request"), 400);

    try {
      let confirmDomain = "";
      try {
        const body = await c.req.json();
        confirmDomain = String(body?.confirm_domain || "").trim();
      } catch {
        // Empty body is handled uniformly by the confirmation check below.
      }

      const domainInfo = await domainService(dbManager).get(domainId);
      if (!domainInfo) return c.json(errorRes("未在缓存中找到该域名的记录，请先同步数据", "not_found"), 404);

      const expected = domainInfo.full_domain.toLowerCase();
      const got = toASCII(confirmDomain).toLowerCase();
      if (!got || (got !== expected && confirmDomain.toLowerCase() !== expected)) {
        return c.json(errorRes("删除前必须输入完整域名进行确认", "confirm_required"), 400);
      }

      const { client, alias, provider } = await dbManager.getClientForAccount(domainInfo.account_id);
      const adapter = createDomainProviderAdapter(provider, client);

      // DNSHE retains a provider-specific business rule: a domain with live DNS records
      // cannot be deleted. The adapter owns provider calls; the route only enforces the rule.
      if (provider === "dnshe") {
        try {
          const dnsResult = await adapter.listDnsRecords(domainInfo);
          const records = dnsResult.data?.records || [];
          if (dnsResult.success && records.length > 0) {
            return c.json(errorRes(`该域名存在 ${records.length} 条 DNS 解析记录，存在解析记录历史的域名不支持删除。请先删除全部解析记录后重试（若仍失败则说明上游保留了历史记录，无法删除）`, "delete_forbidden"), 409);
          }
        } catch (e) {
          console.error("删除前检查 DNS 记录失败，转由上游裁决:", e);
        }
      }

      const statusKey = String(domainInfo.status || "").toLowerCase().replace(/[\s_-]/g, "");
      if (provider === "dnshe") {
        for (const [bad, reason] of Object.entries(UNDELETABLE_STATUS)) {
          if (statusKey.includes(bad)) return c.json(errorRes(`${reason}，不支持删除操作`, "delete_forbidden"), 409);
        }
      }

      const result = await adapter.delete(domainInfo);
      if (result.success) {
        if (result.data?.pendingDelete) {
          await dbManager.deleteCache(`api_cache:dns:${domainId}`);
          await dbManager.updateDomainStatusAndDns(domainId, "pendingdelete", 0, domainInfo.dns_provider || "DigitalPlat");
          await logService(dbManager).write("warning", "operation", `域名 [${domainInfo.full_domain}] (账户: ${alias}) 已在 DigitalPlat 提交删除，进入 pendingdelete（DNS 已停用，7 天后正式释放）`);
          await auditService(dbManager).write({ actor: "session", action: "delete", resourceType: "domain", resourceId: String(domainId), provider, result: "success", details: { pendingDelete: true } });
          return c.json(successRes({ message: "域名已提交删除，进入 pendingdelete 状态（DNS 已停用，7 天后正式释放）", full_domain: domainInfo.full_domain }));
        }

        await domainService(dbManager).remove(domainId);
        await dbManager.deleteCache(`api_cache:dns:${domainId}`);
        await logService(dbManager).write("warning", "operation", `域名 [${domainInfo.full_domain}] (账户: ${alias}) 已删除`, result);
        await auditService(dbManager).write({ actor: "session", action: "delete", resourceType: "domain", resourceId: String(domainId), provider, result: "success" });
        try {
          const { accounts, quotas } = await deps.fetchAllQuotas(dbManager);
          if (accounts.length > 0) await dbManager.setCache(QUOTA_CACHE_KEY, JSON.stringify(quotas));
        } catch (e) {
          console.error("删除后刷新配额缓存失败:", e);
        }
        return c.json(successRes({ message: "域名删除成功", full_domain: domainInfo.full_domain }));
      }

      const reason = translateDeleteError(result.message || "");
      await logService(dbManager).write("error", "operation", `域名 [${domainInfo.full_domain}] 删除失败：${reason}`, result);
      await auditService(dbManager).write({ actor: "session", action: "delete", resourceType: "domain", resourceId: String(domainId), provider, result: "failure", details: { reason } });
      return c.json(errorRes(reason, "delete_forbidden"), 409);
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : "未知错误";
      return c.json(errorRes(translateDeleteError(raw)), 400);
    }
  });

  // 3.5b DigitalPlat：查询域名当前 NS 列表
  app.get("/api/domains/:id/nameservers", async (c) => {
    const dbManager = c.get("db");
    const domainId = parseInt(c.req.param("id"), 10);
    if (!Number.isInteger(domainId) || domainId <= 0) return c.json(errorRes("无效的域名 ID", "bad_request"), 400);
    try {
      const domainInfo = await domainService(dbManager).get(domainId);
      if (!domainInfo) return c.json(errorRes("未在缓存中找到该域名的记录，请先同步数据", "not_found"), 404);
      const { client, provider } = await dbManager.getClientForAccount(domainInfo.account_id);
      const adapter = createDomainProviderAdapter(provider, client);
      const remoteId = String(domainInfo.remote_id || domainInfo.full_domain);
      const DP_NS_CACHE_TTL_S = 600;
      const cacheKey = `dp_ns:${remoteId}`;
      const syncKey = `dp_ns_sync:${remoteId}`;
      if (c.req.query("refresh") !== "1") {
        const cached = await dbManager.getCache(cacheKey);
        if (cached) {
          try { const cachedNs = JSON.parse(cached) as string[]; if (Array.isArray(cachedNs)) return c.json(successRes({ nameservers: cachedNs })); } catch {}
        }
        const snapshot = await dbManager.getCache(syncKey);
        if (snapshot) {
          try { const snapNs = JSON.parse(snapshot) as string[]; if (Array.isArray(snapNs)) return c.json(successRes({ nameservers: snapNs })); } catch {}
        }
      }
      const result = await adapter.getNameservers(domainInfo);
      if (!result.success || !result.data) return c.json(errorRes(result.message || "仅 DigitalPlat 域名支持在此查询 NS", "not_supported"), 400);
      const nameservers = result.data.nameservers;
      await dbManager.setCache(cacheKey, JSON.stringify(nameservers), DP_NS_CACHE_TTL_S);
      await dbManager.setCache(syncKey, JSON.stringify(nameservers));
      return c.json(successRes({ nameservers }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 400);
    }
  });

  // 3.5c DigitalPlat：整组替换域名 NS
  app.put("/api/domains/:id/nameservers", async (c) => {
    const dbManager = c.get("db");
    const domainId = parseInt(c.req.param("id"), 10);
    if (!Number.isInteger(domainId) || domainId <= 0) return c.json(errorRes("无效的域名 ID", "bad_request"), 400);
    try {
      const body = await c.req.json().catch(() => null);
      const raw = Array.isArray(body?.nameservers) ? body.nameservers : null;
      if (!raw || raw.length === 0) return c.json(errorRes("参数缺失：nameservers 需为至少 1 条 NS 主机名的数组", "bad_request"), 400);
      const seen = new Set<string>();
      const nameservers: string[] = [];
      for (const item of raw) {
        const ns = String(item || "").trim().toLowerCase().replace(/\.$/, "");
        if (!ns) continue;
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(ns)) return c.json(errorRes(`NS 主机名格式无效：${ns}`, "bad_request"), 400);
        if (!seen.has(ns)) { seen.add(ns); nameservers.push(ns); }
      }
      if (nameservers.length === 0) return c.json(errorRes("nameservers 内容无效：至少需要 1 条合法 NS 主机名", "bad_request"), 400);

      const domainInfo = await domainService(dbManager).get(domainId);
      if (!domainInfo) return c.json(errorRes("未在缓存中找到该域名的记录，请先同步数据", "not_found"), 404);
      if (/pendingdelete/i.test(String(domainInfo.status || ""))) return c.json(errorRes("该域名处于 pendingdelete（待删除）状态，不允许修改 NS", "forbidden"), 409);

      const { client, alias, provider } = await dbManager.getClientForAccount(domainInfo.account_id);
      const adapter = createDomainProviderAdapter(provider, client);
      const result = await adapter.updateNameservers(domainInfo, nameservers);
      if (!result.success) return c.json(errorRes(result.message || "仅 DigitalPlat 域名支持在此修改 NS", "not_supported"), 400);

      const remoteId = String(domainInfo.remote_id || domainInfo.full_domain);
      await dbManager.setCache(`dp_ns:${remoteId}`, JSON.stringify(nameservers), 600);
      await dbManager.setCache(`dp_ns_sync:${remoteId}`, JSON.stringify(nameservers));
      const dnsProvider = detectDnsProvider(nameservers);
      const hostedHere = dnsProvider === "DigitalPlat";
      await dbManager.updateDomainStatusAndDns(domainId, String(domainInfo.status || "ok"), hostedHere ? 1 : 0, dnsProvider);
      await logService(dbManager).write("warning", "operation", `域名 [${domainInfo.full_domain}] (账户: ${alias}) NS 已修改为: ${nameservers.join(", ")}`);
      await auditService(dbManager).write({ actor: "session", action: "update", resourceType: "domain_nameservers", resourceId: String(domainId), provider, result: "success", details: { nameservers } });
      return c.json(successRes({ message: `NS 已修改为 ${nameservers.join(" / ")}（解析生效通常需要数分钟到数小时）`, nameservers, dns_provider: dnsProvider, has_dns: hostedHere ? 1 : 0 }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 400);
    }
  });

  // 3.5d Cloudflare zone 日期手动覆盖：RDAP/WHOIS 查不到的域名由用户录入注册/到期时间与
  // 来源，随账号存后端（domain_date_overrides 表，多设备共享）；前端手动值优先于自动查询，
  // 且自动查询（GET /api/expiry）不回写这些域名。
  app.get("/api/date-overrides", async (c) => {
    const dbManager = c.get("db");
    try {
      const overrides = await dbManager.getDateOverrides();
      return c.json(successRes({ overrides }));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "未知错误";
      return c.json(errorRes(message), 500);
    }
  });

  app.put("/api/domains/:id/date-override", async (c) => {
    const dbManager = c.get("db");
    const domainId = parseInt(c.req.param("id"), 10);
    if (!Number.isInteger(domainId) || domainId <= 0) {
      return c.json(errorRes("无效的域名 ID", "bad_request"), 400);
    }
    try {
      const body = await c.req.json().catch(() => null);
      const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
      const registered = clean(body?.registered_at);
      const expiry = clean(body?.expires_at);
      const source = clean(body?.source);
      for (const [label, value] of [["registered_at", registered], ["expires_at", expiry]] as const) {
        if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          return c.json(errorRes(`${label} 格式无效：应为 YYYY-MM-DD`, "bad_request"), 400);
        }
      }
      if (source.length > 80) {
        return c.json(errorRes("注册来源最长 80 字符", "bad_request"), 400);
      }
      if (!registered && !expiry && !source) {
        return c.json(errorRes("请至少填写 注册时间 / 到期时间 / 来源 之一；全部清除请用恢复自动查询", "bad_request"), 400);
      }

      const domainInfo = await domainService(dbManager).get(domainId);
      if (!domainInfo) {
        return c.json(errorRes("未在缓存中找到该域名的记录，请先同步数据", "not_found"), 404);
      }
      const { provider } = await dbManager.getClientForAccount(domainInfo.account_id);
      if (provider !== "cloudflare") {
        return c.json(errorRes("仅 Cloudflare 托管 zone 支持日期手动覆盖", "not_supported"), 400);
      }
      await dbManager.upsertDateOverride(domainInfo.account_id, domainInfo.full_domain, {
        registered_at: registered || null,
        expires_at: expiry || null,
        source: source || null
      });
      await logService(dbManager).write("info", "operation", `域名 [${domainInfo.full_domain}] 日期手动覆盖已保存`);
      await auditService(dbManager).write({ actor: "session", action: "update", resourceType: "domain_date_override", resourceId: String(domainId), provider, result: "success", details: { registered_at: registered || null, expires_at: expiry || null, source: source || null } });
      return c.json(successRes({ message: "手动覆盖已保存，将随账号同步" }));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "未知错误";
      return c.json(errorRes(message), 400);
    }
  });

  app.delete("/api/domains/:id/date-override", async (c) => {
    const dbManager = c.get("db");
    const domainId = parseInt(c.req.param("id"), 10);
    if (!Number.isInteger(domainId) || domainId <= 0) {
      return c.json(errorRes("无效的域名 ID", "bad_request"), 400);
    }
    try {
      const domainInfo = await domainService(dbManager).get(domainId);
      if (!domainInfo) {
        return c.json(errorRes("未在缓存中找到该域名的记录", "not_found"), 404);
      }
      const { provider } = await dbManager.getClientForAccount(domainInfo.account_id);
      if (provider !== "cloudflare") {
        return c.json(errorRes("仅 Cloudflare 托管 zone 支持日期手动覆盖", "not_supported"), 400);
      }
      await dbManager.deleteDateOverride(domainInfo.account_id, domainInfo.full_domain);
      await logService(dbManager).write("info", "operation", `域名 [${domainInfo.full_domain}] 日期手动覆盖已清除`);
      await auditService(dbManager).write({ actor: "session", action: "delete", resourceType: "domain_date_override", resourceId: String(domainId), provider, result: "success" });
      return c.json(successRes({ message: "已清除手动覆盖，恢复自动查询" }));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "未知错误";
      return c.json(errorRes(message), 400);
    }
  });

}
