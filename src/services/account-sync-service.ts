import type { DatabaseManager } from "../db";
import { DNSHEClient } from "../dnshe";
import { AccountService } from "./account-service";
import { AccountRepository } from "../repositories/account-repository";
import { syncPlan } from "./sliced-sync-service";
import { summarizeSync } from "./sync-result";

/** Compatibility name, local-only. No waitUntil execution or upstream loop. */
export async function resyncAccountsInBackground(db: DatabaseManager, accountIds: number[], _trigger: "manual" | "auto" = "auto") {
  await syncPlan(db, { manual: true, accountIds: accountIds.slice(0, 50) });
  return summarizeSync(accountIds.slice(0, 50).map(accountId => ({ accountId, status: "partial" as const, total: 0,
    issues: [{ phase: "continuation" as const, message: "请由登录页面调用 sync-step 继续完整同步" }] })));
}
export function sleep(ms: number) { return new Promise<void>(resolve => setTimeout(resolve, ms)); }
export async function cacheNewlyRegisteredDomain(db: DatabaseManager, accountId: number, subdomainId: number | undefined, fullDomain: string) {
  if (subdomainId === undefined) return;
  const { client } = await db.getClientForAccount(accountId);
  if (!(client instanceof DNSHEClient)) throw new Error("仅支持 DNSHE 注册后缓存");
  const sub = (await client.getSubdomain(subdomainId)).subdomain;
  if (!sub || sub.id !== subdomainId || sub.full_domain !== fullDomain) throw new Error("注册后域名身份未确认；请通过分片同步补全，不要重复注册");
  await db.upsertDomain(accountId, sub);
}
export interface DefaultAccountContext { env: { DEFAULT_API_KEY?: string; DEFAULT_API_SECRET?: string; DEFAULT_API_ALIAS?: string } }
export async function ensureDefaultAccount(c: DefaultAccountContext, db: DatabaseManager) {
  const { DEFAULT_API_KEY: key, DEFAULT_API_SECRET: secret } = c.env;
  if (!key || !secret) return;
  const service = new AccountService(new AccountRepository(db));
  if (!(await service.list()).some(a => a.api_key === key)) await service.create(c.env.DEFAULT_API_ALIAS || "默认账号 (环境变量)", key, secret);
  // Binding is not a hidden full synchronization. The page handles later steps.
}
