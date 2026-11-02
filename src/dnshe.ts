/**
 * DNSHE API 响应类型定义
 * 
 * NOTE: 为每个 API 端点定义具体的响应接口，替代原先的 Promise<unknown> 返回类型，
 * 使所有调用方获得编译期的字段提示和类型校验。
 */

import { ProviderApiError, incompleteResponse } from "./errors/provider-api-error";
import { parseProviderJson, requestProviderText, type ProviderRequestLimits, type ProviderTextResponse } from "./providers/provider-request";
import type { RequestBudget } from "./services/dnshe-request-budget";
import { dnsheResetAfter } from "./providers/provider-rate-limit";

export interface OffsetPagination {
  mode?: "offset";
  page?: number;
  per_page?: number;
  total?: number;
  has_more: boolean;
  next_page?: number;
}
export interface CursorPagination {
  cursor?: number | string;
  per_page?: number;
  has_more: boolean;
  next_cursor?: number | string | null;
}

/** 通用基础响应 */
export interface BaseResponse {
  success: boolean;
  message?: string;
  error?: string;
  error_code?: string;
  details?: unknown;
}

/** 配额查询响应 */
export interface QuotaResponse extends BaseResponse {
  quota?: {
    used: number;
    base: number;
    invite_bonus: number;
    total: number;
    available: number;
  };
}

/** 子域名列表响应 */
export interface ListSubdomainsResponse extends BaseResponse {
  subdomains?: SubdomainInfo[];
  total?: number;
  page?: number;
  per_page?: number;
  pagination?: OffsetPagination;
}

/** 子域名信息 */
export interface SubdomainInfo {
  id: number;
  subdomain: string;
  rootdomain: string;
  full_domain: string;
  status: string;
  expires_at?: string;
  created_at?: string;
  disable_ns_management?: boolean | number;
  has_dns?: boolean | number;
  ns1?: string;
  ns2?: string;
  /**
   * 该域名所在的解析服务商账号 ID —— `subdomains/list` 不传 fields 时默认就返回，
   * 无需额外调用。
   *
   * NOTE: 「域名是否支持按线路（运营商/地域）解析」在 API 里无从查起 —— 文档没有
   * 任何线路能力字段（`fields` 参数枚举了子域名的全部可选字段，里面没有），也没有
   * 根域名列表或 capability 接口；官网自己也是把「目前只有 us.ci 与 cn.mt 支持」
   * 写死在文案里的。实测同一账号下 us.ci / cn.mt 的该值为 1，其余 7 个根域名为
   * 7 或 8，两组取值无交集。
   *
   * 但文档从未说明这个字段的语义，属实测相关性而非契约。现已改用根域名的 NS 记录
   * 作为主判定信号（见 `/api/dns/ns` 与前端 DNSHE_LINE_NS_SUFFIXES）—— NS 落在
   * vip*.alidns.com 的根域支持线路，落在 DNSHE 自建 NS 的不支持，语义比裸数字明确
   * 得多。本字段降级为 NS 查不到时的兜底信号，前端不再提供对应的可编辑名单。
   */
  provider_account_id?: number | string | null;
}

/** 子域名详情响应 */
export interface GetSubdomainResponse extends BaseResponse {
  subdomain?: SubdomainInfo;
  records?: DnsRecordInfo[];
  dns_records?: DnsRecordInfo[];
}

/** 续期响应 */
export interface RenewResponse extends BaseResponse {
  new_expires_at?: string;
}

/** DNS 记录列表响应 */
export interface ListDnsRecordsResponse extends BaseResponse {
  records?: DnsRecordInfo[];
  pagination?: CursorPagination;
  complete?: boolean;
}

/** DNS 记录信息 */
export interface DnsRecordInfo {
  // Cloudflare 的记录 id 是 32 位十六进制字符串，DNSHE 是数字，统一放宽为联合类型
  id: number | string;
  record_id?: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  priority?: number | null;
  line?: string | null;
  proxied?: boolean;
  /**
   * Cloudflare 专用：当该 AAAA 100:: proxied 记录是 Worker 路由占位时，
   * 填上绑定的 Worker 名（来自 /zones/:id/workers/routes 的 script_name）。
   * 前端据此把「AAAA 100::」渲染为「Worker」类型，DNSHE/DigitalPlat 记录无此字段。
   */
  workerName?: string;
}

/** 创建 DNS 记录响应 */
export interface CreateDnsRecordResponse extends BaseResponse {
  record?: DnsRecordInfo;
  id?: number | string;
  record_id?: string;
}

/** API 密钥信息 */
export interface ApiKeyInfo {
  id: number;
  key_name?: string;
  api_key: string;
  status: string;
  request_count?: number;
  last_used_at?: string;
  created_at?: string;
}

/** 列出 API 密钥响应 */
export interface ListApiKeysResponse extends BaseResponse {
  keys?: ApiKeyInfo[];
  count?: number;
}

/** 通用操作响应（用于更新、删除等不返回额外数据的操作） */
export interface ActionResponse extends BaseResponse {
  id?: number | string;
  record_id?: string;
}

/** 注册子域名响应 */
export interface RegisterSubdomainResponse extends BaseResponse {
  subdomain_id?: number;
  full_domain?: string;
}

/** 创建 DNS 记录参数 */
export interface CreateDnsRecordParams {
  subdomain_id: number;
  type: string;
  name?: string;
  content?: string;
  ttl?: number;
  priority?: number;
  line?: string;
  weight?: number;
  port?: number;
  target?: string;
  caa_flag?: number;
  caa_tag?: string;
  caa_value?: string;
}

/** 更新 DNS 记录参数 */
export interface UpdateDnsRecordParams extends CreateDnsRecordParams {
  record_id: string | number;
}

/**
 * DNSHE API 请求封装类
 */
export class DNSHEClient {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;

  constructor(apiKey: string, apiSecret: string, private readonly budget?: RequestBudget,
    private readonly requestLimits: ProviderRequestLimits = {}) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    // 从文档得知 API 地址
    this.baseUrl = "https://api005.dnshe.com/index.php";
  }

  /**
   * 通用请求封装 — 支持泛型返回值类型
   */
  private async request<T extends BaseResponse>(
    endpoint: string,
    action: string,
    method: "GET" | "POST",
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
    beforeDispatch?: () => Promise<void>
  ): Promise<T> {
    let url = `${this.baseUrl}?m=domain_hub&endpoint=${endpoint}&action=${action}`;
    
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      "X-API-Secret": this.apiSecret,
      "Content-Type": "application/json",
    };

    const options: RequestInit = {
      method,
      headers,
      signal,
    };

    if (method === "GET") {
      const queryParams = new URLSearchParams();
      for (const [key, val] of Object.entries(params)) {
        if (val !== undefined && val !== null) {
          queryParams.append(key, String(val));
        }
      }
      const queryString = queryParams.toString();
      if (queryString) {
        url += `&${queryString}`;
      }
    } else {
      options.body = JSON.stringify(params);
    }

    await this.budget?.reserve();
    let result: ProviderTextResponse;
    let data: T | null;
    try {
      result = await requestProviderText("dnshe", url, options, { ...this.requestLimits, beforeDispatch });
      data = parseProviderJson("dnshe", result) as T | null;
    } catch (error) {
      if (error instanceof ProviderApiError && (error.status === 429 || error.rateLimited) && !error.error_code.startsWith("scheduler_")) {
        // Preserve the original unread/unknown transport outcome if cooldown
        // coordination also fails. Persistence is not guaranteed by this error.
        try { await this.budget?.block(Math.max(error.retryAfterMs ?? 60_000, 1000)); } catch { /* primary error wins */ }
      }
      throw error;
    }
    const { response } = result;
    if (!data || typeof data !== "object" || typeof data.success !== "boolean") {
      if (response.status === 429) await this.budget?.block(Math.max(result.retryAfterMs ?? 60_000, 1000));
      throw new ProviderApiError("dnshe", response.status, "invalid_response", `DNSHE 返回无效响应（HTTP ${response.status}）`, undefined, result.retryAfterMs);
    }
    if (!response.ok || !data.success) {
      let retryAfterMs = result.retryAfterMs;
      if (response.status === 429 || result.rateLimited) {
        retryAfterMs = Math.max(retryAfterMs ?? 60_000, dnsheResetAfter(data.details) ?? 0, 1000);
        await this.budget?.block(retryAfterMs);
        if (!result.rateLimited) await this.requestLimits.scheduler?.block(retryAfterMs);
      }
      throw new ProviderApiError("dnshe", response.status, data.error_code || "request_failed",
        data.message || data.error || `DNSHE 请求失败（HTTP ${response.status}）`,
        (response.status === 429 || result.rateLimited) && this.requestLimits.scheduler?.scope
          ? { ...(data.details && typeof data.details === "object" ? data.details : {}), scope: this.requestLimits.scheduler.scope }
          : data.details,
        Number.isFinite(retryAfterMs) ? retryAfterMs : undefined, result.rateLimited);
    }
    return data;
  }

  /**
   * 获取账号额度配额
   */
  async getQuota(): Promise<QuotaResponse> {
    return this.request<QuotaResponse>("quota", "", "GET");
  }

  /**
   * 列出当前账号的 API 密钥列表
   * 可用于校验密钥有效性，并从中读取密钥名称 (key_name) 作为账户别名
   */
  async listApiKeys(): Promise<ListApiKeysResponse> {
    return this.request<ListApiKeysResponse>("keys", "list", "GET");
  }

  /**
   * 列出子域名列表 (支持分页和搜索)
   */
  async listSubdomains(page = 1, perPage = 100, search = "", status = ""): Promise<ListSubdomainsResponse> {
    return this.request<ListSubdomainsResponse>("subdomains", "list", "GET", {
      page,
      per_page: perPage,
      search: search || undefined,
      status: status || undefined,
      include_total: 1
    });
  }

  /**
   * 注册新的子域名
   */
  async registerSubdomain(subdomain: string, rootdomain: string): Promise<RegisterSubdomainResponse> {
    return this.request<RegisterSubdomainResponse>("subdomains", "register", "POST", {
      subdomain,
      rootdomain
    });
  }

  /**
   * 获取子域名详情 (含解析记录)
   */
  async getSubdomain(subdomainId: number): Promise<GetSubdomainResponse> {
    return this.request<GetSubdomainResponse>("subdomains", "get", "GET", {
      subdomain_id: subdomainId
    });
  }

  /**
   * 续期子域名
   */
  async renewSubdomain(subdomainId: number, beforeDispatch?: () => Promise<void>): Promise<RenewResponse> {
    return this.request<RenewResponse>("subdomains", "renew", "POST", {
      subdomain_id: subdomainId
    }, undefined, beforeDispatch);
  }

  /**
   * 删除子域名
   */
  async deleteSubdomain(subdomainId: number): Promise<ActionResponse> {
    return this.request<ActionResponse>("subdomains", "delete", "POST", {
      subdomain_id: subdomainId
    });
  }

  /**
   * 列出子域名的 DNS 解析记录
   *
   * NOTE: 参数放宽为 number | string —— 路由层对 DNSHE / Cloudflare 客户端做联合分发时
   * 传同一个 remote_id（DNSHE 行是数字主键，CF 行是 zone id 字符串），实际只走数字。
   */
  async listDnsRecordsPage(subdomainId: number | string, cursor: number | string = 0): Promise<ListDnsRecordsResponse> {
    return this.request<ListDnsRecordsResponse>("dns_records", "list", "GET", { subdomain_id: subdomainId, cursor, per_page: 100 });
  }

  async listDnsRecords(subdomainId: number | string): Promise<ListDnsRecordsResponse> {
    const records: DnsRecordInfo[] = [];
    const cursors = new Set<string>(["0"]);
    const ids = new Set<string>();
    let cursor: number | string = 0;
    for (let page = 0; page < 50; page++) {
      const response: ListDnsRecordsResponse = await this.request<ListDnsRecordsResponse>("dns_records", "list", "GET", {
        subdomain_id: subdomainId, cursor, per_page: 100,
      });
      if (!Array.isArray(response.records)) throw incompleteResponse("dnshe");
      for (const record of response.records) {
        if (!record || record.id === undefined || ids.has(String(record.id))) throw incompleteResponse("dnshe");
        ids.add(String(record.id));
        records.push(record);
      }
      const pagination = response.pagination;
      if (pagination && typeof pagination.has_more !== "boolean") throw incompleteResponse("dnshe");
      if (pagination?.has_more === false || (!pagination && response.records.length < 100)) {
        return { ...response, records, complete: true };
      }
      const next = pagination?.next_cursor;
      if (!pagination || !response.records.length || next == null || cursors.has(String(next)) ||
        (typeof next !== "string" && typeof next !== "number")) throw incompleteResponse("dnshe");
      cursors.add(String(next));
      cursor = next;
    }
    throw incompleteResponse("dnshe", "DNSHE DNS 分页达到安全上限，未覆盖旧缓存");
  }

  /**
   * 创建 DNS 解析记录
   */
  async createDnsRecord(params: CreateDnsRecordParams): Promise<CreateDnsRecordResponse> {
    return this.request<CreateDnsRecordResponse>("dns_records", "create", "POST", params as unknown as Record<string, unknown>);
  }

  /**
   * 修改 DNS 解析记录
   *
   * NOTE: 与删除接口一致 —— 记录标识为纯数字时同时以内部 id 和 record_id 两种
   * 形式下发，兼容上游对两种字段的不同要求。
   */
  async updateDnsRecord(params: UpdateDnsRecordParams): Promise<ActionResponse> {
    const payload: Record<string, unknown> = { ...params };
    const numId = Number(params.record_id);
    if (Number.isSafeInteger(numId) && numId > 0) {
      payload.id = numId;
    }
    payload.record_id = String(params.record_id);

    return this.request<ActionResponse>("dns_records", "update", "POST", payload);
  }

  /**
   * 删除 DNS 解析记录
   *
   * NOTE: subdomainId 放宽为 number | string，理由同 listDnsRecords。
   */
  async deleteDnsRecord(subdomainId: number | string, recordId: string | number): Promise<ActionResponse> {
    const params: Record<string, unknown> = {
      subdomain_id: subdomainId
    };
    
    // 如果是纯数字或数值型字符串，作为内部 id 传递；同时补充 record_id 保证兼容
    const numId = Number(recordId);
    if (Number.isSafeInteger(numId) && numId > 0) {
      params.id = numId;
      params.record_id = String(recordId);
    } else {
      params.record_id = String(recordId);
    }

    return this.request<ActionResponse>("dns_records", "delete", "POST", params);
  }

  /**
   * WHOIS 查询域名可注册性
   */
  async whois(domain: string, signal?: AbortSignal): Promise<{ success: boolean; domain?: string; registered?: boolean; status?: string; registered_at?: string; expires_at?: string; registrant_email?: string; nameservers?: string[]; message?: string }> {
    return this.request<{ success: boolean; domain?: string; registered?: boolean; status?: string; registered_at?: string; expires_at?: string; registrant_email?: string; nameservers?: string[]; message?: string }>("whois", "", "GET", {
      domain
    }, signal);
  }
}
