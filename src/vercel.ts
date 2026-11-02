/**
 * Vercel Domains / DNS API 客户端封装
 *
 * NOTE: 与 CloudflareClient / DigitalPlatClient / DnspodClient / AlidnsClient /
 * HuaweiCloudClient 保持同一套路由协作约定 —— listDnsRecords / createDnsRecord /
 * updateDnsRecord / deleteDnsRecord 方法签名一致，index.ts 路由层按账号 provider 分发。
 *
 * 认证走 Bearer Token（Vercel 个人 Access Token，在
 * vercel.com/account/tokens 创建）。与 Cloudflare 的最大相似之处是单 Token 形态，
 * 差异在于 Vercel 没有「账号」层级 —— Token 直接对应一个个人账号或 Team。
 *
 * NOTE: 该文件只依赖标准 fetch / crypto.subtle，两个运行时都能跑，不使用 Workers 专属 API。
 *
 * 与 Cloudflare 的关键结构差异：
 *   1. 域名（Domain）与 DNS 记录是两级资源，路径为 `/v5/domains/{domain}/records`；
 *   2. 没有 zone id —— 域名本身就是路径参数（remote_id 存域名）；
 *   3. 记录名 `name` 是**相对名**（`@` / `www`），与 DNSPod / 阿里云相同、与 CF 相反；
 *   4. 分页用 `limit` + `since`/`until` 游标，不是页码。这里用 limit 一次拉满
 *      （Vercel 上限 100），需要更多时按 until 续拉。
 *   5. 带 Team 的账号需要在 query 里附加 `teamId`；本客户端在构造时可选接收，
 *      teamId 从域名详情里自动探测并缓存。
 */

import type { ActionResponse, CreateDnsRecordResponse, DnsRecordInfo, ListDnsRecordsResponse } from "./dnshe";
import type { UpstreamSubdomain } from "./db";
import { ProviderApiError, incompleteResponse } from "./errors/provider-api-error";
import { parseProviderJson, requestProviderText, type ProviderRequestLimits } from "./providers/provider-request";
import { CompleteList, domainKey, hasText, isCount, isObject } from "./providers/list-integrity";
import { zoneIdToNumericId } from "./cloudflare";

const VERCEL_API_BASE = "https://api.vercel.com";

/** 单次列表请求的条数（Vercel 上限 100） */
const VERCEL_PAGE_SIZE = 100;

/** 列表接口最多翻多少页；耗尽预算不是完整列表。 */
const VERCEL_MAX_PAGES = 20;

function nextUntil(pagination: unknown, length: number, previous?: number): number | null {
  if (!isObject(pagination) || !isCount(pagination.count) || pagination.count !== length) {
    throw incompleteResponse("vercel");
  }
  if (pagination.next === null) return null;
  const next = pagination.next;
  if (!isCount(next) || next === 0 || length === 0 || (previous !== undefined && next >= previous)) {
    throw incompleteResponse("vercel");
  }
  return next;
}

/**
 * 判断一个字符串是否形如 Vercel Access Token
 *
 * NOTE: Vercel Token 没有固定前缀（形如 24 位随机串），这里只做「像不像一个 token」
 * 的粗筛：长度足够且不含空白。真正的校验交给 verifyToken（调 /v2/user）。
 */
export function looksLikeVercelToken(value: string): boolean {
  const s = String(value || "").trim();
  return s.length >= 20 && !/\s/.test(s);
}

/** Vercel 域名信息（GET /v5/domains 返回，只保留面板需要的字段） */
export interface VercelDomainInfo {
  id?: string;
  name?: string;
  /** 域名是否已正确指向 Vercel（NS 或 A/CNAME 方式） */
  verified?: boolean;
  /** Vercel 侧配置的 NS 列表（指向 Vercel 托管时非空） */
  nameservers?: string[];
  createdAt?: number;
  expiresAt?: number;
  /** 域名是否由 Vercel 托管解析（v5 返回的配置状态） */
  serviceType?: string;
  /** Team 场景下该域名归属的 team id */
  teamId?: string;
  /** 是否为 Vercel 注册的域名（registrar 场景） */
  registrar?: string;
}

/** Vercel DNS 记录原始形状 */
interface VercelDnsRecord {
  id: string;
  /** 部分响应版本用 uid 而非 id 标识记录（兼容两套口径） */
  uid?: string;
  slug?: string;
  name: string;
  type: string;
  value: string;
  ttl?: number;
  mxPriority?: number;
  priority?: number;
  creator?: string;
  created?: number;
  updated?: number;
}

/** Vercel 统一错误响应 */
interface VercelErrorBody {
  error?: { code?: string; message?: string };
  message?: string;
}

/**
 * Vercel 的 `createdAt` / `expiresAt` 是毫秒时间戳，转成面板惯例的 datetime 字符串
 *
 * NOTE: 为 0 或缺失时返回空串，由调用方落「永久」占位。
 */
function msToDatetime(value: number | undefined): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * 把 Vercel 记录映射为与 DNSHE 一致的内部形状
 *
 * NOTE: Vercel 的 `name` 是相对名（`@` / `www`），面板统一以完整域名展示，这里补全。
 * MX 的优先级字段名在实测中有 `mxPriority` 与 `priority` 两种，两个都读。
 */
function mapVercelRecord(rec: VercelDnsRecord, domainName: string): DnsRecordInfo {
  const host = String(rec.name || "").trim();
  const zone = String(domainName || "").trim().toLowerCase();
  const fqdn = !host || host === "@" ? zone : host.toLowerCase().endsWith(`.${zone}`) ? host.toLowerCase() : `${host.toLowerCase()}.${zone}`;
  const rawPriority = Number(rec.mxPriority ?? rec.priority);

  return {
    id: rec.id || rec.uid!,
    name: fqdn,
    type: String(rec.type || "").toUpperCase(),
    content: String(rec.value || ""),
    // Vercel 的 ttl 可以为 null 表示「自动」，面板统一给 60（Vercel 的中档默认）
    ttl: Number(rec.ttl) > 0 ? Number(rec.ttl) : 60,
    priority: Number.isFinite(rawPriority) && rawPriority >= 0 ? rawPriority : null,
    line: null,
    proxied: false,
  };
}

/**
 * 把主机记录转为 Vercel 要求的相对名
 *
 * NOTE: Vercel 的 records 接口只接受 `@` 或相对名。路由层的 normalizeDnsRecordName
 * 已产出相对名，这里是第二道保险（兼容批量编辑回填完整域名）。
 */
function toRelativeRecordName(name: string, domainName: string): string {
  const trimmed = String(name || "").trim().replace(/\.+$/, "");
  if (!trimmed || trimmed === "@") return "@";
  const zone = String(domainName || "").trim().toLowerCase().replace(/\.+$/, "");
  const lowered = trimmed.toLowerCase();
  if (zone && lowered === zone) return "@";
  if (zone && lowered.endsWith(`.${zone}`)) {
    return lowered.slice(0, -(zone.length + 1)) || "@";
  }
  return lowered;
}

/**
 * 把 Vercel 域名映射为 domains_cache 的上游行
 *
 * NOTE: 数值主键复用 zoneIdToNumericId，哈希输入加 `vercel:` 前缀做命名空间隔离。
 * remote_id 存域名本身（Vercel 的记录接口以域名为路径参数，没有 zone id）。
 * Vercel 域名没有「注册到期」概念（除非用 Vercel Registrar），expiresAt 为 0 时
 * 落 0000 占位由前端显示「永久」。
 *
 * dns_provider 恒为 "Vercel"：能出现在这个账号下的域名，其解析要么由 Vercel 托管，
 * 要么记录接口会直接报错（前端会给出「该域名未托管在 Vercel」的提示）。区分托管状态
 * 交给 has_dns 表达 —— verified 为真视为可在面板管理解析。
 */
export function mapVercelDomainToUpstream(domain: VercelDomainInfo): UpstreamSubdomain {
  const domainName = String(domain.name || "").trim();
  const nameservers = Array.isArray(domain.nameservers) ? domain.nameservers.map((ns) => String(ns)) : [];

  return {
    id: zoneIdToNumericId(`vercel:${domainName}`),
    subdomain: "",
    rootdomain: domainName,
    full_domain: domainName,
    // 面板展示用：verified 的显示 VERCEL_VERIFIED，未验证的显示 PENDING
    status: domain.verified ? "VERIFIED" : "PENDING",
    created_at: msToDatetime(domain.createdAt),
    expires_at: msToDatetime(domain.expiresAt) || "0000-00-00 00:00:00",
    has_dns: 1,
    dns_provider: "Vercel",
    provider_account_id: domain.teamId || null,
    remote_id: domainName,
    dns_state_known: true,
    ns1: nameservers[0],
    ns2: nameservers[1],
  };
}

/**
 * Vercel API 请求封装类
 */
export class VercelClient {
  private token: string;
  private teamId: string;

  constructor(token: string, teamId?: string, private readonly requestLimits: ProviderRequestLimits = {}) {
    this.token = String(token || "").trim();
    this.teamId = String(teamId || "").trim();
  }

  /**
   * 设置 Team 上下文（Team 账号下的域名/记录请求必须在 query 里带 teamId）
   *
   * 由 listDomains 在发现域名带 teamId 时自动调用，也可由调用方显式设置。
   */
  setTeamId(teamId: string): void {
    this.teamId = String(teamId || "").trim();
  }

  /**
   * 通用请求封装 —— 非 2xx 时抛出带上游信息的中文异常
   */
  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown } = {}
  ): Promise<T> {
    const url = new URL(VERCEL_API_BASE + path);
    if (options.query) {
      for (const [key, val] of Object.entries(options.query)) {
        if (val !== undefined && val !== null && val !== "") {
          url.searchParams.append(key, String(val));
        }
      }
    }
    // Team 上下文：所有请求统一附加，避免逐个接口漏写
    if (this.teamId && !url.searchParams.has("teamId")) {
      url.searchParams.append("teamId", this.teamId);
    }

    const result = await requestProviderText("vercel", url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }, this.requestLimits);
    const { response, retryAfterMs } = result;

    if (response.status === 204) {
      return {} as T;
    }

    const data = parseProviderJson("vercel", result);

    if (!response.ok || (isObject(data) && isObject(data.error))) {
      const body = data as VercelErrorBody;
      throw new ProviderApiError("vercel", response.status, body?.error?.code || "request_failed",
        result.rateLimited ? "Vercel API 请求过于频繁被限流，请稍后重试"
          : translateVercelError(body?.error?.code || "", body?.error?.message || body?.message || "", response.status),
        undefined, retryAfterMs, result.rateLimited
      );
    }

    return data as T;
  }

  /**
   * 校验 Token 有效性（GET /v2/user），同时返回用户名用于自动别名
   */
  async verifyToken(): Promise<{ id: string; username?: string; email?: string }> {
    const user = await this.request<{ user?: { id?: string; username?: string; email?: string } }>("GET", "/v2/user");
    const u = user?.user || {};
    return { id: String(u.id || ""), username: u.username, email: u.email };
  }

  /**
   * 列出 Token 可访问的全部域名
   *
   * NOTE: Vercel 的分页是 `limit` + `since`/`until` 时间游标（不是页码）。这里先取
   * 一页 100 条；用 pagination.next 作为 until 向旧数据翻页，只有显式 next=null
   * 才结束。不能靠短页或最后一条的时间戳推测完成。
   *
   * Team 探测：Vercel 的 /v5/domains 在个人 Token 下会返回个人账号 + 其所属 Team 的
   * 域名（取决于 Token 权限），每条自带 teamId。这里在拿到列表后把第一个出现的
   * teamId 记下来供后续记录类请求使用。
   */
  async listDomainsPage(until?: number) {
    const res = await this.request<{ domains?: VercelDomainInfo[]; pagination?: unknown }>("GET", "/v5/domains", { query: { limit: VERCEL_PAGE_SIZE, until } });
    const list = new CompleteList<VercelDomainInfo>("vercel");
    list.add(res.domains, d => hasText(d.id) && hasText(d.name) && domainKey(d.name) ? [`id:${d.id}`, `name:${domainKey(d.name)}`] : null, VERCEL_PAGE_SIZE);
    return { items: list.items, next: nextUntil(res.pagination, list.items.length, until) };
  }

  async listDomains(): Promise<VercelDomainInfo[]> {
    const domains = new CompleteList<VercelDomainInfo>("vercel");
    let until: number | undefined;

    for (let page = 0; page < VERCEL_MAX_PAGES; page++) {
      const res = await this.request<{ domains?: VercelDomainInfo[]; pagination?: unknown }>(
        "GET",
        "/v5/domains",
        { query: { limit: VERCEL_PAGE_SIZE, until } }
      );
      domains.add(res?.domains, d => hasText(d.id) && hasText(d.name) && domainKey(d.name)
        ? [`id:${d.id}`, `name:${domainKey(d.name)}`] : null, VERCEL_PAGE_SIZE);
      const next = nextUntil(res?.pagination, res.domains!.length, until);
      if (next === null) {
        // Team 上下文只在确认完整后更新，不受失败分页影响。
        const teamId = domains.items.find(d => hasText(d.teamId))?.teamId;
        if (teamId) this.setTeamId(teamId);
        return domains.items;
      }
      until = next;
    }

    throw incompleteResponse("vercel", "Vercel 域名分页达到上限，旧缓存保持不变");
  }

  /**
   * 在 Vercel 中添加域名（支持主域与子域）
   *
   * @param domainName 域名，如 example.com 或 sub.example.com
   */
  async createDomain(domainName: string): Promise<VercelDomainInfo> {
    const trimmed = String(domainName || "").trim().toLowerCase();
    if (!trimmed) {
      throw new Error("域名不能为空");
    }
    const res = await this.request<{ domain?: VercelDomainInfo } | VercelDomainInfo>("POST", "/v5/domains", {
      body: { name: trimmed },
    });
    const info = (res && "domain" in res && res.domain ? res.domain : res) as VercelDomainInfo;
    if (!info || !info.name) {
      return { name: trimmed };
    }
    return info;
  }

  /**
   * 分页列出域名下全部 DNS 解析记录
   *
   * NOTE: `domain` 是域名本身（remote_id 存的就是它）。Vercel 的 records 接口
   * 路径是 `/v5/domains/{domain}/records`，多值分别返回独立记录项（不是 RRset）。
   */
  async listDnsRecords(domain: string | number): Promise<ListDnsRecordsResponse> {
    const domainName = String(domain || "").trim();
    if (!domainName) {
      throw new Error("Vercel 解析记录列表需要域名作为参数");
    }

    const records = new CompleteList<VercelDnsRecord>("vercel");
    let until: number | undefined;

    for (let page = 0; page < VERCEL_MAX_PAGES; page++) {
      const res = await this.request<{ records?: VercelDnsRecord[]; pagination?: unknown }>(
        "GET",
        `/v5/domains/${encodeURIComponent(domainName)}/records`,
        { query: { limit: VERCEL_PAGE_SIZE, until } }
      );
      records.add(res?.records, r => (hasText(r.id) || hasText(r.uid)) && typeof r.name === "string" &&
        hasText(r.type) && typeof r.value === "string"
          ? [`id:${r.id || r.uid}`] : null, VERCEL_PAGE_SIZE);
      const next = nextUntil(res?.pagination, res.records!.length, until);
      if (next === null) {
        return { success: true, complete: true, records: records.items.map(rec => mapVercelRecord(rec, domainName)) };
      }
      until = next;
    }

    throw incompleteResponse("vercel", "Vercel DNS 分页达到上限，旧缓存保持不变");
  }

  /**
   * 创建 DNS 解析记录
   */
  async createDnsRecord(params: {
    domain: string;
    type: string;
    name: string;
    content: string;
    ttl?: number;
    priority?: number;
    record_id?: string | number;
  }): Promise<CreateDnsRecordResponse> {
    const type = String(params.type || "").trim().toUpperCase();
    const body: Record<string, unknown> = {
      name: toRelativeRecordName(params.name, params.domain),
      type,
      value: String(params.content || "").trim(),
      ttl: Number(params.ttl) > 0 ? Number(params.ttl) : 60,
    };
    // MX 的优先级用 mxPriority；SRV 用 priority（Vercel 两个字段名不统一）
    const priority = Number(params.priority);
    if (Number.isFinite(priority) && priority >= 0) {
      if (type === "MX") body.mxPriority = priority;
      else if (type === "SRV") body.priority = priority;
    }

    const res = await this.request<VercelDnsRecord>("POST", `/v5/domains/${encodeURIComponent(params.domain)}/records`, {
      body,
    });
    return {
      success: true,
      record: res?.uid || res?.id
        ? {
            id: String(res.uid || res.id),
            name: params.name,
            type,
            content: params.content,
            ttl: Number(res.ttl) || Number(params.ttl) || 60,
            priority: null,
            line: null,
            proxied: false,
          }
        : undefined,
    };
  }

  /**
   * 修改 DNS 解析记录（PATCH 部分更新）
   *
   * NOTE: Vercel 的 PATCH /v5/domains/{domain}/records/{recordId} 支持部分字段更新，
   * 但为确保整条一致（避免只改 TTL 时 name/type 被上游保留或清空的不确定行为），
   * 这里把 type / name / value / ttl 一并下发，等价于整条覆盖。
   */
  async updateDnsRecord(params: {
    domain: string;
    record_id: string | number;
    type: string;
    name: string;
    content: string;
    ttl?: number;
    priority?: number;
  }): Promise<ActionResponse> {
    const type = String(params.type || "").trim().toUpperCase();
    const body: Record<string, unknown> = {
      name: toRelativeRecordName(params.name, params.domain),
      type,
      value: String(params.content || "").trim(),
      ttl: Number(params.ttl) > 0 ? Number(params.ttl) : 60,
    };
    const priority = Number(params.priority);
    if (Number.isFinite(priority) && priority >= 0) {
      if (type === "MX") body.mxPriority = priority;
      else if (type === "SRV") body.priority = priority;
    }

    await this.request(
      "PATCH",
      `/v5/domains/${encodeURIComponent(params.domain)}/records/${encodeURIComponent(String(params.record_id))}`,
      { body }
    );
    return { success: true };
  }

  /**
   * 删除 DNS 解析记录
   *
   * NOTE: Vercel 的删除接口用 `ids` **查询参数**（不是路径参数），单条删也走 ids=xxx。
   */
  async deleteDnsRecord(domain: string | number, recordId: string | number): Promise<ActionResponse> {
    await this.request(
      "DELETE",
      `/v5/domains/${encodeURIComponent(String(domain))}/records`,
      { query: { ids: String(recordId) } }
    );
    return { success: true };
  }
}

/**
 * 把 Vercel 错误码翻译为可操作的中文指引
 *
 * NOTE: Vercel 的错误体是 `{"error":{"code":"...","message":"..."}}`。这里覆盖
 * 实际对接中最常撞上的几类：Token 无效 / 域名不在该账号 / 域名未托管解析 / 记录冲突。
 */
export function translateVercelError(code: string, message: string, httpStatus?: number): string {
  const c = String(code || "");
  const m = String(message || "");

  if (httpStatus === 401 || c === "forbidden" || /invalid token|not authorized/i.test(m)) {
    return "Vercel Access Token 无效或已被吊销：请到 vercel.com/account/tokens 核对（Token 明文只在创建时显示一次，失效就重新创建一个）";
  }
  if (httpStatus === 403 || c === "forbidden" || /permission|scope/i.test(m)) {
    return "Vercel 权限不足：该 Token 的 Scope 未覆盖此域名所属的 Team，请在创建 Token 时勾选对应 Team";
  }
  if (c === "not_found" || httpStatus === 404 || /domain.*not.*found/i.test(m)) {
    return "该域名不在这个 Vercel 账号下：请检查账号是否正确，或域名尚未添加到 Vercel";
  }
  if (c === "not_authorized" || /not.*authorized.*domain|not.*in.*team/i.test(m)) {
    return "该域名由另一个 Vercel 账号或 Team 管理：请在对应账号下创建 Token 后重新绑定";
  }
  if (/does not have.*nameservers|not.*hosted|misconfigured/i.test(m)) {
    return "该域名的 NS 未指向 Vercel（未启用 Vercel 托管解析），请先在 Vercel 控制台把域名切换到 Vercel Nameservers 再管理解析记录";
  }
  if (c === "conflict" || httpStatus === 409 || /already exists/i.test(m)) {
    return "该解析记录已存在：请直接在列表里编辑，或先删除原有记录再创建";
  }
  if (c === "invalid_request" || /invalid.*record|invalid.*value/i.test(m)) {
    return `Vercel 拒绝了该解析记录：${m || "请检查记录类型、名称与记录值是否合法"}`;
  }
  if (httpStatus === 429 || /rate limit|too many requests/i.test(m)) {
    return "Vercel API 请求过于频繁被限流，请稍后重试";
  }

  const detail = m ? `${c || "未知错误"}: ${m}` : c || "未知错误";
  return `Vercel API 错误: ${detail}`;
}
