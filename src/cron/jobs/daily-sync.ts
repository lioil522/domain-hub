/**
 * 每日定时全量同步与自动续期核心调度任务
 */

import { DatabaseManager, UpstreamSubdomain } from "../../db";
import { DNSHEClient } from "../../dnshe";
import { CloudflareClient, mapZoneToUpstream, type CfZoneInfo } from "../../cloudflare";
import { DigitalPlatClient, mapDomainToUpstream } from "../../digitalplat";
import { computeDnsState } from "../../dns-provider";

import {
  type WebhookType,
  sendWebhookNotification,
  sendTelegramNotification,
} from "../notification";
import { batchedPromiseAll, isSubrequestLimitError } from "../utils";
import {
  CF_ZONE_PROBE_PAGES,
  CF_ZONE_ROUNDS_PER_RUN,
  CF_ZONE_CURSOR_TTL,
  DNS_RECORDS_CACHE_MODE_KEY,
  cfZoneCursorKey,
  readCfZoneCursor,
  collectManagedCfZones,
} from "../cf-helpers";
import {
  SYNC_ACCOUNT_BATCH_SIZE,
  ACCOUNT_CURSOR_KEY,
  readAccountCursor,
  pickAccountBatch,
} from "../account-batch";
import { collectExpiryReminders } from "./expiry-check";
import { listUpstreamDomains, fetchAllSubdomainsFromClient } from "./upstream-sync";

/**
 * 核心定时任务：全量同步所有账号的域名并自动续期即将到期的域名
 */
export async function runDailySyncAndRenewal(
  dbManager: DatabaseManager,
  webhookUrl?: string,
  webhookType: WebhookType = "custom",
  // 是否为定时触发（true=每日 Cron 任务，false=手动「同步域名」/账号绑定后的后台同步）
  isScheduled = false
): Promise<void> {
  await dbManager.ensureTables();
  await dbManager.writeLog("info", "system", "自动定时任务启动：开始执行域名同步与到期检测续期任务");

  // 读取数据库应用配置（优先级高于环境变量）
  const appCfg = await dbManager.getAllAppSettings();
  const renewThresholdDays = (() => {
    const v = parseInt(appCfg["renew_threshold_days"] || "", 10);
    return isNaN(v) || v <= 0 ? 90 : v;
  })();
  const autoRenewEnabled = appCfg["auto_renew"] !== "0"; // 默认开启
  const effectiveWebhookUrl = appCfg["webhook_url"] || webhookUrl || "";
  const effectiveWebhookType = (appCfg["webhook_type"] as WebhookType) || webhookType;
  const tgToken = appCfg["tg_token"] || "";
  const tgChatId = appCfg["tg_chat_id"] || "";

  // 定时任务是否只读解析记录缓存（默认开启；手动同步永远全额回源）
  const dnsCacheOnlyOnScheduled = isScheduled && appCfg[DNS_RECORDS_CACHE_MODE_KEY] !== "always";

  let accounts: Array<{ id: number; alias: string }> = [];
  try {
    accounts = await dbManager.getAccounts();
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "未知错误";
    await dbManager.writeLog("error", "system", "同步任务失败：无法获取绑定的账户列表", message);
    return;
  }

  let totalSynced = 0;
  let totalRenewSuccess = 0;
  let totalRenewFail = 0;
  const renewLogs: string[] = [];
  const expiryReminderLogs: string[] = [];

  // 到期提醒统一前置（与账号分批解耦）
  await collectExpiryReminders(dbManager, renewThresholdDays, expiryReminderLogs);

  // 账号分批轮转：本轮只处理 SYNC_ACCOUNT_BATCH_SIZE 个账号，从游标处继续，环状推进
  const cursorBefore = isScheduled
    ? await readAccountCursor(dbManager)
    : { lastId: 0, rounds: 0 };
  const { batch: accountsThisRun, nextCursor } = isScheduled
    ? pickAccountBatch(accounts, cursorBefore, SYNC_ACCOUNT_BATCH_SIZE)
    : { batch: accounts, nextCursor: cursorBefore };

  if (isScheduled && accounts.length > SYNC_ACCOUNT_BATCH_SIZE) {
    await dbManager.writeLog(
      "info",
      "sync",
      `定时同步按批次轮转：本轮处理 ${accountsThisRun.length}/${accounts.length} 个账号（第 ${cursorBefore.rounds + 1} 轮，从账号 id ${
        accountsThisRun[0]?.id ?? "-"
      } 开始），其余账号将在后续轮次继续`
    );
  }

  let lastProcessedId = cursorBefore.lastId;
  let quotaExhausted = false;

  for (const acc of accountsThisRun) {
    lastProcessedId = acc.id;
    try {
      const { client, alias, provider } = await dbManager.getClientForAccount(acc.id);

      // 1. Cloudflare 账号
      if (provider === "cloudflare") {
        if (!(client instanceof CloudflareClient)) {
          throw new Error("Cloudflare 账号客户端异常");
        }

        const cursorKey = cfZoneCursorKey(acc.id);
        const cursor = await readCfZoneCursor(dbManager, cursorKey);

        let zones: CfZoneInfo[] = [];
        for (let page = cursor.startPage, round = 0; round < CF_ZONE_ROUNDS_PER_RUN; round++) {
          const res = await client.listZones({ startPage: page, maxPages: CF_ZONE_PROBE_PAGES });
          zones = zones.concat(res.zones);
          if (!res.hasMore) {
            const total = cursor.syncedBefore + zones.length;
            await dbManager.syncAccountDomains(acc.id, zones.map(mapZoneToUpstream));
            await dbManager.setCache(cursorKey, "", 1);
            totalSynced += total;
            await dbManager.writeLog(
              "info",
              "sync",
              `Cloudflare 账号 [${alias}] zone 列表同步完成，本账号共 ${total} 个 zone`
            );
            break;
          }
          await dbManager.upsertAccountDomains(acc.id, res.zones.map(mapZoneToUpstream));
          cursor.syncedBefore += res.zones.length;
          page = res.nextPage;
          await dbManager.setCache(cursorKey, JSON.stringify(cursor), CF_ZONE_CURSOR_TTL);
          await dbManager.writeLog(
            "info",
            "sync",
            `Cloudflare 账号 [${alias}] zone 数量较多，本次已同步 ${res.zones.length} 个，剩余部分将在后续定时任务中从第 ${page} 页续拉`
          );
        }
        continue;
      }

      // 2. DigitalPlat 账号
      if (provider === "digitalplat") {
        if (!(client instanceof DigitalPlatClient)) {
          throw new Error("DigitalPlat 账号客户端异常");
        }
        if (isScheduled) {
          continue;
        }
        const dpDomains = await client.listDomains();
        for (const d of dpDomains) {
          const ns = (d.nameservers || []).map((n) => String(n)).filter(Boolean);
          if (ns.length > 0) {
            const name = String(d.domain || d.name || "").trim();
            if (name) await dbManager.setCache(`dp_ns_sync:${name}`, JSON.stringify(ns));
          }
        }
        await dbManager.syncAccountDomains(acc.id, dpDomains.map(mapDomainToUpstream));
        totalSynced += dpDomains.length;
        continue;
      }

      // 3. 自定义服务商分组
      if (provider === "custom") {
        continue;
      }

      // 4. 只托管解析的四家（DNSPod / 阿里云 / 华为云 / Vercel）
      if (
        provider === "dnspod" ||
        provider === "alidns" ||
        provider === "huaweicloud" ||
        provider === "vercel"
      ) {
        if (isScheduled) {
          continue;
        }
        const list = await listUpstreamDomains(client);
        await dbManager.syncAccountDomains(acc.id, list);
        totalSynced += list.length;
        continue;
      }

      if (!(client instanceof DNSHEClient)) {
        throw new Error("未知的账号提供商");
      }

      // 5. DNSHE 系统全量域名拉取
      const subdomains = await fetchAllSubdomainsFromClient(client);

      const cfZones = await collectManagedCfZones(dbManager);
      const cfFastPath = new Map<number, { alias: string; zoneId: string }>();

      for (const sub of subdomains) {
        const host = String(sub.full_domain || "").trim().toLowerCase();
        const zone = host ? cfZones.get(host) : undefined;
        if (!zone) continue;
        cfFastPath.set(sub.id, zone);
      }

      const dnsRecordsCache = dnsCacheOnlyOnScheduled
        ? await dbManager.getDnsRecordsCacheBatch(
            subdomains.filter((sub) => !cfFastPath.has(sub.id)).map((sub) => sub.id)
          )
        : new Map<number, unknown[]>();
      const cacheFastPath = new Set<number>(dnsRecordsCache.keys());

      const needDnsFetch = subdomains.filter(
        (sub) => !cfFastPath.has(sub.id) && !cacheFastPath.has(sub.id)
      );
      const subdomainsWithDnsInfo: UpstreamSubdomain[] = await batchedPromiseAll(
        needDnsFetch,
        async (sub): Promise<UpstreamSubdomain> => {
          try {
            const recordsRes = await client.listDnsRecords(sub.id);
            const records = recordsRes.records || [];
            await dbManager.setCache(`api_cache:dns:${sub.id}`, JSON.stringify(records));
            return { ...sub, ...computeDnsState(records) };
          } catch (e) {
            if (isSubrequestLimitError(e)) throw e;
            return { ...sub };
          }
        },
        5
      );

      for (const sub of subdomains) {
        const records = dnsRecordsCache.get(sub.id);
        if (!records) continue;
        subdomainsWithDnsInfo.push({
          ...sub,
          ...computeDnsState(records as Array<{ type?: string; content?: unknown }>),
        });
      }

      for (const sub of subdomains) {
        const zone = cfFastPath.get(sub.id);
        if (!zone) continue;
        subdomainsWithDnsInfo.push({
          ...sub,
          status: "已委派",
          has_dns: 0,
          dns_provider: "Cloudflare",
          dns_state_known: true,
          provider_account_id: sub.provider_account_id ?? zone.alias,
          remote_id: zone.zoneId || undefined,
        });
      }

      await dbManager.syncAccountDomains(acc.id, subdomainsWithDnsInfo);
      totalSynced += subdomains.length;

      if (cfFastPath.size > 0 || cacheFastPath.size > 0) {
        const parts: string[] = [];
        if (cfFastPath.size > 0) parts.push(`${cfFastPath.size} 个已委派到本面板 CF 账号`);
        if (cacheFastPath.size > 0) parts.push(`${cacheFastPath.size} 个命中记录缓存`);
        await dbManager.writeLog(
          "info",
          "sync",
          `账号 [${alias}] 共 ${subdomains.length} 个域名，其中 ${parts.join("、")}，跳过解析记录拉取（本次实际拉取 ${needDnsFetch.length} 次，节省 ${subdomains.length - needDnsFetch.length} 次子请求）`
        );
      }

      // 6. 扫描 DNSHE 域名是否需要自动续期
      for (const sub of subdomains) {
        const expiresAt = sub.expires_at as string | undefined;
        if (!expiresAt) continue;

        const expiresTime = new Date(expiresAt).getTime();
        const nowTime = Date.now();
        const remainingDays = (expiresTime - nowTime) / (1000 * 60 * 60 * 24);

        if (autoRenewEnabled && remainingDays >= 0 && remainingDays <= renewThresholdDays) {
          const subId = sub.id as number;
          const fullDomain = sub.full_domain as string;

          try {
            const renewResult = await client.renewSubdomain(subId);
            if (renewResult && renewResult.success) {
              totalRenewSuccess++;
              const newExpiresAt = renewResult.new_expires_at || "";
              await dbManager.markDomainRenewed(subId, newExpiresAt);
              const msg = `域名 [${fullDomain}] (账户: ${alias}) 自动续期成功！新有效期至: ${newExpiresAt}`;
              await dbManager.writeLog("success", "renew", msg, renewResult);
              renewLogs.push(`✅ ${msg}`);
            } else {
              throw new Error(renewResult.message || "未知原因导致的续期失败");
            }
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : "";
            if (errMsg.includes("renewal_not_yet_available") || errMsg.includes("not yet available")) {
              await dbManager.writeLog(
                "info",
                "renew",
                `域名 [${fullDomain}] 自动续期请求已提交，但因尚未进入免费续期窗口被拦截，将在后续定时任务中重试。`
              );
            } else {
              totalRenewFail++;
              const msg = `域名 [${fullDomain}] (账户: ${alias}) 自动续期失败：${errMsg}`;
              await dbManager.writeLog("error", "renew", msg, err instanceof Error ? err.stack || errMsg : errMsg);
              renewLogs.push(`❌ ${msg}`);
            }
          }
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "未知错误";
      const stack = e instanceof Error ? e.stack || message : message;
      await dbManager.writeLog("error", "sync", `同步账号 [${acc.alias}] 的域名数据失败：${message}`, stack);
      if (isSubrequestLimitError(e)) {
        await dbManager.writeLog(
          "warning",
          "sync",
          "检测到 Worker 子请求配额已耗尽（免费计划单次调用硬限 50 次），已跳过本批次剩余账号。下一轮定时任务会从本轮中断处继续，不会漏掉账号。可尝试：把域名较多的账号拆分成多个 API Token 绑定，或升级到 Workers 付费计划"
        );
        quotaExhausted = true;
        break;
      }
    }
  }

  if (isScheduled && accounts.length > 0) {
    const advancedCursor = quotaExhausted
      ? { lastId: lastProcessedId, rounds: cursorBefore.rounds }
      : nextCursor;
    if (advancedCursor.lastId > 0) {
      await dbManager.setCache(ACCOUNT_CURSOR_KEY, JSON.stringify(advancedCursor));
    }
  }

  const summaryMsg = `自动同步任务结束。本次同步域名数: ${totalSynced} 个，自动续期成功: ${totalRenewSuccess} 个，续期失败: ${totalRenewFail} 个。`;
  await dbManager.writeLog("info", "system", summaryMsg);

  // 清理任务
  await dbManager.pruneExpiredLogs();
  const purgedCache = await dbManager.purgeExpiredCache();
  if (purgedCache > 0) {
    await dbManager.writeLog("info", "system", `已清理 ${purgedCache} 条过期缓存记录（含查重池）`);
  }
  const purgedSessions = await dbManager.purgeExpiredSessions();
  if (purgedSessions > 0) {
    await dbManager.writeLog("info", "system", `已清理 ${purgedSessions} 条过期登录会话`);
  }

  // 发送续期通知
  if (renewLogs.length > 0) {
    const notifyBody = `【DNSHE 域名自动续期报告】\n${summaryMsg}\n\n详细明细：\n${renewLogs.join("\n")}`;
    if (effectiveWebhookUrl) {
      const result = await sendWebhookNotification(effectiveWebhookUrl, notifyBody, effectiveWebhookType);
      if (!result.ok) {
        await dbManager.writeLog(
          "warning",
          "system",
          `续期报告 Webhook 推送失败（${effectiveWebhookType}）`,
          result.detail || `HTTP ${result.status ?? "?"}`
        );
      }
    }
    if (tgToken && tgChatId) {
      await sendTelegramNotification(tgToken, tgChatId, notifyBody);
    }
  }

  // 发送到期提醒通知
  if (expiryReminderLogs.length > 0) {
    const reminderBody = `【域名到期提醒】\n以下域名即将到期或已过期（不支持自动续期，请前往对应服务商处理）：\n\n${expiryReminderLogs.join("\n")}`;
    if (effectiveWebhookUrl) {
      const result = await sendWebhookNotification(effectiveWebhookUrl, reminderBody, effectiveWebhookType);
      if (!result.ok) {
        await dbManager.writeLog(
          "warning",
          "system",
          `到期提醒 Webhook 推送失败（${effectiveWebhookType}）`,
          result.detail || `HTTP ${result.status ?? "?"}`
        );
      }
    }
    if (tgToken && tgChatId) {
      await sendTelegramNotification(tgToken, tgChatId, reminderBody);
    }
  }
}
