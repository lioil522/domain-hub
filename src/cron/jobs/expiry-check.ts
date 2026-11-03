/**
 * 域名到期预警检查任务
 *
 * NOTE: 针对 Cloudflare (RDAP+覆盖)、DigitalPlat、自定义分组域名检查即将到期情况并产出告警日志。
 */

import type { DatabaseManager } from "../../db";
import { isRegistrableDomain } from "../../punycode";
import { CF_EXPIRY_BUDGET } from "../cf-helpers";

/**
 * 每日到期提醒去重缓存 key
 *
 * NOTE: cron 每天会触发两轮（见 wrangler.toml triggers），
 * 但到期提醒只需发送一次。利用此 key 记录当天已发送的日期，
 * 第二轮检测到标记后直接跳过，避免重复推送。
 */
const EXPIRY_REMINDER_SENT_KEY = "expiry_reminder_sent";

/** 缓存 TTL：25 小时，确保跨天后自动失效 */
const EXPIRY_REMINDER_TTL = 25 * 60 * 60;

export async function collectExpiryReminders(
  dbManager: DatabaseManager,
  renewThresholdDays: number,
  out: string[]
): Promise<void> {
  // 当天去重：如果本日已执行过到期提醒，直接跳过
  const todayStr = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const lastSentDate = await dbManager.getCache(EXPIRY_REMINDER_SENT_KEY);
  if (lastSentDate === todayStr) {
    return;
  }
  // ── ① Cloudflare ────────────────────────────────────────────────
  try {
    const cfZones = await dbManager.getDomains("", "", undefined, "cloudflare");
    if (cfZones.length > 0) {
      const accountIds = Array.from(new Set(cfZones.map((z) => z.account_id)));
      const manualByAccount = await dbManager.getDateOverridesByAccountIds(accountIds);
      const registrableHosts: string[] = [];
      const seenHost = new Set<string>();
      for (const z of cfZones) {
        const host = String(z.full_domain || "").trim().toLowerCase();
        if (!host || seenHost.has(host)) continue;
        seenHost.add(host);
        if (isRegistrableDomain(host)) registrableHosts.push(host);
      }
      const inBudget = registrableHosts.slice(0, CF_EXPIRY_BUDGET);
      const rdapCache = await dbManager.getRdapExpiryCacheBatch(inBudget);
      if (registrableHosts.length > inBudget.length) {
        await dbManager.writeLog(
          "info",
          "renew",
          `Cloudflare 域名到期检查：待查缓存的注册域 ${registrableHosts.length} 个超出单轮预算 ${CF_EXPIRY_BUDGET}，本轮只检查前 ${inBudget.length} 个，其余下一轮继续`
        );
      }

      for (const z of cfZones) {
        const fullDomain = String(z.full_domain || "").trim();
        if (!fullDomain) continue;
        const host = fullDomain.toLowerCase();
        const manualHit = manualByAccount.get(z.account_id)?.get(host);
        const expiresAt = manualHit || rdapCache.get(host) || "";
        if (!expiresAt || expiresAt.startsWith("0000")) continue;
        const expiresTime = new Date(expiresAt).getTime();
        if (Number.isNaN(expiresTime)) continue;
        const remainingDays = (expiresTime - Date.now()) / (1000 * 60 * 60 * 24);
        if (remainingDays <= renewThresholdDays) {
          const alias = z.account_alias || `账号 ${z.account_id}`;
          const src = manualHit ? "手动录入" : "RDAP";
          const msg =
            remainingDays < 0
              ? `域名 [${fullDomain}]（Cloudflare / ${alias}）已过期 ${Math.ceil(-remainingDays)} 天，请及时续费`
              : `域名 [${fullDomain}]（Cloudflare / ${alias}）将于 ${Math.ceil(remainingDays)} 天后到期`;
          await dbManager.writeLog("warning", "renew", `${msg}（到期时间来源：${src}）`);
          out.push(`⚠️ ${msg}`);
        }
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "未知错误";
    await dbManager.writeLog("error", "renew", `Cloudflare 域名到期检查失败：${message}`);
  }

  // ── ② DigitalPlat ───────────────────────────────────────────────
  try {
    const dpCachedDomains = await dbManager.getDomains("", "", undefined, "digitalplat");
    for (const dom of dpCachedDomains) {
      const expiresRaw = String(dom.expires_at || "");
      if (!expiresRaw || expiresRaw.startsWith("0000")) continue;
      const expiresTime = new Date(expiresRaw).getTime();
      if (Number.isNaN(expiresTime)) continue;
      const remainingDays = (expiresTime - Date.now()) / (1000 * 60 * 60 * 24);
      if (remainingDays <= renewThresholdDays) {
        const fullDomain = dom.full_domain;
        const alias = dom.account_alias || `账号 ${dom.account_id}`;
        const msg =
          remainingDays < 0
            ? `域名 [${fullDomain}]（DigitalPlat / ${alias}）已过期 ${Math.ceil(-remainingDays)} 天，请及时续费`
            : `域名 [${fullDomain}]（DigitalPlat / ${alias}）将于 ${Math.ceil(remainingDays)} 天后到期`;
        await dbManager.writeLog("warning", "renew", msg);
        out.push(`⚠️ ${msg}`);
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "未知错误";
    await dbManager.writeLog("error", "renew", `DigitalPlat 域名到期检查失败：${message}`);
  }

  // ── ③ 自定义服务商分组 ──────────────────────────────────────────
  try {
    const allCustomDomains = await dbManager.listAllCustomDomains();
    for (const dom of allCustomDomains) {
      if (!dom.expires_at || dom.expires_at.startsWith("0000")) continue;
      const expiresTime = new Date(dom.expires_at).getTime();
      if (Number.isNaN(expiresTime)) continue;
      const remainingDays = (expiresTime - Date.now()) / (1000 * 60 * 60 * 24);
      if (remainingDays <= renewThresholdDays) {
        const fullDomain = dom.full_domain;
        const label = dom.account_name
          ? `分组: ${dom.group_alias} / 账号: ${dom.account_name}`
          : `分组: ${dom.group_alias}`;
        const msg =
          remainingDays < 0
            ? `域名 [${fullDomain}]（${label}）已过期 ${Math.ceil(-remainingDays)} 天，请及时处理`
            : `域名 [${fullDomain}]（${label}）将于 ${Math.ceil(remainingDays)} 天后到期`;
        await dbManager.writeLog("warning", "renew", msg);
        out.push(`⚠️ ${msg}`);
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "未知错误";
    await dbManager.writeLog("error", "renew", `自定义分组域名到期检查失败：${message}`);
  }

  // 标记当天已完成到期提醒，后续 cron 轮次不再重复推送
  await dbManager.setCache(EXPIRY_REMINDER_SENT_KEY, todayStr, EXPIRY_REMINDER_TTL);
}
