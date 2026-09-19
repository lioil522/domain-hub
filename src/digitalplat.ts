/**
 * DigitalPlat Developer API 客户端封装
 *
 * NOTE: 与 CloudflareClient 保持同一套路由协作约定 —— listDnsRecords / createDnsRecord /
 * updateDnsRecord / deleteDnsRecord 方法签名一致，index.ts 路由层按 provider 分发。
 * 认证只支持 Bearer API Key（dp_live_ / dp_test_ 前缀）。
 *
 * 与 Cloudflare 的两个关键差异：
 *   1. DNS 记录是 RRset 模型 —— 同名同类型的多条值合并为一条记录（最多 16 值），
 *      修改记录必须携带上次读取返回的 ETag（If-Match），因此 updateDnsRecord 内部
 *      会先拉一次记录列表换取当前 etag 再提交；
 *   2. 所有 DNS 写请求必须携带 Idempotency-Key 请求头（这里统一用 UUID）。
 *
 * 域名列表直接返回注册商侧的到期时间，无需像 Cloudflare zone 那样另查 RDAP。
 * 字段键名以实测为准（domain / expires_at / created_at），同时兼容文档口径
 * （name / expiry_date），两种响应都吃得住。
 */

import type { ActionResponse, CreateDnsRecordResponse, DnsRecordInfo, ListDnsRecordsResponse } from "./dnshe";
import type { UpstreamSubdomain } from "./db";
import { zoneIdToNumericId } from "./cloudflare";
import { detectDnsProvider } from "./dns-provider";

/** DigitalPlat API 统一响应外壳 */
interface DpResponse<T> {
  success: boolean;
  data?: T;
  meta?: unknown;
  message?: string;
  error?: string;
}

/**
 * 请求使用的浏览器 User-Agent
 *
 * NOTE: 该 API 的 Cloudflare 防护会按 UA 拦截非浏览器客户端（默认 UA / curl 一律
 * 403 质询页），实测带 Chrome UA 即稳定放行。伪装浏览器 UA 是与该上游对接的既定
 * 代价，不涉及绕过交互式验证。
 */
const DIGITALPLAT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

/** 域名信息（GET /api/v1/domains 返回，只保留面板需要的字段）
 *
 * NOTE: 实测响应与官方文档不一致 —— 域名字段是 `domain`（文档写 `name`），
 * 到期/注册时间是 `expires_at` / `created_at`（文档写 `expiry_date`），且为
 * 紧凑日期 "20270103"（YYYYMMDD），映射时统一归一化成 datetime 字符串。
 */
export interface DpDomainInfo {
  domain?: string;
  name?: string;
  status?: string;
  slot_type?: string;
  lifecycle_type?: string;
  expires_at?: string;
  expiry_date?: string;
  created_at?: string;
  nameservers?: string[];
  zone?: string;
}

/** DigitalPlat 返回的 DNS 记录原始形状（RRset：单值 value 或多值 values 二选一） */
interface DpDnsRecord {
  id: string;
  name: string;
  type: string;
  value?: string;
  values?: string[];
  ttl?: number;
  protected?: boolean;
  etag?: string;
}

/** 记录值展开为面板通用的记录形状（一条 RRset 值 = 一行）

 * NOTE: DigitalPlat 服务管理的只读记录（protected，典型如 apex 的 SOA/NS）
 * 会被列表接口一并返回，但面板无法修改它们（更新需 If-Match、删除被拒），
 * 这里直接滤掉，避免给用户提供注定失败的编辑/删除入口。
 */
function mapDpRecord(rec: DpDnsRecord): DnsRecordInfo[] {
  if (rec.protected) return [];
  const values = Array.isArray(rec.values) && rec.values.length > 0 ? rec.values : [rec.value ?? ""];
  return values
    .filter((v) => v !== "")
    .map((value) => ({
      id: rec.id,
      name: rec.name,
      type: rec.type,
      content: String(value),
      ttl: Number(rec.ttl) || 300,
      priority: null,
      line: null,
      proxied: false,
    }));
}

/**
 * 把上游紧凑日期归一化为 domains_cache 的 datetime 形态
 *
 * NOTE: 实测 GET /domains 返回 "20270103"（YYYYMMDD）而非文档承诺的
 * "YYYY-MM-DD"，兼容两种写法，空值返回空串由调用方落占位符。
 */
function normalizeDpDate(value: string | undefined): string {
  const s = String(value || "").trim();
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]} 00:00:00`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.replace("T", " ").slice(0, 19);
  }
  return "";
}

/**
 * 把 DigitalPlat 域名映射为 domains_cache 的上游行
 *
 * NOTE: 数值主键复用 zoneIdToNumericId（对域名字符串做双 FNV-1a 稳定哈希），
 * 同一域名每次同步得到相同 id（幂等 upsert）。status 存上游原始注册态
 * （ok / pendingdelete 等），这些行只在 DigitalPlat 标签页展示，不走 DNSHE 三态语义。
 * dns_provider 由列表返回的 NS 推导：落在 *.digitalplat.org 的为 DigitalPlat 托管，
 * 其余按通用规则识别（Cloudflare / DNSPod 等）。remote_id 存域名本身 —— 后续 DNS
 * 记录路由都以域名为路径参数。
 * 域名字段按实测读 `domain`，文档口径的 `name` 作为兜底；日期同理兼容
 * `expires_at` / `expiry_date`。
 */
export function mapDomainToUpstream(domain: DpDomainInfo): UpstreamSubdomain {
  const domainName = String(domain.domain || domain.name || "").trim();
  const nameservers = (domain.nameservers || []).map((ns) => String(ns));
  const dnsProvider = nameservers.length > 0 ? detectDnsProvider(nameservers) : "DigitalPlat";
  const hostedHere = dnsProvider === "DigitalPlat" || nameservers.length === 0;
  // pendingdelete 期间上游已停用 DNS，标记 has_dns=0 让面板禁用 DNS 管理按钮
  const deleting = /pendingdelete/i.test(String(domain.status || ""));

  return {
    id: zoneIdToNumericId(domainName || "."),
    subdomain: "",
    rootdomain: domainName,
    full_domain: domainName,
    status: domain.status || "ok",
    created_at: normalizeDpDate(domain.created_at),
    expires_at: normalizeDpDate(domain.expires_at ?? domain.expiry_date) || "0000-00-00 00:00:00",
    has_dns: hostedHere && !deleting ? 1 : 0,
    dns_provider: dnsProvider,
    provider_account_id: null,
    remote_id: domainName,
    dns_state_known: true
  };
}

/**
 * DigitalPlat API 请求封装类
 */
export class DigitalPlatClient {
  private apiKey: string;
  private baseUrl = "https://domain-api.digitalplat.org/api/v1";

  constructor(apiKey: string) {
    this.apiKey = String(apiKey || "").trim();
  }

  /**
   * 通用请求封装 —— 非 2xx 或 success=false 时抛出带上游信息的异常
   *
   * NOTE: 请求头必须带浏览器 User-Agent。实测该 API 域名的 Cloudflare 防护按 UA
   * 过滤非浏览器客户端（默认 UA 直接弹 403 质询 HTML 页），带 Chrome UA 即放行。
   * 认证失败的错误体是嵌套结构 {"error":{"code","message"},"success":false}，与
   * 文档承诺的顶层 message 不同，解析时做兼容。
   */
  private async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: {
      query?: Record<string, unknown>;
      body?: unknown;
      idempotencyKey?: string;
      ifMatchEtag?: string;
    } = {}
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (options.query) {
      for (const [key, val] of Object.entries(options.query)) {
        if (val !== undefined && val !== null && val !== "") {
          url.searchParams.append(key, String(val));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": DIGITALPLAT_USER_AGENT,
    };
    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }
    if (options.ifMatchEtag) {
      headers["If-Match"] = options.ifMatchEtag;
    }

    const response = await fetch(url.toString(), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    let data: DpResponse<T>;
    try {
      data = (await response.json()) as DpResponse<T>;
    } catch {
      // 响应体不是 JSON —— 典型场景是 Cloudflare 质询 HTML 页
      throw new Error(
        response.status === 403
          ? "DigitalPlat API 被 Cloudflare 人机验证拦截（HTTP 403），请稍后重试；若持续出现请检查部署出口 IP 是否被拉黑"
          : `DigitalPlat API 响应异常 (HTTP ${response.status})`
      );
    }

    if (!response.ok || !data.success) {
      const nested = (data.error as { message?: unknown; code?: unknown } | undefined) || {};
      const nestedMessage = typeof nested.message === "string" ? nested.message : "";
      const detail = String(data.message || (typeof data.error === "string" ? data.error : "") || nestedMessage || "");
      const errorCode = typeof nested.code === "string" ? nested.code : "";
      // 401/403 统一翻译成可操作的中文指引
      if (errorCode === "invalid_api_key" || response.status === 401) {
        throw new Error(
          "DigitalPlat API Key 无效或已被吊销：请到 DigitalPlat 控制台「API 密钥」页核对（Key 明文只在创建时显示一次，无法再次查看，失效就重新创建一个）"
        );
      }
      if (response.status === 403) {
        throw new Error(
          "DigitalPlat API 拒绝访问（HTTP 403）：请到 DigitalPlat 控制台「API 密钥」页确认该 API Key 仍然有效且未被禁用"
        );
      }
      // 412 = PATCH 的 If-Match ETag 与上游当前版本不符（并发编辑 / 列表过期），
      // 需要重新拉取记录列表拿最新 etag 再重试，否则静默覆盖别人的修改。
      if (response.status === 412) {
        throw new Error(
          "DigitalPlat 记录已在本页之外被修改（ETag 冲突，HTTP 412）：请关闭编辑后重新加载记录列表再试，避免覆盖其他会话的改动"
        );
      }
      if (errorCode === "hosted_dns_zone_not_found") {
        throw new Error(
          "该域名未启用 DigitalPlat DNS 托管（NS 未指向 DigitalPlat），请先在 DigitalPlat 控制台启用 Hosted DNS 后再管理解析记录"
        );
      }
      throw new Error(`DigitalPlat API 错误: ${detail || `HTTP ${response.status}`}`);
    }

    return data.data as T;
  }

  /**
   * 列出 API Key 名下全部域名（同时用于绑定时的密钥有效性校验）
   *
   * NOTE: 键名兼容实测（domain/expires_at）与文档（name/expiry_date）两套口径，
   * 拿到空域名的异常条目直接丢弃，避免把空串哈希成脏行写进缓存。
   */
  async listDomains(): Promise<DpDomainInfo[]> {
    const data = await this.request<DpDomainInfo[]>("GET", "/domains");
    if (!Array.isArray(data)) return [];
    return data.filter((d) => String(d.domain || d.name || "").trim() !== "");
  }

  /**
   * 列出域名下全部 DNS 解析记录（内部原始形状，供 updateDnsRecord 提取 etag）
   */
  private async listRawDnsRecords(domain: string): Promise<DpDnsRecord[]> {
    const data = await this.request<DpDnsRecord[]>(
      "GET",
      `/domains/${encodeURIComponent(domain)}/dns/records`
    );
    return Array.isArray(data) ? data : [];
  }

  /**
   * 列出域名下全部 DNS 解析记录（展开 RRset 多值后映射为内部形状）
   */
  async listDnsRecords(domain: string | number): Promise<ListDnsRecordsResponse> {
    const raw = await this.listRawDnsRecords(String(domain));
    const records = raw.flatMap(mapDpRecord);
    return { success: true, records };
  }

  /**
   * 创建 DNS 解析记录（创建或扩展 RRset；单值走 values 数组提交）
   */
  async createDnsRecord(params: {
    domain: string;
    type: string;
    name: string;
    content: string;
    ttl?: number;
  }): Promise<CreateDnsRecordResponse> {
    await this.request("POST", `/domains/${encodeURIComponent(params.domain)}/dns/records`, {
      idempotencyKey: crypto.randomUUID(),
      body: {
        type: params.type,
        name: params.name,
        ttl: Number(params.ttl) > 0 ? Number(params.ttl) : 300,
        values: [params.content],
      },
    });
    return { success: true };
  }

  /**
   * 修改 DNS 解析记录
   *
   * NOTE: DigitalPlat 要求 PATCH 携带 If-Match（上次读取返回的 ETag）防止覆盖其他
   * 会话的修改。面板不透传 etag，这里先拉一次记录列表找到目标记录取当前 etag；
   * 找不到说明记录已被删除或 ID 变化，让用户刷新后重试。
   * 服务管理的只读记录（protected）在列表层已被滤掉，这里再做一层防御，避免
   * 记录 ID 直接拼 URL 撞上只读记录时静默报错。
   */
  async updateDnsRecord(params: {
    domain: string;
    record_id: string | number;
    content: string;
    ttl?: number;
  }): Promise<ActionResponse> {
    const recordId = String(params.record_id);
    const raw = await this.listRawDnsRecords(params.domain);
    // RRset 多值时同一 id 出现多次，任取一条的 etag 即可（同属一个 RRset）
    const target = raw.find((rec) => String(rec.id) === recordId);
    if (!target) {
      throw new Error("未在上游找到该解析记录（可能已被删除），请刷新记录列表后重试");
    }
    if (target.protected) {
      throw new Error("该记录由 DigitalPlat 服务管理（只读），无法通过 API 修改");
    }
    if (!target.etag) {
      throw new Error("上游未返回该记录的 ETag，无法安全修改（缺少 If-Match）。请刷新记录列表后重试");
    }

    const body: Record<string, unknown> = { value: params.content };
    if (Number(params.ttl) > 0) {
      body.ttl = Number(params.ttl);
    }
    await this.request("PATCH", `/domains/${encodeURIComponent(params.domain)}/dns/records/${encodeURIComponent(recordId)}`, {
      idempotencyKey: crypto.randomUUID(),
      ifMatchEtag: target.etag,
      body,
    });
    return { success: true };
  }

  /**
   * 删除 DNS 解析记录（从 RRset 中删除一个值）
   *
   * NOTE: 先查一次记录列表确认目标是可删的用户记录（protected 只读记录在列表层
   * 已滤除，这里再兜一层），再发 DELETE。
   */
  async deleteDnsRecord(domain: string | number, recordId: string | number): Promise<ActionResponse> {
    const domainName = String(domain);
    const recordIdStr = String(recordId);
    const raw = await this.listRawDnsRecords(domainName);
    const target = raw.find((rec) => String(rec.id) === recordIdStr);
    if (target?.protected) {
      throw new Error("该记录由 DigitalPlat 服务管理（只读），无法删除");
    }
    await this.request(
      "DELETE",
      `/domains/${encodeURIComponent(domainName)}/dns/records/${encodeURIComponent(recordIdStr)}`,
      { idempotencyKey: crypto.randomUUID() }
    );
    return { success: true };
  }

  /**
   * 整组替换域名 NS 服务器（注册局级操作，DNS 委派立即切换）
   *
   * NOTE: 实测 operated/permanent 免费域名同样允许 PATCH（原样写回验证 HTTP 200），
   * 因此对 free 免费域名与 registered 注册域名都可用。面板只在 DigitalPlat 域名
   * 卡片的三点菜单暴露该项，调用方负责收集并校验新 NS。
   */
  async updateNameservers(domain: string, nameservers: string[]): Promise<ActionResponse> {
    await this.request("PATCH", `/domains/${encodeURIComponent(domain)}/nameservers`, {
      idempotencyKey: crypto.randomUUID(),
      body: { nameservers },
    });
    return { success: true };
  }

  /**
   * 查询单个域名当前的 NS 服务器列表（供修改 NS 弹窗预填）
   *
   * NOTE: 上游没有单域名详情接口，从全量列表过滤该域（一次 GET /domains）。
   */
  async getDomainNameservers(domain: string): Promise<string[]> {
    const domains = await this.listDomains();
    const hit = domains.find((d) => String(d.domain || d.name || "").trim() === String(domain).trim());
    return (hit?.nameservers || []).map((ns) => String(ns));
  }

  /**
   * 删除域名（进入 pendingdelete：DNS 立即停用，7 天后正式释放）
   */
  async deleteDomain(domain: string): Promise<ActionResponse> {
    await this.request("DELETE", `/domains/${encodeURIComponent(domain)}`, {
      idempotencyKey: crypto.randomUUID(),
    });
    return { success: true };
  }
}
