import type { Context, Hono } from "hono";
import type { AppEnv } from "./types";
import type { AccountProvider, DatabaseManager } from "../db";
import { errorRes, successRes } from "./response";
import { AccountService } from "../services/account-service";
import { AuditService } from "../services/audit-service";
import { AuditRepository } from "../repositories/audit-repository";
import { ActionRepository } from "../repositories/action-repository";
import { ActionService } from "../services/action-service";

export interface AccountRouteDeps {
  normalizeProvider: (provider: unknown) => AccountProvider;
  providerLabels: Record<string, string>;
  ensureDefaultAccount: (c: Context<AppEnv>, db: DatabaseManager) => Promise<void>;
  resyncAccountsInBackground: (db: DatabaseManager, accountIds: number[]) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  accountService: (db: DatabaseManager) => AccountService;
}

// Keep the public route surface stable while moving account-specific business branching out of index.ts.
export function registerAccountRoutes(app: Hono<AppEnv>, deps: AccountRouteDeps) {
  const auditService = (db: DatabaseManager) => new AuditService(new AuditRepository(db));
  const actionService = (db: DatabaseManager) => new ActionService(new ActionRepository(db));

  const queueResync = async (db: DatabaseManager, accountIds: number[], label: string, waitUntil: (promise: Promise<unknown>) => void) => {
    const action = await actionService(db).start("sync", { accountIds, label });
    waitUntil((async () => {
      try {
        await deps.resyncAccountsInBackground(db, accountIds);
        await actionService(db).complete(action.id);
      } catch (error) {
        await actionService(db).fail(action.id, error instanceof Error ? error.message : String(error));
      }
    })());
  };
  app.get("/api/accounts", async (c) => {
    const db = c.get("db");
    try {
      await deps.ensureDefaultAccount(c, db);
      return c.json(successRes({ accounts: await deps.accountService(db).list() }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 500);
    }
  });

  app.post("/api/accounts", async (c) => {
    const db = c.get("db");
    try {
      const body = await c.req.json();
      const provider = deps.normalizeProvider(body.provider);
      const { alias, api_key, api_secret, api_token, website } = body;
      const service = deps.accountService(db);
      let account;

      if (provider === "custom") {
        if (!String(alias || "").trim()) return c.json(errorRes("参数缺失：alias 为必填项（自定义服务商分组名称）", "bad_request"), 400);
        account = await service.create(String(alias).trim(), "", "", "custom", String(website || "").trim());
      } else if (provider === "cloudflare") {
        if (!api_token) return c.json(errorRes("参数缺失：api_token 为必填项（Cloudflare API Token，alias 可选，留空将自动解析）", "bad_request"), 400);
        account = await service.create(String(alias || "").trim(), "", String(api_token).trim(), "cloudflare");
      } else if (provider === "digitalplat") {
        if (!api_key) return c.json(errorRes("参数缺失：api_key 为必填项（DigitalPlat API Key，dp_live_ / dp_test_ 开头，alias 可选）", "bad_request"), 400);
        account = await service.create(String(alias || "").trim(), "", String(api_key).trim(), "digitalplat");
      } else if (["dnspod", "alidns", "huaweicloud"].includes(provider)) {
        if (!api_key || !api_secret) return c.json(errorRes("参数缺失：api_key 与 api_secret 均为必填项，alias 可选", "bad_request"), 400);
        account = await service.create(String(alias || "").trim(), String(api_key).trim(), String(api_secret).trim(), provider);
      } else if (provider === "vercel") {
        if (!api_token) return c.json(errorRes("参数缺失：api_token 为必填项（Vercel Access Token，alias 可选，留空将自动解析）", "bad_request"), 400);
        account = await service.create(String(alias || "").trim(), "", String(api_token).trim(), "vercel");
      } else {
        if (!api_key || !api_secret) return c.json(errorRes("参数缺失：api_key, api_secret 为必填项（alias 可选，留空将自动解析）", "bad_request"), 400);
        account = await service.create(String(alias || "").trim(), String(api_key), String(api_secret));
      }

      if (account?.id) {
        await auditService(db).write({ actor: "session", action: "create", resourceType: "account", resourceId: String(account.id), provider, result: "success", details: { alias: account.alias } });
        await queueResync(db, [account.id], `账号 [${account.alias}] 同步`, (promise) => c.executionCtx.waitUntil(promise));
      }
      return c.json(successRes({ account }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 400);
    }
  });

  app.post("/api/accounts/batch", async (c) => {
    const db = c.get("db");
    try {
      const body = await c.req.json().catch(() => ({}));
      const provider = deps.normalizeProvider(body.provider);
      const singleCredential: readonly AccountProvider[] = ["cloudflare", "digitalplat", "vercel", "dnshe"];
      const isSingleCredential = singleCredential.includes(provider) && provider !== "dnshe";
      const providerLabel = deps.providerLabels[provider] || provider;
      const items = Array.isArray(body.accounts) ? body.accounts : [];
      if (!items.length) return c.json(errorRes(isSingleCredential ? `请至少提供一条账号信息（${provider === "vercel" ? "api_token" : "api_key"}）` : "请至少提供一条账号信息（api_key + api_secret）", "bad_request"), 400);
      if (items.length > 50) return c.json(errorRes("单次最多批量绑定 50 个账号", "bad_request"), 400);
      if (provider === "custom") return c.json(errorRes("自定义分组不支持批量绑定，请逐个创建", "bad_request"), 400);

      const results: Array<{ api_key: string; alias?: string; success: boolean; message: string }> = [];
      const newAccountIds: number[] = [];
      let successCount = 0;
      let failCount = 0;
      const service = deps.accountService(db);

      for (const item of items) {
        const alias = String(item?.alias || "").trim();
        let apiKey = "";
        let apiSecret = "";
        let credential = "";
        let mask = "(未填写)";
        let errorMessage = "";
        if (provider === "cloudflare" || provider === "vercel") {
          credential = String(item?.api_token || "").trim();
          apiSecret = credential;
          mask = credential ? `${credential.slice(0, 4)}***` : "(未填写)";
          errorMessage = provider === "cloudflare" ? "缺少 Cloudflare API Token" : "缺少 Vercel Access Token";
        } else if (provider === "digitalplat") {
          credential = String(item?.api_key || "").trim();
          apiSecret = credential;
          mask = credential ? `${credential.slice(0, 8)}***` : "(未填写)";
          errorMessage = "缺少 DigitalPlat API Key";
        } else {
          apiKey = String(item?.api_key || "").trim();
          apiSecret = String(item?.api_secret || "").trim();
          credential = apiKey;
          mask = apiKey ? `${apiKey.slice(0, 4)}***` : "(未填写)";
          errorMessage = provider === "dnshe" ? "缺少 API Key 或 API Secret" : `缺少 ${providerLabel} 的 AccessKey ID 或 Secret`;
        }

        if ((provider === "cloudflare" || provider === "digitalplat" || provider === "vercel") ? !credential : (!apiKey || !apiSecret)) {
          failCount++;
          results.push({ api_key: mask, success: false, message: errorMessage });
          continue;
        }

        try {
          const account = await service.create(alias, apiKey, apiSecret, provider === "cloudflare" || provider === "digitalplat" || provider === "vercel" ? provider : provider);
          newAccountIds.push(account.id);
          successCount++;
          results.push({ api_key: mask, alias: account.alias, success: true, message: "绑定成功" });
        } catch (e: unknown) {
          failCount++;
          results.push({ api_key: mask, success: false, message: e instanceof Error ? e.message : "未知错误" });
        }
        await deps.sleep(800);
      }

      if (newAccountIds.length) {
        await auditService(db).write({ actor: "session", action: "batch_create", resourceType: "account", result: failCount === 0 ? "success" : "failure", details: { provider, accountIds: newAccountIds, successCount, failCount } });
        await queueResync(db, newAccountIds, `批量账号同步 ${newAccountIds.length} 个`, (promise) => c.executionCtx.waitUntil(promise));
      }
      return c.json(successRes({
        success_count: successCount,
        fail_count: failCount,
        results,
        account_ids: newAccountIds,
        message: `批量绑定完成：成功 ${successCount} 个，失败 ${failCount} 个，域名同步已在后台进行中`,
      }));
    } catch (e: unknown) {
      return c.json(errorRes(`批量绑定失败: ${e instanceof Error ? e.message : "未知错误"}`), 400);
    }
  });

  app.put("/api/accounts/:id", async (c) => {
    const db = c.get("db");
    const id = parseInt(c.req.param("id"), 10);
    try {
      const body = await c.req.json().catch(() => ({}));
      const alias = String(body.alias || "");
      const apiKey = body.api_key !== undefined ? String(body.api_key) : undefined;
      const apiToken = body.api_token !== undefined ? String(body.api_token).trim() : undefined;
      const apiSecret = body.api_secret !== undefined ? String(body.api_secret) : undefined;
      const account = await deps.accountService(db).update(id, alias, apiKey, apiToken ?? apiSecret);
      const credentialsChanged = Boolean(apiToken) || Boolean(apiKey && apiSecret);
      if (credentialsChanged) await queueResync(db, [account.id], `账号 [${account.alias}] 凭据同步`, (promise) => c.executionCtx.waitUntil(promise));
      else await db.renameAccountInQuotaCache(account.id, account.alias);
      await auditService(db).write({ actor: "session", action: "update", resourceType: "account", resourceId: String(account.id), result: "success", details: { alias: account.alias, credentialsChanged } });
      return c.json(successRes({ account, message: "账号信息已更新" }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 400);
    }
  });

  app.delete("/api/accounts/:id", async (c) => {
    const db = c.get("db");
    const id = parseInt(c.req.param("id"), 10);
    try {
      await db.removeAccountFromQuotaCache(id);
      await deps.accountService(db).remove(id);
      await auditService(db).write({ actor: "session", action: "delete", resourceType: "account", resourceId: String(id), result: "success" });
      return c.json(successRes({ message: "账户解绑成功" }));
    } catch (e: unknown) {
      return c.json(errorRes(e instanceof Error ? e.message : "未知错误"), 400);
    }
  });
}
