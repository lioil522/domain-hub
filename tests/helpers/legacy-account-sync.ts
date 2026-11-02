// Historical regression fixture ONLY. Not imported by production bundles.
import type { DatabaseManager, UpstreamSubdomain } from "../../src/db";
import { syncPlan } from "../../src/services/sliced-sync-service";
import { DNSHEClient } from "../../src/dnshe";
import { CloudflareClient } from "../../src/cloudflare";
import { HuaweiCloudClient } from "../../src/huaweicloud";
import { DigitalPlatClient, mapDomainToUpstream } from "../../src/digitalplat";
import { fetchAllSubdomainsFromClient, listUpstreamDomains, PARSE_ONLY_PROVIDERS } from "../../src/cron";
import { syncCloudflareZoneBatch } from "../../src/services/cloudflare-sync";
import { requireCompleteDnsRecords } from "../../src/services/dns-snapshot";
import { batchedPromiseAll } from "../../src/cron/utils";
import { computeDnsState } from "../../src/dns-provider";
import type { DnsState } from "../../src/dns-provider";
import { AccountService } from "../../src/services/account-service";
import { LogService } from "../../src/services/log-service";
import { LogRepository } from "../../src/repositories/log-repository";
import { AccountRepository } from "../../src/repositories/account-repository";
import { CacheService } from "../../src/cache/cache";
import { CACHE_KEYS } from "../../src/cache";
import { createDomainProviderAdapter } from "../../src/providers/adapters";
import { IncompleteSyncError, requireCompletedSync, summarizeSync, syncIssue, type AccountSyncResult, type SyncSummary, type SyncIssue } from "../../src/services/sync-result";

function logService(db: DatabaseManager): LogService {
  return new LogService(new LogRepository(db));
}

function accountService(db: DatabaseManager): AccountService {
  return new AccountService(new AccountRepository(db));
}

function cacheService(db: DatabaseManager): CacheService {
  return new CacheService(db);
}
export async function syncCloudflareZones(dbManager: DatabaseManager, accountId: number, client: CloudflareClient): Promise<number> {
  const result = await syncCloudflareZoneBatch(dbManager, accountId, client);
  if (!result.completed) throw new IncompleteSyncError(summarizeSync([{
    accountId, status: "partial", total: result.total, nextPage: result.nextPage,
    issues: [{ phase: "continuation", message: `该账号 zone 数量较多，已同步 ${result.total} 个，请再次点击「同步」从第 ${result.nextPage} 页继续拉取` }],
  }]));
  return result.total;
}

// NOTE: 深度同步 DigitalPlat 账号的域名列表。列表自带注册商侧到期时间，无需查 RDAP；
// 托管商由返回的 NS 推导（digitalplat.org → DigitalPlat 托管，其余按通用规则识别）。
export async function syncDigitalPlatDomains(dbManager: DatabaseManager, accountId: number, client: DigitalPlatClient): Promise<number> {
  const domains = await client.listDomains();
  // 持久化 NS：上游 /domains 列表每个域名自带 nameservers，随同步落 cache 表
  // （不传 TTL，默认 366 天近乎永久，不随每日定时刷新）。「修改 NS」弹窗冷缓存时
  // 先命中它本地读秒回，不再每次全量拉一次上游列表 —— 与 DNSHE 深度同步预写
  // api_cache:dns 的做法同理（见 deepSyncAccountDomains）。
  for (const d of domains) {
    const ns = (d.nameservers || []).map((n) => String(n)).filter(Boolean);
    if (ns.length > 0) {
      const name = String(d.domain || d.name || "").trim();
      if (name) await dbManager.setCache(`dp_ns_sync:${name}`, JSON.stringify(ns));
    }
  }
  await dbManager.syncAccountDomains(accountId, domains.map(mapDomainToUpstream));
  return domains.length;
}

// NOTE: 深度同步「域名即路径参数」类托管商的域名列表。
//
// 适用于 DNSPod / 阿里云 / 华为云 / Vercel —— 四家的共同点是：一次列表调用就能拿到
// 账号下全部域名（都自带分页，客户端内部拉全），不需要像 Cloudflare 那样按 zone 逐页
// 断点续拉（它们是「域名数量受套餐限制」的量级，几十到几百条，一次拉完不触子请求上限）。
// 四家的列表都不带注册商侧到期时间（都是解析服务，注册有效期的权威来源是 RDAP/注册商），
// 故 expires_at 落「永久」占位，不纳入到期提醒。
export async function syncGenericProviderDomains(
  dbManager: DatabaseManager,
  accountId: number,
  list: () => Promise<UpstreamSubdomain[]>
): Promise<number> {
  const upstreams = await list();
  await dbManager.syncAccountDomains(accountId, upstreams);
  return upstreams.length;
}

export async function syncViaProviderAdapter(dbManager: DatabaseManager, accountId: number, provider: Parameters<typeof createDomainProviderAdapter>[0], client: Parameters<typeof createDomainProviderAdapter>[1]): Promise<number> {
  const upstreams = await createDomainProviderAdapter(provider, client).listDomains(client);
  await dbManager.syncAccountDomains(accountId, upstreams);
  return upstreams.length;
}

// NOTE: 深度同步单个 DNSHE 账号的域名缓存 — 逐个拉取每个域名的 DNS 记录，自动分类（已委派/已解析/未解析）
// 与 cron.ts 中 "同步所有域名" 的逻辑保持一致，供绑定/批量/修改换 Key 后调用
export async function deepSyncAccountDomains(dbManager: DatabaseManager, accountId: number, client: DNSHEClient): Promise<number> {
  const subdomains = await fetchAllSubdomainsFromClient(client);
  const issues: SyncIssue[] = [];

  // 逐域串行：前序列表/配额请求已占用下一张 2.1s 预约；两路 DNS
  // 会让第二路排到约 4.2s，超过共享预算的 4s 上限。分页仍由客户端拉全。
  const enriched = await batchedPromiseAll(
    subdomains, async (sub) => {
      try {
        const recordsRes = await client.listDnsRecords(sub.id);
        const records = requireCompleteDnsRecords(recordsRes);

        // 深度同步拿到的真实解析记录一并回填缓存，后续打开 DNS 面板直接命中、零上游调用
        await dbManager.replaceDnsRecordsCache(sub.id, records);

        return { ...sub, ...computeDnsState(records) };
      } catch (e: unknown) {
        console.error(`listDnsRecords failed for subdomain ${sub.id}:`, e);
        issues.push(syncIssue(e, "dns", sub.id));
        // 上游临时失败时不带 dns_state_known，缓存中已识别出的三态与托管商保持不变。
        return { ...sub };
      }
    }, 1
  );

  await dbManager.syncAccountDomains(accountId, enriched);
  if (issues.length) throw new IncompleteSyncError(summarizeSync([{
    accountId, status: "partial", total: subdomains.length,
    issues: issues.sort((a, b) => a.domainId! - b.domainId!),
  }]));
  return subdomains.length;
}

/**
 * 账号绑定 / 换 Key / 手动同步 后逐个账号深度同步域名，并刷新该账号的配额缓存
 *
 * NOTE: 账号间保留 1.2s 间隔；DNSHE 实际准入由共享每 Key 预算控制。
 *
 * WHY 每一处都要 writeLog：这里原先只有 console.log，而 console 在 Workers 里进的是
 * 实时日志（wrangler tail / 仪表盘），**不落 D1 的 logs 表** —— 结果就是面板的「日志」
 * 页看不到手动单账号同步的任何痕迹，用户以为同步没跑。定时任务那条路径（cron.ts）每步
 * 都有 writeLog，所以只有它有日志，这个差异是缺陷而不是设计。
 *
 * @param trigger 触发来源，仅用于日志措辞（"manual"=用户手动点同步 / "auto"=绑定后自动）
 */
export async function resyncAccountsInBackground(
  dbManager: DatabaseManager,
  accountIds: number[],
  trigger: "manual" | "auto" = "auto"
): Promise<SyncSummary> {
  const triggerLabel = trigger === "manual" ? "手动同步" : "后台同步";
  const results: AccountSyncResult[] = [];
  const ids = [...new Set(accountIds)];
  for (const id of ids) {
    // 先取别名用于日志；取不到就用 id 兜底（账号可能已被删除）
    let aliasForLog = `账号 ${id}`;
    try {
      const { client, alias, provider } = await dbManager.getClientForAccount(id);
      aliasForLog = alias || aliasForLog;

      // custom 分组无上游 API，不刷配额、不同步域名（手动域名已在 custom_domains 表）
      if (provider === "custom") {
        results.push({ accountId: id, status: "skipped", total: 0, issues: [] });
        await logService(dbManager).write(
          "info",
          "sync",
          `${triggerLabel}：账号 [${alias}] 是自定义分组，无上游接口，跳过同步`
        );
        continue;
      }

      await logService(dbManager).write("info", "sync", `${triggerLabel}：开始同步账号 [${alias}]`);

      // 配额刷新也在 Action 结算之前执行。
      await dbManager.refreshAccountQuotaCache(id, alias, provider);

      const synced = client instanceof CloudflareClient
        ? await syncCloudflareZones(dbManager, id, client)
        : client instanceof DigitalPlatClient
          ? await syncDigitalPlatDomains(dbManager, id, client)
          : PARSE_ONLY_PROVIDERS.includes(provider)
            ? await syncViaProviderAdapter(dbManager, id, provider, client)
            : client instanceof DNSHEClient
              ? await deepSyncAccountDomains(dbManager, id, client)
              : (() => { throw new Error("未知的账号提供商"); })();

      // 按 provider 给出可读的完成措辞 —— zone 和「域名」是两种不同的东西，不该混称
      const unit = client instanceof CloudflareClient || client instanceof HuaweiCloudClient ? "个 zone" : "个域名";
      await logService(dbManager).write(
        "success",
        "sync",
        `${triggerLabel}：账号 [${alias}] 同步完成，共 ${synced} ${unit}`
      );
      console.log(`Deep sync finished for account ${id}: ${synced} domains`);
      results.push({ accountId: id, status: "completed", total: synced, issues: [] });
    } catch (e: unknown) {
      results.push(...(e instanceof IncompleteSyncError ? e.result.accounts : [{
        accountId: id, status: "failed" as const, total: 0, issues: [syncIssue(e, "account")],
      }]));
      const message = e instanceof Error ? e.message : "未知错误";
      const stack = e instanceof Error ? (e.stack || message) : message;
      // 失败必须落库 —— 这正是原先只 console.error 时用户完全看不到的那类信息
      await logService(dbManager).write(
        e instanceof IncompleteSyncError ? "warning" : "error",
        "sync",
        `${triggerLabel}：账号 [${aliasForLog}] ${e instanceof IncompleteSyncError ? "同步未全部完成" : "同步失败"}：${message}`,
        stack
      );
      console.error(`Background account resync failed for account ${id}:`, e);
    }
    if (id !== ids[ids.length - 1]) await sleep(1200);
  }
  return requireCompletedSync(results);
}

// NOTE: 简易异步等待工具
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compatibility wrapper is now local-only; callers must drive sync-step. */
async function unusedLocalPlan(db: DatabaseManager, accountIds: number[], _trigger: "manual" | "auto" = "auto"): Promise<SyncSummary> {
  await syncPlan(db, { manual: true, accountIds: accountIds.slice(0, 50) });
  return summarizeSync(accountIds.slice(0, 50).map(accountId => ({ accountId, status: "partial" as const, total: 0, issues: [{ phase: "continuation" as const, message: "请由登录页面调用 sync-step 继续完整同步" }] })));
}

/**
 * 注册成功后，只把新增的这一个域名写入 domains_cache。
 *
 * NOTE: 这里刻意不走 syncAccountDomains —— 它会按账号全量覆盖，而 subdomains/list
 * 不返回解析记录，结果是同账号下所有「已委派」域名被刷成「已解析 + 系统默认」。
 * 单条 upsert 既不碰其他行，也不需要为整个账号重新拉一遍 DNS 记录。
 */
export async function cacheNewlyRegisteredDomain(
  dbManager: DatabaseManager,
  accountId: number,
  subdomainId: number | undefined,
  fullDomain: string
): Promise<void> {
  const { client } = await dbManager.getClientForAccount(accountId);
  if (!(client instanceof DNSHEClient)) throw new Error("仅 DNSHE 账号支持注册后域名缓存");

  if (subdomainId === undefined) return; // Unknown ID: later sliced sync discovers it.
  const created = (await client.getSubdomain(subdomainId)).subdomain;
  if (created && (created.id !== subdomainId || created.full_domain !== fullDomain)) throw new Error("注册后域名身份校验失败");
  if (!created) {
    console.error(`注册后未在上游列表中找到新域名: ${fullDomain}`);
    return;
  }

  await dbManager.upsertDomain(accountId, created);
}

// NOTE: 辅助函数 - 如果在环境变量中配置了 DEFAULT_API_KEY 和 DEFAULT_API_SECRET，自动进行初始化绑定
export interface DefaultAccountContext { env: { DEFAULT_API_KEY?: string; DEFAULT_API_SECRET?: string; DEFAULT_API_ALIAS?: string } }

export async function ensureDefaultAccount(c: DefaultAccountContext, dbManager: DatabaseManager) {
  const apiKey = c.env.DEFAULT_API_KEY;
  const apiSecret = c.env.DEFAULT_API_SECRET;
  const alias = c.env.DEFAULT_API_ALIAS || "默认账号 (环境变量)";

  if (apiKey && apiSecret) {
    try {
      const existingAccounts = await accountService(dbManager).list();
      const exists = existingAccounts.some(acc => acc.api_key === apiKey);
      if (!exists) {
        await accountService(dbManager).create(alias, apiKey, apiSecret);
      }
    } catch (e) {
      console.error("Auto registration of default account failed:", e);
    }
  }
}


