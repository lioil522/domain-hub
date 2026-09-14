import { DatabaseManager } from "./db";
import type { SubdomainInfo } from "./dnshe";
import type { UpstreamSubdomain } from "./db";
import { DNSHEClient } from "./dnshe";
import { CloudflareClient, mapZoneToUpstream } from "./cloudflare";
import type { CfZoneInfo } from "./cloudflare";
import { DigitalPlatClient, mapDomainToUpstream } from "./digitalplat";
import { computeDnsState } from "./dns-provider";
import { isRegistrableDomain } from "./punycode";

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

/**
 * Cloudflare zone 列表分片拉取的调参
 *
 * 背景：免费计划每次 Worker 调用只有 50 次子请求，且 [limits] 配置项对免费计划无效
 * （写了也不生效，只能用付费计划）。所以「靠提升上限解决」这条路对免费用户不通，
 * 必须把单次调用的上游请求数压下来。
 *
 * 策略：不预估账号规模，先「探一页」——需要时再继续拉下一页，直到本次配额用完。
 * CF_ZONE_PROBE_PAGES = 1 表示每轮只请求一页（50 条）；一轮能完成说明 zone 数 ≤ 50，
 * 单次调用只花 1 次子请求就拿到权威全量。只有真的超大账号才会进入多轮续拉路径。
 */
const CF_ZONE_PROBE_PAGES = 1;

/**
 * 单个 Cloudflare 账号在**一次定时任务**里的页数预算。
 *
 * 取值偏保守：本轮剩余页数会交给后面的 DNSHE / DigitalPlat 账号用（它们的
 * fetchAllSubdomainsFromClient 是按账号拉一次的固定开销）。宁可让同一个 CF 账号分
 * 两次 cron 拉完，也不要一次吃光配额、把排在后面的账号全饿死 —— 那正是当前报错的成因。
 *
 * NOTE: 导出给 index.ts 复用（手动同步单账号时的页数预算）。
 */
export const CF_ZONE_ROUNDS_PER_RUN = 3;

/** 续拉游标的缓存 TTL（3 天）。定时任务每天一次，留足重试余量后自然过期重头来。 */
export const CF_ZONE_CURSOR_TTL = 3 * 24 * 3600;

/**
 * Cloudflare 域名到期提醒的 RDAP 缓存查询预算（单次定时任务内的硬上限）
 *
 * NOTE: 只读缓存、不主动回源，所以正常情况下这个预算**一次都用不到**（预算只用于
 * 「有多少个域名值得去查缓存」这一层计数，不产生上游请求）。设上限是因为查缓存本身
 * 也要走 D1（每条 SQL 都算子请求）：不给上限的话，zone 数一多，光查缓存就能把
 * 免费计划的 50 次配额吃光 —— 那就把「省配额」的优化变成了新的配额黑洞。
 *
 * 取值 100 的用意：付费计划下只占 1% 配额；免费计划下也只有账号规模极端膨胀时才会摸到。
 * 超出预算的域名本轮直接不提醒（下轮还有机会），滚动覆盖而不是硬失败。
 */
const CF_EXPIRY_BUDGET = 100;

/**
 * 解析记录缓存策略的配置键（写入 settings 表，取值 "scheduled" | "always"）
 *
 * - "scheduled"（默认，推荐）：**定时任务只读缓存**，不逐域名拉 dns_records；
 *   缓存没命中的域名回源补拉并把记录写回缓存。手动同步（面板按钮 / 绑定后后台同步）
 *   一律全量回源，保证用户主动点的时候拿到的是最新真相。
 * - "always"：保留旧行为，定时任务也逐域名回源（子请求开销大，仅在域名极少时可选）。
 *
 * WHY 要让定时任务放过缓存命中项：DNSHE 的三态（已委派/已解析/未解析）在两次同步之间
 * 极少变化，而每个域名 1 次 dns_records 是免费计划 50 次配额的最大头（实测 36 次）。
 * 首轮同步把记录写进 api_cache:dns:<id> 之后，后续定时任务命中缓存即可零上游调用，
 * 且缓存里的记录是当初 computeDnsState 的同一份输入，三态结果与回源完全等价。
 */
export const DNS_RECORDS_CACHE_MODE_KEY = "dns_records_cache_mode";

/**
 * 某个 Cloudflare 账号的 zone 列表续拉游标在 cache 表中的 key
 *
 * NOTE: 导出给 index.ts 复用 —— 手动同步（syncCloudflareZones）与定时任务操作的是
 * 同一个账号的同一份进度，必须共用 key。各用各的会导致「手动拉到第 2 页，定时任务
 * 又从第 1 页重拉」这类互相覆盖，白白多花子请求。
 */
export function cfZoneCursorKey(accountId: number): string {
  return `cf_zone_cursor:${accountId}`;
}

/**
 * 收集本面板管理的 Cloudflare zone 全集（zone 名 → 归属账号名 + zone id），
 * 供 DNSHE 同步时做快路径判断。
 *
 * WHY: DNSHE 每同步一个域名都要花 1 次子请求拉 dns_records 才能推出三态，域名一多就
 * 会把免费计划的 50 次配额吃光。但其中一部分域名其实已经委派到我们**自己绑定的**
 * Cloudflare 账号 —— 这类域名的三态是确定且恒定的（已委派 / Cloudflare），不需要靠
 * 上游解析记录推导；而它的归属账号名与 zone id 这一张表里本来就有，连子请求都不用花。
 *
 * 判据用的是 DNSHE.full_domain ⟷ CF zone.name —— 实测确认 CF zone 的 name 就是完整
 * 域名（子域名 zone 亦然），与 DNSHE 的 full_domain 是同一口径。
 *
 * NOTE: 一律直接用库里的行，不遍历账号列表 —— 这样判据不受「账号遍历顺序」影响，
 * 也不会因为某个 CF 账号排在 DNSHE 账号之后而漏判。
 * NOTE: 拉取失败（表不存在 / 查询报错）时返回空集合，调用方退化为「全部按老路拉记录」，
 * 只损失优化收益，不会让同步出错。
 * NOTE: CF zone 行的 account_alias 是 JOIN accounts 出来的**真实账号名**（与 DNSHE 行
 * 那个「装根域名」的语义不同），可以直接给用户看。
 */
async function collectManagedCfZones(
  dbManager: DatabaseManager
): Promise<Map<string, { alias: string; zoneId: string }>> {
  const zones = new Map<string, { alias: string; zoneId: string }>();
  try {
    const cfRows = await dbManager.getDomains("", "", undefined, "cloudflare");
    for (const row of cfRows) {
      const name = String(row.full_domain || "").trim().toLowerCase();
      if (!name) continue;
      // 同一 zone 名理论上只存在于一个 CF 账号下；真撞名时保留先遇到的（账号归属本就唯一）
      if (!zones.has(name)) {
        zones.set(name, {
          alias: String(row.account_alias || `账号 ${row.account_id}`),
          zoneId: String(row.remote_id || ""),
        });
      }
    }
  } catch (e) {
    console.error("collectManagedCfZones failed, fallback to full dns_records fetch:", e);
  }
  return zones;
}

/**
 * 为「已确认委派到本面板某个 CF 账号」的域名解析出真实归属账号名与 zone id。
 *
 * WHY 不能直接采信 mapZoneToUpstream 写进 rows 的那个 alias：mapZoneToUpstream 走的是
 * 通用 DNSHE 语义，`account_alias` 字段装的是**根域名**（比如 `ddns.ge`），不是 CF
 * 账号别名。要给出「托管在 [某账号]」这种用户能对得上的提示，必须按 host 反查真正的
 * CF zone 行。
 *
 * NOTE: 正常情况下这条路**一次子请求都不会发** —— collectManagedCfZones 已经在库里
 * 找到了该 host 对应的 CF zone 行（含真实账号名与 zone id）。只有当那个 CF 账号
 * 尚未同步过、库里没有它的 zone 行时，才退化为回源反查（逐页串行、命中即停）。
 */
async function resolveCfZoneOwner(
  dbManager: DatabaseManager,
  accountId: number,
  host: string,
  cachedZoneCursor?: WeakMap<CloudflareClient, number>
): Promise<{ alias: string; zoneId: string } | null> {
  try {
    const { client, alias } = await dbManager.getClientForAccount(accountId);
    if (!(client instanceof CloudflareClient)) return null;

    // 同一轮同步里多个待反查域名共用同一个 CF 账号：缓存已翻过的页数，避免每个域名
    // 都从第 1 页重扫一遍。
    let page = cachedZoneCursor?.get(client) ?? 1;
    for (let guard = 0; guard < 50; guard++) {
      const res = await client.listZones({ startPage: page, maxPages: 1 });
      const hit = res.zones.find((z) => String(z.name || "").trim().toLowerCase() === host);
      if (hit) {
        cachedZoneCursor?.set(client, page);
        return { alias, zoneId: String(hit.id || "") };
      }
      if (!res.hasMore) break;
      page = res.nextPage;
      cachedZoneCursor?.set(client, page);
    }
    return null;
  } catch (e) {
    console.error(`resolveCfZoneOwner failed for ${host}:`, e);
    return null;
  }
}

/** zone 列表续拉游标 */
export interface CfZoneCursor {
  /** 下一次续拉要请求的页码（1 表示从头开始核对） */
  startPage: number;
  /** 本账号在游标周期内已同步过的 zone 数量（用于完成时汇报总数） */
  syncedBefore: number;
}

/**
 * 读取 Cloudflare zone 列表续拉游标
 *
 * NOTE: 读失败/解析失败一律退回「从头开始」，绝不因为缓存脏数据让同步卡死；
 * 游标为空的字符串（拉完时写入的归零标记）同样退回默认值。
 */
export async function readCfZoneCursor(dbManager: DatabaseManager, key: string): Promise<CfZoneCursor> {
  const fallback: CfZoneCursor = { startPage: 1, syncedBefore: 0 };
  try {
    const raw = await dbManager.getCache(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<CfZoneCursor>;
    const startPage = Number(parsed?.startPage);
    const syncedBefore = Number(parsed?.syncedBefore);
    return {
      startPage: Number.isFinite(startPage) && startPage >= 1 ? Math.floor(startPage) : 1,
      syncedBefore: Number.isFinite(syncedBefore) && syncedBefore > 0 ? Math.floor(syncedBefore) : 0
    };
  } catch {
    return fallback;
  }
}

/**
 * 账号分批轮转的调参
 *
 * 背景：免费计划每次 Worker 调用只有 50 次子请求，而账号遍历原先是一条 `for` 走到底 ——
 * 谁先把配额吃光谁就 `break`，排在后面的账号**永远不会被同步到**（不是慢，是彻底饿死）。
 * 账号越多这个缺陷越致命：线上 10 个 CF 账号 / 55 zone 的情况下，前面两三个账号就能
 * 吃掉整份配额，后面七八个账号长期处于「上次同步于几天前」的状态。
 *
 * 解法：把「一次调用跑完全部账号」改成「一次调用只跑 N 个账号 + 游标记录进度」，
 * 配合 wrangler.toml 里配置的多个 cron 触发器（错开时间），一天内多轮滚动推进。
 * 于是单次调用的子请求数被压到 N 个账号能容纳的范围内，而所有账号都有机会被轮到。
 *
 * 为什么 N 取 5：免费计划 50 次配额下，留出余量给「单个账号内部的 dns_records 循环」
 * （腿一/腿二已把它压到接近 0，但首轮冷缓存仍需回源）。5 个账号 × 若干次 ≈ 安全区。
 * 调大 N 会让单轮更容易撞配额上限，调小则账号被轮到的间隔变长。
 */
const SYNC_ACCOUNT_BATCH_SIZE = 5;

/** 账号轮转游标在 cache 表中的 key（全局单游标，所有类型账号共用一条环） */
const ACCOUNT_CURSOR_KEY = "sync:cursor:accounts";

/**
 * 账号轮转游标：记录「上一轮处理到哪个账号」。
 *
 * 语义是**环**而不是队列：处理到末尾后回绕到开头继续，永不终止。
 * lastId 存的是上一轮**最后一个**被处理账号的 id，下一轮从它的后继开始。
 */
export interface AccountCursor {
  /** 上一轮最后一个被处理的账号 id；0 表示还没有过轮转记录（从头开始） */
  lastId: number;
  /** 累计轮转轮次，仅用于日志可读性 */
  rounds: number;
}

/**
 * 读取账号轮转游标
 *
 * NOTE: 读失败 / 解析失败 / 值为空一律退回「从头开始」，绝不因为脏缓存让同步卡死 ——
 * 最坏后果只是这一轮重复处理开头的几个账号（幂等操作，无副作用）。
 */
async function readAccountCursor(dbManager: DatabaseManager): Promise<AccountCursor> {
  const fallback: AccountCursor = { lastId: 0, rounds: 0 };
  try {
    const raw = await dbManager.getCache(ACCOUNT_CURSOR_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<AccountCursor>;
    const lastId = Number(parsed?.lastId);
    const rounds = Number(parsed?.rounds);
    return {
      lastId: Number.isFinite(lastId) && lastId > 0 ? Math.floor(lastId) : 0,
      rounds: Number.isFinite(rounds) && rounds > 0 ? Math.floor(rounds) : 0
    };
  } catch {
    return fallback;
  }
}

/**
 * 从全量账号列表里切出本轮要处理的一批（环状，必然返回 batchSize 个，除非账号总数更少）
 *
 * WHY 按 id 环状切片而不是「跳过已完成的」：同步是幂等操作，重复处理一个账号只是多花
 * 一点配额，而漏掉一个账号会让它的域名数据无限期陈旧。所以宁可偶尔重复，不可遗漏。
 *
 * NOTE: 账号列表已按 id ASC 排序（getAccounts 的 ORDER BY）。这里不做额外排序 ——
 * 依赖调用方保证有序，若将来 getAccounts 改了排序，本函数会退化为「按给的顺序切」，
 * 依然能遍历所有账号，只是环的形态不同，不会漏账号。
 */
export function pickAccountBatch<T extends { id: number }>(
  accounts: T[],
  cursor: AccountCursor,
  batchSize: number
): { batch: T[]; nextCursor: AccountCursor } {
  if (accounts.length === 0) {
    return { batch: [], nextCursor: cursor };
  }
  // 找到游标的后继位置：上一个处理完的账号之后开始
  let start = 0;
  let wrapped = false;
  if (cursor.lastId > 0) {
    const idx = accounts.findIndex((a) => a.id > cursor.lastId);
    if (idx === -1) {
      // 找不到比 lastId 更大的 id 说明已到环尾 → 回绕到开头，本圈结束
      start = 0;
      wrapped = true;
    } else {
      start = idx;
    }
  }
  const size = Math.min(batchSize, accounts.length);
  const batch: T[] = [];
  for (let i = 0; i < size; i++) {
    batch.push(accounts[(start + i) % accounts.length]);
  }
  const last = batch[batch.length - 1];
  return {
    batch,
    // 回绕过（游标已到环尾并从头开始）时 rounds 自增，仅用于日志可读性
    nextCursor: {
      lastId: last ? last.id : cursor.lastId,
      rounds: cursor.rounds + (wrapped ? 1 : 0)
    }
  };
}

/**
 * 三类只读到期提醒的集中处理（Cloudflare / DigitalPlat / 自定义分组）
 *
 * WHY 集中成一个函数、且在账号遍历**之前**调用：
 * 这三类提醒的共同点是**只读本地库**（最多加一次 RDAP 缓存查询），不产生上游子请求。
 * 原先它们各自挂在账号遍历的分支里，用 `xxxReminderDone` 标志做「遇到第一个该类型账号
 * 时统一处理一次」的去重。在「一次调用遍历全部账号」的旧模型下这没问题，但账号分批
 * 轮转后，某批次可能完全不含某类型账号 —— 提醒就会被整轮静默跳过，表现为「提醒时有时无」。
 *
 * 现在与批次彻底解耦：每轮 cron 都完整检查一遍。因为只读库，重复执行的代价仅是几次
 * D1 查询，换来的是提醒行为稳定可预期。
 *
 * 三类提醒的语义差别（读不到到期时间时一律**跳过**，绝不当作「不过期」）：
 *   - Cloudflare：zone 对象无到期字段，来源是①手动手动录入 ②RDAP 缓存（不主动回源）
 *   - DigitalPlat：到期时间随 listDomains 落库，直接读 domains_cache
 *   - 自定义分组：到期时间由用户录入在 custom_domains
 *
 * NOTE: 整个函数包在 try/catch 内由调用方兜底 —— 提醒是同步任务的附加项，
 * 绝不能因为它失败而中断域名同步。
 */
async function collectExpiryReminders(
  dbManager: DatabaseManager,
  renewThresholdDays: number,
  out: string[]
): Promise<void> {
  // ── ① Cloudflare ────────────────────────────────────────────────
  // 数据源两级：手动录入（domain_date_overrides，零子请求，优先级最高）> RDAP 缓存。
  // ⚠️ 不主动回源：CF 域名按 zone 计，线上可达几十上百，逐个回源会把免费计划 50 次
  // 配额直接打满，而 DNSHE 的解析记录拉取还要用同一份配额。代价是「用户没打开过
  // Cloudflare 页的注册域本轮不提醒」，换来的 cron 额外上游请求恒为 0。
  try {
    const cfZones = await dbManager.getDomains("", "", undefined, "cloudflare");
    if (cfZones.length > 0) {
      const accountIds = Array.from(new Set(cfZones.map((z) => z.account_id)));

      // 批量读手动覆盖 + 批量读 RDAP 缓存：各是一次 D1 往返，不逐域名查
      const manualByAccount = await dbManager.getDateOverridesByAccountIds(accountIds);
      const registrableHosts: string[] = [];
      const seenHost = new Set<string>();
      for (const z of cfZones) {
        const host = String(z.full_domain || "").trim().toLowerCase();
        if (!host || seenHost.has(host)) continue;
        seenHost.add(host);
        // RDAP 注册局只登记「注册域」，子域查不到也没必要占预算
        if (isRegistrableDomain(host)) registrableHosts.push(host);
      }
      // 预算封顶：超出的域名本轮不查缓存、不提醒（下轮还有机会），避免 D1 往返失控
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
        // 优先级：手动录入 > RDAP 缓存。两者都没有 → 无到期信息，跳过
        // （绝不能当成「不过期」处理，否则查不到的 zone 会被静默认定为安全）
        const manualHit = manualByAccount.get(z.account_id)?.get(host);
        const expiresAt = manualHit || rdapCache.get(host) || "";
        if (!expiresAt || expiresAt.startsWith("0000")) continue;
        const expiresTime = new Date(expiresAt).getTime();
        if (Number.isNaN(expiresTime)) continue;
        const remainingDays = (expiresTime - Date.now()) / (1000 * 60 * 60 * 24);
        // 剩余有效期不足阈值（含已过期）时提醒；阈值与 DP / 自定义分组共用 renew_threshold_days
        if (remainingDays <= renewThresholdDays) {
          const alias = z.account_alias || `账号 ${z.account_id}`;
          const src = manualHit ? "手动录入" : "RDAP";
          const msg = remainingDays < 0
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
  // 读已同步到库的域名（不拉上游）。DP 不自动续期，只提醒用户前往注册局处理。
  try {
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
        out.push(`⚠️ ${msg}`);
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "未知错误";
    await dbManager.writeLog("error", "renew", `DigitalPlat 域名到期检查失败：${message}`);
  }

  // ── ③ 自定义服务商分组 ──────────────────────────────────────────
  // 无上游 API，域名与到期时间均为用户手动录入。域名跨「分组 → 账号」两层。
  try {
    const allCustomDomains = await dbManager.listAllCustomDomains();
    for (const dom of allCustomDomains) {
      // 永久域名（0000 占位）没有到期概念，跳过提醒
      if (!dom.expires_at || dom.expires_at.startsWith("0000")) continue;
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
        out.push(`⚠️ ${msg}`);
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "未知错误";
    await dbManager.writeLog("error", "renew", `自定义分组域名到期检查失败：${message}`);
  }
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

  // 【腿二】定时任务是否只读解析记录缓存（默认开启；手动同步永远全额回源）
  // 配置项缺失时按 "scheduled" 处理 —— 默认走省配额的那条路。
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
  // 自定义服务商（无 API）域名到期提醒明细，与续期明细分开推送
  const expiryReminderLogs: string[] = [];

  // ─── 到期提醒统一前置（与账号分批解耦）───────────────────────────────
  //
  // WHY 从主循环里搬出来：原实现把三类提醒分别挂在「遇到第一个该类型账号」的分支里，
  // 靠 customReminderDone / dpReminderDone / cfReminderDone 三个标志去重。在「一次调用
  // 遍历全部账号」的旧模型下这没问题（批次必然包含全部类型）。
  //
  // 但改成账号分批轮转后，某个批次里可能**一个 CF 账号都没有** —— 那些提醒就会整轮
  // 静默跳过，用户看到的是「提醒时有时无」。提醒本身只读库、不产生上游子请求
  // （CF 那条也明确只读 RDAP 缓存），所以完全没必要绑在账号遍历上。
  //
  // 现在统一前置执行一次，语义更简单也更可靠：每轮 cron 都完整检查一遍到期情况。
  await collectExpiryReminders(dbManager, renewThresholdDays, expiryReminderLogs);

  // 账号分批轮转：本轮只处理 SYNC_ACCOUNT_BATCH_SIZE 个账号，从游标处继续，环状推进。
  //
  // WHY 要分批：免费计划单次调用 50 次子请求是硬限，而账号遍历原先是一条 for 走到底，
  // 「谁先吃光配额谁 break」→ 排在后面的账号**长期饿死**（不是慢，是永远轮不到）。
  // 分批 + 游标让每个账号都有机会被轮到，代价是单个账号的同步间隔从 1 天变成
  // ceil(账号数 / N) 天（10 个账号 / N=5 → 2 天一轮）。
  //
  // NOTE: 手动同步（isScheduled=false）不分批 —— 用户显式点「同步」时应当立刻看到
  // 全部账号的最新数据，而不是被游标切成几份。分批只作用于定时任务。
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

  // 本批次里最后一个**成功处理完**的账号 id，用于配额耗尽时把游标停在断点
  let lastProcessedId = cursorBefore.lastId;
  // 本轮是否因配额耗尽而提前中断
  let quotaExhausted = false;

  for (const acc of accountsThisRun) {
    // 先记为本轮已处理 —— 循环体里有多处 continue（CF/DP/custom 各自短路），
    // 放在末尾更新会漏掉那些分支。语义上「进入处理」即算覆盖到，配额耗尽时
    // 游标停在这里，下一轮从它的后继继续，不会漏账号。
    lastProcessedId = acc.id;
    try {
      // 1. 获取解密后的 API 客户端
      const { client, alias, provider } = await dbManager.getClientForAccount(acc.id);

      // 1.5 Cloudflare 账号：只同步 zone 列表。zone 的有效期由注册商管理，
      //     不存在 DNSHE 式续期，直接跳过续期扫描。
      //
      // NOTE: 这里刻意不像其它提供商那样「一次调用拉全」。Cloudflare zone 列表是唯一
      // 会随账号规模线性增长、且量大到能单独打满子请求配额的资源（/zones 分页每页 50 条，
      // 一个 300 zone 的账号光列表就要 6 次子请求；再叠加 DNSHE 账号逐个域名拉
      // dns_records，免费计划 50 次配额极易在 CF「超大账号」这一环就耗尽，
      // 报错 "Too many subrequests by single Worker invocation"，后面的账号全部同步失败）。
      // 改为按页配额分片：每次调用最多拉 CF_ZONE_ROUNDS_PER_RUN 页，未拉完就把游标写进
      // cache，下次定时任务接着拉；已拉到的分片先落库，只增不删（见 upsertAccountDomains）。
      // 只有拉完最后一页（hasMore=false）的那次调用才走 syncAccountDomains 做差集清理。
      if (provider === "cloudflare") {
        if (!(client instanceof CloudflareClient)) {
          throw new Error("Cloudflare 账号客户端异常");
        }

        // NOTE: zone 到期提醒已上移到主循环之前统一执行（见 collectExpiryReminders），
        // 不再依赖「本批次恰好包含 CF 账号」—— 分批轮转下那个前提不成立。

        const cursorKey = cfZoneCursorKey(acc.id);
        const cursor = await readCfZoneCursor(dbManager, cursorKey);

        let zones: CfZoneInfo[] = [];
        for (let page = cursor.startPage, round = 0; round < CF_ZONE_ROUNDS_PER_RUN; round++) {
          const res = await client.listZones({ startPage: page, maxPages: CF_ZONE_PROBE_PAGES });
          zones = zones.concat(res.zones);
          if (!res.hasMore) {
            // 上游列表已拉完 —— 这是权威全量，可以安全地做差集删除（清理上游已删的 zone）
            const total = cursor.syncedBefore + zones.length;
            await dbManager.syncAccountDomains(acc.id, zones.map(mapZoneToUpstream));
            await dbManager.setCache(cursorKey, "", 1); // 游标归零，下次从第 1 页重新核对
            totalSynced += total;
            await dbManager.writeLog(
              "info",
              "sync",
              `Cloudflare 账号 [${alias}] zone 列表同步完成，本账号共 ${total} 个 zone`
            );
            break;
          }
          // 本页满员但被本次调用的页数上限截断 —— 先落库本批分片（只增不删），
          // 游标写入（含已同步数量），留待下次定时任务从下一页续拉。
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

      // 1.6 DigitalPlat 账号：只同步域名列表（自带注册商侧到期时间）。续期需走注册局
      //     支付流程（报价 + 订单），无法静默自动续期，跳过续期扫描。
      //     NS 已随同步持久化到 cache 表（dp_ns_sync:<域名>，无过期），不随每日定时
      //     重复拉取上游以省 API Key 调用：定时任务直接跳过该账号，手动同步才回源刷新。
      if (provider === "digitalplat") {
        if (!(client instanceof DigitalPlatClient)) {
          throw new Error("DigitalPlat 账号客户端异常");
        }
        // NOTE: DP 到期提醒已上移到主循环之前统一执行（见 collectExpiryReminders）。
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

      // 1.7 自定义服务商分组：无上游 API，不产生任何子请求。
      //     NOTE: 到期提醒已上移到主循环之前统一执行（见 collectExpiryReminders）。
      if (provider === "custom") {
        continue;
      }

      if (!(client instanceof DNSHEClient)) {
        throw new Error("未知的账号提供商");
      }

      // 2. 分页拉取该账户在 DNSHE 系统的全部域名
      const subdomains = await fetchAllSubdomainsFromClient(client);

      // 2.5 已被本面板管理的 CF zone 走快路径，跳过 dns_records 拉取。
      //
      // 先收一遍「本面板所有 CF 账号的 zone 名」全集，再把本账号域名分成两拨：
      //   - 命中 CF zone 全集 → 三态恒定（已委派 / Cloudflare），不需要解析记录；
      //   - 其余 → 老实逐个拉 dns_records 推导三态（或命中记录缓存，见 2.6）。
      // 这在「CF 账号多、DNSHE 域名多」的线上环境收益最大（每个命中省 1 次子请求）。
      //
      // NOTE: 这是纯 fail-safe 优化 —— collectManagedCfZones 失败时集合为空，全部域名
      // 退化为老路径；某个 CF 账号尚未同步过、库里没有它的 zone 行时，回源反查一次
      // （resolveCfZoneOwner），查不到就保留库里的旧归属，都不影响正确性。
      const cfZones = await collectManagedCfZones(dbManager);
      const cfFastPath = new Map<number, { alias: string; zoneId: string }>();

      for (const sub of subdomains) {
        const host = String(sub.full_domain || "").trim().toLowerCase();
        const zone = host ? cfZones.get(host) : undefined;
        if (!zone) continue;
        // 库里已有该 zone 行时信息齐全（真实账号名 + zone id），零子请求；
        // 库里的 zone 行还没同步过时才回源反查。
        cfFastPath.set(sub.id, zone);
      }

      // 2.6 【腿二】记录缓存命中，同样跳过 dns_records 拉取。
      //
      // 缓存里的记录就是当初 computeDnsState 的输入，拿它重算三态与回源结果完全等价，
      // 所以这不是「用旧数据糊弄」，而是省掉一次纯冗余的往返。
      // 只有定时任务走这条路（dnsCacheOnlyOnScheduled）；手动同步全额回源。
      //
      // NOTE: 与腿一不同，这里的行**必须**重新过一遍 computeDnsState —— 缓存只提供了
      // 记录本身，给不出三态；顺着算出来的托管商才是权威值。
      const dnsRecordsCache = dnsCacheOnlyOnScheduled
        ? await dbManager.getDnsRecordsCacheBatch(
            subdomains.filter((sub) => !cfFastPath.has(sub.id)).map((sub) => sub.id)
          )
        : new Map<number, unknown[]>();
      const cacheFastPath = new Set<number>(dnsRecordsCache.keys());

      // 3. 分批并发获取每个子域名的 DNS 记录，自动计算真实状态（已委派 / 已解析 / 未解析）
      //    使用 batchedPromiseAll 控制每批最多 5 个并发请求，避免触发 Worker 子请求限制。
      //
      // NOTE: 结果按 UpstreamSubdomain[] 收集 —— DNSHE 的 SubdomainInfo 类型里没有
      // dns_provider / remote_id（那是 db 层写入契约的字段），但落库走的是
      // UpstreamSubdomain 的形状，这里的 spread 在运行时本就带着额外字段。
      const needDnsFetch = subdomains.filter(
        (sub) => !cfFastPath.has(sub.id) && !cacheFastPath.has(sub.id)
      );
      const subdomainsWithDnsInfo: UpstreamSubdomain[] = await batchedPromiseAll(
        needDnsFetch,
        async (sub): Promise<UpstreamSubdomain> => {
          try {
            const recordsRes = await client.listDnsRecords(sub.id);
            const records = recordsRes.records || [];
            // 顺手回填缓存：下次定时任务就能命中这里，不再回源
            await dbManager.setCache(`api_cache:dns:${sub.id}`, JSON.stringify(records));
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

      // 3.2 缓存命中的行：用缓存里的记录重算三态（零子请求）
      for (const sub of subdomains) {
        const records = dnsRecordsCache.get(sub.id);
        if (!records) continue;
        // 缓存里的记录形态与上游返回一致（当初就是整体 JSON.stringify 存进去的），
        // 断言成 computeDnsState 的入参形状；它只读 type / content 两个字段。
        subdomainsWithDnsInfo.push({
          ...sub,
          ...computeDnsState(records as Array<{ type?: string; content?: unknown }>)
        });
      }

      // 3.5 CF 快路径行带上 dns_state_known（三态由 CF zone 背书），并入待写入列表
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
          // DNSHE 行本不带 zone id（remote_id 是 CF 行的字段），库里能查到就补上
          remote_id: zone.zoneId || undefined
        });
      }

      // 4. 同步到本地 cache
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
      //
      // NOTE: 这里不再建议用户去改 wrangler.toml 的 [limits] —— 该配置项对免费计划
      // 无效（写了也不生效），把用户引向一条走不通的路。应用侧已对大户（Cloudflare
      // zone 列表、DNSHE 的 dns_records）做了分片续拉，正常情况下不该再撞上限；
      // 真撞上了说明单个账号规模已超出单次调用能承载的极限，可行的办法只有拆分账号
      // （把域名分散到多个 API Token 下）或升级 Workers 付费计划。
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

  // 推进账号轮转游标 —— 环状推进到本轮最后一个**成功处理**的账号之后。
  //
  // ⚠️ 关键：配额耗尽中断时**不推进**游标，而是把它停在最后一个成功处理的账号上。
  // 否则中途 break 会让游标越过那些没跑到的账号，它们要等整整一圈才会被再次轮到 ——
  // 那就把「分批」退化成了另一种形式的漏同步。停在断点则下一轮立刻从缺口处补上。
  if (isScheduled && accounts.length > 0) {
    const advancedCursor = quotaExhausted
      ? { lastId: lastProcessedId, rounds: cursorBefore.rounds }
      : nextCursor;
    // lastId 为 0（第一个账号就失败）时保持原游标不动，避免写进一个无效值
    if (advancedCursor.lastId > 0) {
      await dbManager.setCache(ACCOUNT_CURSOR_KEY, JSON.stringify(advancedCursor));
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
