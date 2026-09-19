import type { Hono } from "hono";
import type { DatabaseManager } from "../db";
import type { AppEnv } from "./types";
import { errorRes, successRes } from "./response";
import { AccountService } from "../services/account-service";

/** Manual/custom provider group, account and domain management routes. */
export interface CustomGroupRouteDeps {
  accountService: (db: DatabaseManager) => AccountService;
}

export function registerCustomGroupRoutes(app: Hono<AppEnv>, deps: CustomGroupRouteDeps) {
  app.post("/api/custom-groups/batch", async (c) => {
    const dbManager = c.get("db");
    try {
      const body = await c.req.json().catch(() => null);
      const groups = Array.isArray(body?.groups) ? body.groups : null;
      if (!groups || groups.length === 0) {
        return c.json(errorRes("参数缺失：groups 需为至少 1 个分组", "bad_request"), 400);
      }
      if (groups.length > 50) {
        return c.json(errorRes("单次最多批量创建 50 个分组", "bad_request"), 400);
      }

      let successCount = 0;
      let failCount = 0;
      const results: Array<{ alias: string; success: boolean; message: string }> = [];

      for (const g of groups) {
        const alias = String(g?.alias || "").trim();
        if (!alias) {
          failCount++;
          results.push({ alias: "(未填写)", success: false, message: "缺少分组名称" });
          continue;
        }
        try {
          const group = await deps.accountService(dbManager).create(alias, "", "", "custom", String(g?.website || "").trim());
          const accounts = Array.isArray(g?.accounts) ? g.accounts : [];
          let accountCount = 0;
          let domainCount = 0;
          for (const acc of accounts) {
            const accName = String(acc?.name || "").trim();
            if (!accName) continue;
            const accountId = await dbManager.upsertCustomAccount(group.id, accName);
            if (accountId > 0) accountCount++;
            const domains = Array.isArray(acc?.domains) ? acc.domains : [];
            for (const d of domains) {
              const fullDomain = String(d?.full_domain || "").trim().toLowerCase().replace(/\.$/, "");
              const registeredAt = String(d?.registered_at || "").trim();
              const expiresAt = String(d?.expires_at || "").trim();
              const remark = String(d?.remark || "").trim();
              if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(fullDomain)) continue;
              const isPermanent = !expiresAt;
              if (!isPermanent && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(expiresAt)) continue;
              const normalizedExpiry = isPermanent
                ? "0000-00-00 00:00:00"
                : /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)
                  ? `${expiresAt} 23:59:59`
                  : expiresAt;
              const validRegistered = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(registeredAt) ? registeredAt : null;
              if (accountId > 0) {
                await dbManager.upsertCustomDomain(group.id, accountId, fullDomain, normalizedExpiry, remark.slice(0, 200), validRegistered);
                domainCount++;
              }
            }
          }
          successCount++;
          results.push({ alias: group.alias, success: true, message: `已创建，${accountCount} 个账号 / ${domainCount} 个域名` });
        } catch (e: unknown) {
          failCount++;
          results.push({ alias, success: false, message: e instanceof Error ? e.message : "未知错误" });
        }
      }

      return c.json(successRes({ success_count: successCount, fail_count: failCount, results, message: `批量创建完成：成功 ${successCount} 个，失败 ${failCount} 个` }));
    } catch (e: unknown) {
      return c.json(errorRes(`批量创建失败: ${e instanceof Error ? e.message : "未知错误"}`), 400);
    }
  });

  app.get("/api/custom-groups/overview", async (c) => {
    const dbManager = c.get("db");
    try {
      const [accounts, domains] = await Promise.all([
        dbManager.listAllCustomAccounts(),
        dbManager.listAllCustomDomains(),
      ]);
      return c.json(successRes({
        accounts,
        domains: domains.map((d) => ({
          id: d.id, group_id: d.group_id, account_id: d.account_id, full_domain: d.full_domain,
          registered_at: d.registered_at, expires_at: d.expires_at, remark: d.remark,
        })),
      }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 500);
    }
  });

  app.get("/api/custom-groups/:groupId/accounts", async (c) => {
    const dbManager = c.get("db");
    const groupId = parseInt(c.req.param("groupId"), 10);
    if (!Number.isInteger(groupId) || groupId <= 0) return c.json(errorRes("无效的分组 ID", "bad_request"), 400);
    try {
      return c.json(successRes({ accounts: await dbManager.listCustomAccounts(groupId) }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 500);
    }
  });

  app.post("/api/custom-groups/:groupId/accounts", async (c) => {
    const dbManager = c.get("db");
    const groupId = parseInt(c.req.param("groupId"), 10);
    if (!Number.isInteger(groupId) || groupId <= 0) return c.json(errorRes("无效的分组 ID", "bad_request"), 400);
    try {
      const body = await c.req.json().catch(() => null);
      const name = String(body?.name || "").trim();
      if (!name) return c.json(errorRes("参数缺失：账号名称", "bad_request"), 400);
      if (name.length > 100) return c.json(errorRes("账号名称过长（最多 100 字）", "bad_request"), 400);
      const accountId = await dbManager.upsertCustomAccount(groupId, name);
      return c.json(successRes({ account_id: accountId, message: "账号已保存" }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 400);
    }
  });

  app.delete("/api/custom-groups/:groupId/accounts/:accountId", async (c) => {
    const dbManager = c.get("db");
    const accountId = parseInt(c.req.param("accountId"), 10);
    if (!Number.isInteger(accountId) || accountId <= 0) return c.json(errorRes("无效的账号 ID", "bad_request"), 400);
    try {
      await dbManager.deleteCustomAccount(accountId);
      return c.json(successRes({ message: "账号已删除" }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 400);
    }
  });

  app.get("/api/custom-groups/:groupId/domains", async (c) => {
    const dbManager = c.get("db");
    const groupId = parseInt(c.req.param("groupId"), 10);
    if (!Number.isInteger(groupId) || groupId <= 0) return c.json(errorRes("无效的分组 ID", "bad_request"), 400);
    try {
      const all = await dbManager.listAllCustomDomains();
      const domains = all.filter((d) => d.group_id === groupId).map((d) => ({
        id: d.id, group_id: d.group_id, account_id: d.account_id, full_domain: d.full_domain,
        registered_at: d.registered_at, expires_at: d.expires_at, remark: d.remark,
      }));
      return c.json(successRes({ domains }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 500);
    }
  });

  app.post("/api/custom-groups/:groupId/domains", async (c) => {
    const dbManager = c.get("db");
    const groupId = parseInt(c.req.param("groupId"), 10);
    if (!Number.isInteger(groupId) || groupId <= 0) return c.json(errorRes("无效的分组 ID", "bad_request"), 400);
    try {
      const body = await c.req.json().catch(() => null);
      const fullDomain = String(body?.full_domain || "").trim().toLowerCase().replace(/\.$/, "");
      const registeredAt = String(body?.registered_at || "").trim();
      const expiresAt = String(body?.expires_at || "").trim();
      const remark = String(body?.remark || "").trim();
      const accountIdRaw = body?.account_id;
      const accountId = accountIdRaw === undefined || accountIdRaw === null || accountIdRaw === "" ? null : Number(accountIdRaw);
      const idRaw = body?.id;
      const editId = idRaw === undefined || idRaw === null || idRaw === "" ? null : Number(idRaw);

      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(fullDomain)) {
        return c.json(errorRes("域名格式无效，请输入合法的完整域名（如 example.eu.org）", "bad_request"), 400);
      }
      const isPermanent = !expiresAt;
      if (!isPermanent && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(expiresAt)) {
        return c.json(errorRes("到期时间格式无效，请使用 YYYY-MM-DD", "bad_request"), 400);
      }
      if (registeredAt && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(registeredAt)) {
        return c.json(errorRes("注册时间格式无效，请使用 YYYY-MM-DD", "bad_request"), 400);
      }
      if (remark.length > 200) return c.json(errorRes("备注过长（最多 200 字）", "bad_request"), 400);
      if (accountId !== null && (!Number.isInteger(accountId) || accountId <= 0)) return c.json(errorRes("无效的账号 ID", "bad_request"), 400);
      if (editId !== null && (!Number.isInteger(editId) || editId <= 0)) return c.json(errorRes("无效的域名 ID", "bad_request"), 400);

      const normalizedExpiry = isPermanent
        ? "0000-00-00 00:00:00"
        : /^\d{4}-\d{2}-\d{2}$/.test(expiresAt) ? `${expiresAt} 23:59:59` : expiresAt;

      if (editId !== null) {
        const updated = await dbManager.updateCustomDomainById(editId, groupId, fullDomain, normalizedExpiry, remark, registeredAt || null);
        if (!updated) return c.json(errorRes("要修改的域名不存在（可能已被删除）", "not_found"), 404);
        return c.json(successRes({ message: "域名已保存" }));
      }
      await dbManager.upsertCustomDomain(groupId, accountId, fullDomain, normalizedExpiry, remark, registeredAt || null);
      return c.json(successRes({ message: "域名已保存" }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 400);
    }
  });

  app.delete("/api/custom-groups/:groupId/domains/:domainId", async (c) => {
    const dbManager = c.get("db");
    const domainId = parseInt(c.req.param("domainId"), 10);
    if (!Number.isInteger(domainId) || domainId <= 0) return c.json(errorRes("无效的域名 ID", "bad_request"), 400);
    try {
      await dbManager.deleteCustomDomain(domainId);
      return c.json(successRes({ message: "域名已删除" }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 400);
    }
  });
}
