import { DatabaseManager } from "./db";
import type { SubdomainInfo } from "./dnshe";
import { DNSHEClient } from "./dnshe";
import { CloudflareClient, mapZoneToUpstream } from "./cloudflare";
import { DigitalPlatClient, mapDomainToUpstream } from "./digitalplat";
import { computeDnsState } from "./dns-provider";

/**
 * Webhook 通知类型定义
 * 
 * NOTE: 支持按 WEBHOOK_TYPE 环境变量构造对应平台的规范 payload，
 * 而非同时携带所有平台的字段。
 */
export type WebhookType = "dingtalk" | "feishu" | "wecom" | "serverchan" | "custom";

/**
 * Webhook 推送结果
 *
 * NOTE: 这个函数刻意不抛异常 —— 它在 cron 里是「续期已经做完之后」的收尾步骤，
 * 推送失败不该让整个定时任务中断。所以改为回传结果供调用方决定怎么处理：
 * cron 写一条 warning 日志，测试接口把原因回给前端。
 */
export interface WebhookSendResult {
  ok: boolean;
  status?: number;
  detail?: string;
}

/**
 * 把 Server酱 的 SendKey 补全成推送端点
 *
 * 让用户只填 SendKey 就能用 —— 控制台首页给的就是一串 key，而「快速创建入口链接」
 * 那种网页地址反倒最容易被误当成推送地址（POST 上去只会回一段 MethodNotAllowed）。
 *
 * NOTE: 已经是 http(s):// 开头的一律原样透传，不做任何猜测 —— 用户可能用了自建
 * 转发或将来出现的新域名。
 * NOTE: Server酱³ 的 key 形如 sctp<uid>t<随机串>，端点带 uid 子域；Turbo 版
 * （SCT 开头，含 AppKey）统一走 sctapi.ftqq.com。认不出格式时按 Turbo 处理，
 * 失败会由平台返回明确错误码，不会静默。
 */
export function normalizeServerChanEndpoint(input: string): string {
  const v = input.trim();
  if (!v) return v;
  if (/^https?:\/\//i.test(v)) return v;
  const sc3 = v.match(/^sctp(\d+)t/i);
  if (sc3) return `https://${sc3[1]}.push.ft07.com/send/${v}.send`;
  return `https://sctapi.ftqq.com/${v}.send`;
}

/**
 * 推送 Webhook 通知
 */
export async function sendWebhookNotification(
  webhookUrl: string,
  message: string,
  webhookType: WebhookType = "custom"
): Promise<WebhookSendResult> {
  if (!webhookUrl) return { ok: false, detail: "未配置 Webhook 地址" };
  // Server酱 允许只填 SendKey，其余平台一律要求完整地址
  const endpoint = webhookType === "serverchan" ? normalizeServerChanEndpoint(webhookUrl) : webhookUrl;
  try {
    let payload: Record<string, unknown>;

    switch (webhookType) {
      case "dingtalk":
        // 钉钉机器人 Webhook 格式
        payload = {
          msgtype: "text",
          text: { content: message }
        };
        break;
      case "feishu":
        // 飞书机器人 Webhook 格式
        payload = {
          msg_type: "text",
          content: { text: message }
        };
        break;
      case "wecom":
        // 企业微信机器人 Webhook 格式
        payload = {
          msgtype: "text",
          text: { content: message }
        };
        break;
      case "serverchan":
        // Server酱（方糖）Turbo / ³ ——「标题 + 正文」两段式，与其他平台的单字段不同。
        //
        // NOTE: title 上限 32 字符，正文必须走 desp。用通用格式（text/content）虽然能通
        // （text 会被当成标题），但多行续期报告会被截成一行标题、正文全丢，所以必须单列。
        // 首行正好是「【DNSHE 域名自动续期报告】」这类摘要，拿来做标题最合适；
        // 消息本身仍完整放进 desp，不做截断。
        payload = {
          title: (message.split("\n")[0] || "DNSHE 通知").slice(0, 32),
          desp: message
        };
        break;
      case "custom":
      default:
        // 通用格式，兼容大多数 Webhook 服务
        payload = {
          text: message,
          content: message
        };
        break;
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const bodyText = (await res.text().catch(() => "")).slice(0, 500);

    if (!res.ok) {
      console.error(`Webhook push failed with status: ${res.status}`);
      return { ok: false, status: res.status, detail: bodyText || `HTTP ${res.status}` };
    }

    // NOTE: 钉钉 / 飞书 / 企业微信 / Server酱 在「token 失效」「机器人被移出群」这类
    // 错误上一律回 HTTP 200，真正的错误码藏在响应体里（钉钉与企微是 errcode/errmsg，
    // 飞书与 Server酱 是 code/message 或 code/msg）。只看 res.ok 会把这些失败当成
    // 推送成功 —— 界面显示已发送、群里什么都没有，比没有测试按钮更误导。
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      const code = parsed.errcode ?? parsed.code;
      if (code !== undefined && Number(code) !== 0) {
        const reason = String(parsed.errmsg ?? parsed.msg ?? parsed.message ?? bodyText);
        console.error(`Webhook rejected by platform: ${code} ${reason}`);
        return { ok: false, status: res.status, detail: `平台返回错误 ${code}：${reason}` };
      }
    } catch {
      // 通用 Webhook 往往回非 JSON（甚至空响应），HTTP 2xx 即视为成功
    }

    return { ok: true, status: res.status, detail: bodyText };
  } catch (e) {
    console.error("Failed to send Webhook notification:", e);
    return { ok: false, detail: e instanceof Error ? e.message : "请求异常" };
  }
}

/**
 * 推送 Telegram 通知
 *
 * NOTE: 通过 Telegram Bot API 的 sendMessage 接口推送文本消息。
 */
export async function sendTelegramNotification(botToken: string, chatId: string, message: string) {
  if (!botToken || !chatId) return;
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error(`Telegram push failed with status: ${res.status}`);
    }
  } catch (e) {
    console.error("Failed to send Telegram notification:", e);
  }
}

/**
 * 分批并发执行 —— 控制同时发出的 fetch() 数量以避免触发 Worker 子请求限制
 *
 * NOTE: Cloudflare Worker 每次调用有子请求配额（Free 50 / Paid 默认 10000），
 * 如果用 Promise.all 对上百个域名同时发 listDnsRecords，一批就可能打满配额。
 * 这里把任务数组切成每批 batchSize 个串行执行，每批内部并发，批间串行，
 * 在不显著降低性能的前提下控制峰值子请求数。
 */
async function batchedPromiseAll<T>(
  items: T[],
  fn: (item: T) => Promise<T>,
  batchSize: number = 5
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

/**
 * 判断错误是否为 Worker 子请求配额耗尽
 *
 * NOTE: Cloudflare 在超出 subrequests 限制时抛出的错误消息为
 * "Too many subrequests by single Worker invocation"，
 * 一旦触发，同一次调用内的后续 fetch() 全部会失败，
 * 因此需要提前中止而非继续重试。
 */
function isSubrequestLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("Too many subrequests");
  }
  return false;
}

// NOTE: 使用 DNSHEClient 的类型签名来定义分页拉取接口
interface SubdomainClient {
  listSubdomains(page: number, perPage: number): Promise<{
    success?: boolean;
    subdomains?: SubdomainInfo[];
    total?: number;
    message?: string;
  }>;
}

/**
 * 分页拉取某个账号下的全部子域名
 *
 * NOTE: DNSHE API 的 per_page 最大值为 500。循环分页直到所有数据拉取完毕。
 */
export async function fetchAllSubdomainsFromClient(client: SubdomainClient): Promise<SubdomainInfo[]> {
  const allSubdomains: SubdomainInfo[] = [];
  const perPage = 500;
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const res = await client.listSubdomains(page, perPage);
    if (!res || !res.success || !Array.isArray(res.subdomains)) {
      throw new Error(res?.message || "响应数据格式错误");
    }

    allSubdomains.push(...res.subdomains);

    // 判断是否还有下一页：当返回的数据量不足一页，或已达到 total 总数时停止
    if (res.subdomains.length < perPage) {
      hasMore = false;
    } else if (res.total !== undefined && allSubdomains.length >= res.total) {
      hasMore = false;
    } else {
      page++;
    }

    // 安全保护：最多拉取 50 页（25000 条），防止无限循环
    if (page > 50) {
      console.error("Pagination safety limit reached (50 pages), stopping.");
      break;
    }
  }

  return allSubdomains;
}

/**
 * 核心定时任务：全量同步所有账号的域名并自动续期即将到期的域名
 */
export async function runDailySyncAndRenewal(
  dbManager: DatabaseManager,
  webhookUrl?: string,
  webhookType: WebhookType = "custom",
  // 是否为定时触发（true=每日 Cron 任务，false=手动「同步域名」/账号绑定后的后台同步）
  isScheduled = false
) {
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
  // 自定义服务商（无 API）域名到期提醒明细，与续期明细分开推送
  const expiryReminderLogs: string[] = [];
  // 自定义域名到期提醒只在遇到第一个 custom 分组时统一处理一次（域名跨账号，避免每个分组重复遍历）
  let customReminderDone = false;
  // DigitalPlat 域名到期提醒：同样只在遇到第一个 DP 账号时统一处理一次（跨账号查全量 DP 域名）
  let dpReminderDone = false;

  for (const acc of accounts) {
    try {
      // 1. 获取解密后的 API 客户端
      const { client, alias, provider } = await dbManager.getClientForAccount(acc.id);

      // 1.5 Cloudflare 账号：只同步 zone 列表。zone 的有效期由注册商管理，
      //     不存在 DNSHE 式续期，直接跳过续期扫描。
      if (provider === "cloudflare") {
        if (!(client instanceof CloudflareClient)) {
          throw new Error("Cloudflare 账号客户端异常");
        }
        const zones = await client.listZones();
        await dbManager.syncAccountDomains(acc.id, zones.map(mapZoneToUpstream));
        totalSynced += zones.length;
        continue;
      }

      // 1.6 DigitalPlat 账号：只同步域名列表（自带注册商侧到期时间）。续期需走注册局
      //     支付流程（报价 + 订单），无法静默自动续期，跳过续期扫描。
      //     NS 已随同步持久化到 cache 表（dp_ns_sync:<域名>，无过期），不随每日定时
      //     重复拉取上游以省 API Key 调用：定时任务直接跳过该账号，手动同步才回源刷新。
      if (provider === "digitalplat") {
        if (!(client instanceof DigitalPlatClient)) {
          throw new Error("DigitalPlat 账号客户端异常");
        }
        // 到期提醒：读已同步到库的 DP 域名（不拉上游），剩余 <= 阈值（含已过期）时提醒。
        // DP 不自动续期，只提醒用户前往注册局处理；跨账号统一查一次避免重复遍历。
        if (!dpReminderDone) {
          dpReminderDone = true;
          const dpCachedDomains = await dbManager.getDomains("", "", undefined, "digitalplat");
          for (const dom of dpCachedDomains) {
            // 到期时间为「永久」（0000 前缀）或空时跳过
            const expiresRaw = String(dom.expires_at || "");
            if (!expiresRaw || expiresRaw.startsWith("0000")) continue;
            const expiresTime = new Date(expiresRaw).getTime();
            if (Number.isNaN(expiresTime)) continue;
            const remainingDays = (expiresTime - Date.now()) / (1000 * 60 * 60 * 24);
            if (remainingDays <= renewThresholdDays) {
              const fullDomain = dom.full_domain;
              const alias = dom.account_alias || `账号 ${dom.account_id}`;
              const msg = remainingDays < 0
                ? `域名 [${fullDomain}]（DigitalPlat / ${alias}）已过期 ${Math.ceil(-remainingDays)} 天，请及时续费`
                : `域名 [${fullDomain}]（DigitalPlat / ${alias}）将于 ${Math.ceil(remainingDays)} 天后到期`;
              await dbManager.writeLog("warning", "renew", msg);
              expiryReminderLogs.push(`⚠️ ${msg}`);
            }
          }
        }
        if (isScheduled) {
          // 定时触发：不拉上游。NS 持久化在库（dp_ns_sync:<域名>），域名列表与到期时间
          // 也不需每天动 —— 到期检测对 DP 无续期逻辑，跳过即可省一次 listDomains 调用。
          continue;
        }
        const dpDomains = await client.listDomains();
        // 持久化 NS：上游列表每个域名自带 nameservers，随同步落 cache 表（不传 TTL，
        // 默认 366 天，近乎永久），让「修改 NS」弹窗冷缓存时命中快照秒回，避免再全量
        // 拉一次上游列表（与 index.ts syncDigitalPlatDomains 同一套逻辑）。
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

      // 1.7 自定义服务商分组：无上游 API，读取手动录入的域名做到期提醒（不自动续期）。
      //     域名跨「分组 → 账号」两层，只在遇到第一个 custom 分组时统一处理一次。
      if (provider === "custom") {
        if (!customReminderDone) {
          customReminderDone = true;
          const allCustomDomains = await dbManager.listAllCustomDomains();
          for (const dom of allCustomDomains) {
            const expiresTime = new Date(dom.expires_at).getTime();
            if (Number.isNaN(expiresTime)) continue;
            const remainingDays = (expiresTime - Date.now()) / (1000 * 60 * 60 * 24);
            // 剩余有效期不足阈值（含已过期）时提醒；阈值复用 renew_threshold_days 配置
            if (remainingDays <= renewThresholdDays) {
              const fullDomain = dom.full_domain;
              const label = dom.account_name
                ? `分组: ${dom.group_alias} / 账号: ${dom.account_name}`
                : `分组: ${dom.group_alias}`;
              const msg = remainingDays < 0
                ? `域名 [${fullDomain}]（${label}）已过期 ${Math.ceil(-remainingDays)} 天，请及时处理`
                : `域名 [${fullDomain}]（${label}）将于 ${Math.ceil(remainingDays)} 天后到期`;
              await dbManager.writeLog("warning", "renew", msg);
              expiryReminderLogs.push(`⚠️ ${msg}`);
            }
          }
        }
        continue;
      }

      if (!(client instanceof DNSHEClient)) {
        throw new Error("未知的账号提供商");
      }

      // 2. 分页拉取该账户在 DNSHE 系统的全部域名
      const subdomains = await fetchAllSubdomainsFromClient(client);
      
      // 3. 分批并发获取每个子域名的 DNS 记录，自动计算真实状态（已委派 / 已解析 / 未解析）
      //    使用 batchedPromiseAll 控制每批最多 5 个并发请求，避免触发 Worker 子请求限制。
      const subdomainsWithDnsInfo = await batchedPromiseAll(
        subdomains,
        async (sub) => {
          try {
            const recordsRes = await client.listDnsRecords(sub.id);
            const records = recordsRes.records || [];
            return { ...sub, ...computeDnsState(records) };
          } catch (e) {
            // 子请求配额耗尽时直接向上抛出，由外层 catch 统一处理并中止后续账号同步
            if (isSubrequestLimitError(e)) throw e;
            // 上游临时失败时不带 dns_state_known，缓存中已识别出的三态与托管商保持不变。
            return { ...sub };
          }
        },
        5
      );

      // 4. 同步到本地 cache
      await dbManager.syncAccountDomains(acc.id, subdomainsWithDnsInfo);
      totalSynced += subdomains.length;
      
      // 4. 扫描该账号下的域名，判断是否需要续期
      for (const sub of subdomains) {
        const expiresAt = sub.expires_at as string | undefined;
        if (!expiresAt) continue;

        // 计算到期剩余天数
        const expiresTime = new Date(expiresAt).getTime();
        const nowTime = Date.now();
        const remainingDays = (expiresTime - nowTime) / (1000 * 60 * 60 * 24);

        // NOTE: DNSHE 免费域名有效期为 1 年，且平台允许随时续期。
        // 续期阈值默认 90 天（可在设置页配置 renew_threshold_days）：
        // 剩余有效期不足阈值时自动续期，防止遗忘导致域名过期丢失。
        if (autoRenewEnabled && remainingDays >= 0 && remainingDays <= renewThresholdDays) {
          const subId = sub.id as number;
          const fullDomain = sub.full_domain as string;

          try {
            // 触发续期
            const renewResult = await client.renewSubdomain(subId);
            if (renewResult && renewResult.success) {
              totalRenewSuccess++;
              const newExpiresAt = renewResult.new_expires_at || "";
              
              // 更新本地到期时间缓存
              await dbManager.markDomainRenewed(subId, newExpiresAt);
              
              const msg = `域名 [${fullDomain}] (账户: ${alias}) 自动续期成功！新有效期至: ${newExpiresAt}`;
              await dbManager.writeLog("success", "renew", msg, renewResult);
              renewLogs.push(`✅ ${msg}`);
            } else {
              throw new Error(renewResult.message || "未知原因导致的续期失败");
            }
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : "";
            
            // 针对尚未到免费续期窗口的情况，只作为普通信息记录，避免推送红色警报
            if (errMsg.includes("renewal_not_yet_available") || errMsg.includes("not yet available")) {
              await dbManager.writeLog("info", "renew", `域名 [${fullDomain}] 自动续期请求已提交，但因尚未进入免费续期窗口被拦截，将在后续定时任务中重试。`);
            } else {
              totalRenewFail++;
              const msg = `域名 [${fullDomain}] (账户: ${alias}) 自动续期失败：${errMsg}`;
              await dbManager.writeLog("error", "renew", msg, err instanceof Error ? (err.stack || errMsg) : errMsg);
              renewLogs.push(`❌ ${msg}`);
            }
          }
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "未知错误";
      const stack = e instanceof Error ? (e.stack || message) : message;
      await dbManager.writeLog("error", "sync", `同步账号 [${acc.alias}] 的域名数据失败：${message}`, stack);
      // 子请求配额耗尽后同一次 Worker 调用内的所有后续 fetch() 均会失败，
      // 继续遍历剩余账号只会产生一连串相同错误。提前中止并记录提示日志。
      if (isSubrequestLimitError(e)) {
        await dbManager.writeLog(
          "warning",
          "sync",
          "检测到 Worker 子请求配额已耗尽，跳过剩余账号同步。如频繁出现，请在 wrangler.toml [limits] 中提升 subrequests 上限（需 Workers 付费计划）或减少绑定的账号数量"
        );
        break;
      }
    }
  }

  // 整理并发送总结通知
  const summaryMsg = `自动同步任务结束。本次同步域名数: ${totalSynced} 个，自动续期成功: ${totalRenewSuccess} 个，续期失败: ${totalRenewFail} 个。`;
  await dbManager.writeLog("info", "system", summaryMsg);

  // 自动清理 30 天前的过期日志
  await dbManager.pruneExpiredLogs();

  // 自动清理已过期的缓存行（含 7 天 TTL 的查重池），避免 cache 表只进不出
  const purgedCache = await dbManager.purgeExpiredCache();
  if (purgedCache > 0) {
    await dbManager.writeLog("info", "system", `已清理 ${purgedCache} 条过期缓存记录（含查重池）`);
  }

  // 自动清理已过期会话，避免 settings 表被 sess_ 行无限撑大
  // （鉴权中间件每个请求都要查这张表，行数失控会直接拖慢所有接口）
  const purgedSessions = await dbManager.purgeExpiredSessions();
  if (purgedSessions > 0) {
    await dbManager.writeLog("info", "system", `已清理 ${purgedSessions} 条过期登录会话`);
  }

  // 如果有域名触发了续期，则向配置的通知渠道推送消息
  if (renewLogs.length > 0) {
    const notifyBody = `【DNSHE 域名自动续期报告】\n${summaryMsg}\n\n详细明细：\n${renewLogs.join("\n")}`;
    if (effectiveWebhookUrl) {
      // NOTE: 推送失败要留痕 —— 原先只 console.error，用户在面板里完全看不到，
      // 表现为「续期成功了但一直没收到通知」且无从排查。
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

  // 自定义服务商 / DigitalPlat 域名到期提醒（独立推送，避免与「续期报告」混淆）
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
