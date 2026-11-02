import { DatabaseManager } from "../db";
import { automationSettings } from "./automation-settings";
import { renewCachedDomain } from "./renewal-service";
import { sendTelegramNotification, sendWebhookNotification, type WebhookType } from "../cron/notification";
import { InvocationBudget } from "./invocation-budget";
import { withBudgetD1 } from "../db/budget-d1";

const now = "CAST(strftime('%s','now') AS INTEGER)";
export async function localExpiryReport(db: DatabaseManager, days: number): Promise<string[]> {
  const rows = await db.allRaw<{ full_domain: string; alias: string; expiry: string }>(`SELECT full_domain,alias,expiry FROM (
    SELECT d.full_domain,a.alias,CASE WHEN a.provider='cloudflare' THEN COALESCE(NULLIF(o.expires_at,''),CASE WHEN json_valid(c.value) AND json_extract(c.value,'$.found')=1 THEN json_extract(c.value,'$.expires_at') END) ELSE d.expires_at END AS expiry
    FROM domains_cache d JOIN accounts a ON a.id=d.account_id LEFT JOIN domain_date_overrides o ON o.account_id=d.account_id AND lower(o.full_domain)=lower(d.full_domain)
    LEFT JOIN cache c ON c.key='rdap:4:'||lower(d.full_domain) AND c.expires_at>${now} WHERE a.provider IN ('dnshe','cloudflare','digitalplat')
    UNION ALL SELECT d.full_domain,a.alias,d.expires_at FROM custom_domains d JOIN accounts a ON a.id=d.group_id
  ) WHERE julianday(expiry) IS NOT NULL AND julianday(expiry)<=julianday('now')+? ORDER BY julianday(expiry) LIMIT 101`, [days]);
  const lines = rows.slice(0, 100).map(r => `${r.full_domain.slice(0, 253)}（${r.alias.slice(0, 40)}）：${r.expiry.slice(0, 32)}`);
  if (rows.length > 100) lines.push("另有更多到期记录；报告已截断，请打开面板检查。");
  return lines;
}

/** Local reminder + bounded DNSHE renewal only. No list/DNS/RDAP refresh. */
export async function runReminderRenewal(db: DatabaseManager, webhookUrl?: string, webhookType: WebhookType = "custom") {
  if (!(await db.ensureTables())) throw new Error("数据库初始化失败，提醒与续期已停止");
  const cfg = await automationSettings(db);
  const report = await localExpiryReport(db, cfg.reminderDays);
  let renewed = 0, failed = 0, deferred = 0;
  const budget = db.invocationBudget;
  const candidates = await db.allRaw<{ id: number }>(`SELECT d.id FROM domains_cache d JOIN accounts a ON a.id=d.account_id LEFT JOIN renewal_intents i ON i.domain_id=d.id WHERE a.provider='dnshe' AND julianday(d.expires_at) IS NOT NULL
    AND (i.status IN ('sent','verify') OR (?=1 AND ?>0 AND julianday(d.expires_at)<=julianday('now')+?))
    AND COALESCE(i.lease_until,0)<=${now} AND COALESCE(i.next_attempt_at,0)<=${now} ORDER BY julianday(d.expires_at),d.id LIMIT 4`, [cfg.auto_renew !== "0" ? 1 : 0, cfg.renewalDays, cfg.renewalDays]);
  const tail = budget instanceof InvocationBudget ? budget.reserve({ d1: 7, external: 2 }) : undefined;
  const finalDb = tail ? new DatabaseManager(withBudgetD1(db.connection, tail)) : db;
  try {
   for (const [index, row] of candidates.entries()) {
    // Conservative admission incl. DNSHE DB coordination. Other keys remain
    // independent; no provider-level two-slot limit or quota bypass.
    if (budget instanceof InvocationBudget && (budget.remaining("d1") < 24 || budget.remaining("external") < 3)) { deferred += candidates.length - index; break; }
    try { await renewCachedDomain(db, row.id); renewed++; } catch { failed++; }
  }
   const backlog = await finalDb.firstRaw<{ count: number }>(`SELECT COUNT(*) AS count FROM domains_cache d JOIN accounts a ON a.id=d.account_id WHERE a.provider='dnshe' AND julianday(d.expires_at)<=julianday('now')+?`, [cfg.renewalDays]);
   const pending = cfg.auto_renew !== "0" && cfg.renewalDays > 0 && (backlog?.count ?? 0) > 0;
   const summary = `续期成功 ${renewed}，失败/待核验 ${failed}，预算延期 ${deferred}，窗口内缓存域名 ${backlog?.count ?? 0}${pending ? "；仍有积压/退避项，现有 Cron 频率不保证到期前处理完，请检查面板。" : ""}`;
   const message = [`Domain Hub 到期提醒（基于本地缓存）`, ...(renewed || failed || deferred || pending ? [summary] : []), ...report].join("\n").slice(0, 3500);
   if (report.length || renewed || failed || deferred || pending) {
    const channels = [
      ...(cfg.tg_token && cfg.tg_chat_id ? [{ key: "telegram", send: () => sendTelegramNotification(cfg.tg_token!, cfg.tg_chat_id!, message, tail ?? budget) }] : []),
      ...(cfg.webhook_url || webhookUrl ? [{ key: "webhook", send: () => sendWebhookNotification(cfg.webhook_url || webhookUrl!, message, (cfg.webhook_type as WebhookType) || webhookType, tail ?? budget) }] : []),
    ];
    const day = (await finalDb.firstRaw<{ day: string }>("SELECT date('now') AS day"))!.day;
    for (const channel of channels) {
      const token = crypto.randomUUID();
      const claimed = await finalDb.firstRaw<{ token: string }>(`INSERT INTO reminder_deliveries(day,report_version,channel,token,status,next_attempt_at) VALUES(?,'local-expiry-v1',?,?,'sending',${now}+3600)
        ON CONFLICT(day,report_version,channel) DO UPDATE SET token=excluded.token,status='sending',next_attempt_at=excluded.next_attempt_at WHERE reminder_deliveries.status<>'sent' AND reminder_deliveries.next_attempt_at<=${now} RETURNING token`, [day, channel.key, token]);
      if (!claimed) continue;
      const result = await channel.send();
      await finalDb.executeRaw(`UPDATE reminder_deliveries SET status=?,next_attempt_at=${now}+3600 WHERE day=? AND report_version='local-expiry-v1' AND channel=? AND token=?`, [result.ok ? "sent" : "failed", day, channel.key, token]);
    }
  }
   await finalDb.writeLog(failed || deferred || pending ? "warning" : "info", "renew", `Cron 仅提醒续期：${summary}；完整同步由登录页面推进，提醒依赖缓存。`);
  return { renewed, failed, deferred, reportCount: report.length };
  } finally { tail?.release(); }
}
