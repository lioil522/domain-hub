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
 *
 * NOTE: DigitalPlat 服务管理的只读记录（protected，典型如 apex 的 SOA/NS）
 * 会被列表接口一并返回，但面板无法修改它们（更新需 If-Match、删除被拒），
 * 这里直接滤掉，避免给用户提供注定失败的编辑/删除入口。
 * 多值展开追加 #idx 下标，与华为云精准定位机制保持一致，避免 React key 冲突。
 */
function mapDpRecord(rec: DpDnsRecord): DnsRecordInfo[] {
  if (rec.protected) return [];
  const rawValues = Array.isArray(rec.values) && rec.values.length > 0 ? rec.values : [rec.value ?? ""];
  const values = rawValues.filter((v) => v !== "");
  const isMulti = values.length > 1;
  const type = String(rec.type || "").toUpperCase();

  return values.map((value, idx) => {
    let priority: number | null = null;
    const strVal = String(value);
    if (type === "MX" || type === "SRV") {
      const m = strVal.match(/^(\d+)\s+(.+)$/);
      if (m) priority = Number(m[1]);
    }

    return {
      id: isMulti ? `${rec.id}#${idx}` : rec.id,
      name: rec.name,
      type,
      content: strVal,
      ttl: Number(rec.ttl) || 300,
      priority,
      line: null,
      proxied: false,
    };
  });
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
 * 将 DigitalPlat 主机记录名称归一化为相对主机名
 *
 * NOTE: 抹平相对名（如 "cf"）、完整 FQDN（如 "cf.domain.com"）、根域（"domain.com" / "@" / ""）、
 * 尾部点号以及大小写的差异，统一输出小写的相对名（根域统一为 "@"）。
 */
export function normalizeDpName(name: string | undefined | null, domain: string): string {
  const trimmed = String(name || "").trim().toLowerCase().replace(/\.+$/, "");
  const baseDomain = String(domain || "").trim().toLowerCase().replace(/\.+$/, "");
  if (!trimmed || trimmed === "@") {
    return "@";
  }
  if (!baseDomain) {
    return trimmed;
  }
  if (trimmed === baseDomain) {
    return "@";
  }
  if (trimmed.endsWith(`.${baseDomain}`)) {
    const sub = trimmed.slice(0, -(baseDomain.length + 1));
    return sub || "@";
  }
  return trimmed;
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
   * 创建 DNS 解析记录
   *
   * 逻辑：
   * 1. 重复检查：若同名同类型且记录值完全相同，直接抛出异常提醒用户，绝不静默假装成功；
   * 2. 优先直接发 POST 创建新记录（请求体同时兼容 value 与 values 格式）；
   * 3. 若上游返回冲突或特定错误，再降级尝试并入同名同类型的现有记录中。
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
    const rawName = String(params.name || "").trim();
    const normalizedTargetName = normalizeDpName(rawName, params.domain);
    let content = String(params.content || "").trim();
    const priority = Number(params.priority);
    if ((type === "MX" || type === "SRV") && Number.isFinite(priority) && priority >= 0 && !/^\d+\s+/.test(content)) {
      content = `${priority} ${content}`;
    }

    const raw = await this.listRawDnsRecords(params.domain);

    // 1. 严格查重：若已有同名同类型且内容完全一致的记录，抛出明确错误，杜绝假成功欺骗前端
    const duplicate = raw.find((rec) => {
      if (normalizeDpName(rec.name, params.domain) !== normalizedTargetName || rec.type.toUpperCase() !== type) {
        return false;
      }
      const vals = Array.isArray(rec.values) && rec.values.length > 0 ? rec.values : [rec.value ?? ""];
      return vals.map((v) => String(v).trim()).includes(content);
    });
    if (duplicate) {
      throw new Error(`该解析记录已存在（${type} ${normalizedTargetName} → ${content}），无需重复添加`);
    }

    // 2. 优先直接发送 POST 创建独立记录（DigitalPlat 官方支持同名多条记录各自独立拥有 ID）
    const safeTtl = Number(params.ttl) > 0 ? Number(params.ttl) : 300;
    try {
      await this.request("POST", `/domains/${encodeURIComponent(params.domain)}/dns/records`, {
        idempotencyKey: crypto.randomUUID(),
        body: {
          type,
          name: normalizedTargetName,
          ttl: safeTtl,
          value: content,
          values: [content],
        },
      });
      return { success: true };
    } catch (postErr: unknown) {
      // 3. 若上游 POST 返回同名冲突或不支持独立创建，降级尝试并入同名同类型的现有记录
      const existing = raw.find(
        (rec) =>
          normalizeDpName(rec.name, params.domain) === normalizedTargetName &&
          rec.type.toUpperCase() === type &&
          !rec.protected
      );
      if (!existing || !existing.etag) {
        throw postErr;
      }

      const existingValues = Array.isArray(existing.values) && existing.values.length > 0
        ? [...existing.values]
        : existing.value ? [existing.value] : [];

      if (existingValues.length >= 16) {
        throw new Error("DigitalPlat 单条记录集最多包含 16 个记录值，已达上限");
      }

      const mergedValues = [...existingValues, content];
      await this.request("PATCH", `/domains/${encodeURIComponent(params.domain)}/dns/records/${encodeURIComponent(existing.id)}`, {
        idempotencyKey: crypto.randomUUID(),
        ifMatchEtag: existing.etag,
        body: {
          values: mergedValues,
          ttl: safeTtl,
        },
      });

      return { success: true };
    }
  }

  /**
   * 批量创建/合并 DNS 解析记录
   *
   * 按 (name, type) 自动分组聚合，针对同组多值一次性提交，大幅减少 API 请求并避免覆盖。
   */
  async batchCreateDnsRecords(params: {
    domain: string;
    items: Array<{
      type: string;
      name: string;
      content: string;
      ttl?: number;
      priority?: number;
    }>;
  }): Promise<{
    results: Array<{ label: string; success: boolean; message: string }>;
    successCount: number;
    failCount: number;
  }> {
    const results: Array<{ label: string; success: boolean; message: string }> = [];
    let successCount = 0;
    let failCount = 0;

    interface GroupItem {
      raw: (typeof params.items)[0];
      formattedVal: string;
    }
    const groups = new Map<
      string,
      {
        name: string;
        type: string;
        ttl: number;
        items: GroupItem[];
      }
    >();

    for (const item of params.items) {
      const type = String(item.type || "").trim().toUpperCase();
      const rawName = String(item.name ?? "").trim();
      const normalizedName = normalizeDpName(rawName, params.domain);
      const ttl = Number(item.ttl) > 0 ? Number(item.ttl) : 300;
      let val = String(item.content || "").trim();
      const priority = Number(item.priority);
      if ((type === "MX" || type === "SRV") && Number.isFinite(priority) && priority >= 0 && !/^\d+\s+/.test(val)) {
        val = `${priority} ${val}`;
      }

      const groupKey = `${type}:::${normalizedName}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          name: normalizedName,
          type,
          ttl,
          items: [],
        });
      }
      groups.get(groupKey)!.items.push({ raw: item, formattedVal: val });
    }

    const rawRecords = await this.listRawDnsRecords(params.domain);

    for (const group of groups.values()) {
      try {
        const existing = rawRecords.find(
          (rec) =>
            normalizeDpName(rec.name, params.domain) === group.name &&
            rec.type.toUpperCase() === group.type.toUpperCase()
        );

        if (!existing) {
          // 不存在该 RRset：一次性 POST 创建该组全部记录
          const uniqueValues: string[] = [];
          for (const it of group.items) {
            if (!uniqueValues.includes(it.formattedVal)) {
              uniqueValues.push(it.formattedVal);
            }
          }

          const toAdd = uniqueValues.slice(0, 16);
          await this.request("POST", `/domains/${encodeURIComponent(params.domain)}/dns/records`, {
            idempotencyKey: crypto.randomUUID(),
            body: {
              type: group.type,
              name: group.name,
              ttl: group.ttl,
              values: toAdd,
            },
          });

          for (const it of group.items) {
            const label = `${it.raw.type || "?"} ${it.raw.name} → ${it.raw.content || "(空)"}`;
            if (toAdd.includes(it.formattedVal)) {
              successCount++;
              results.push({ label, success: true, message: "创建成功" });
            } else {
              failCount++;
              results.push({ label, success: false, message: "DigitalPlat 单条记录集最多包含 16 个记录值，超出上限" });
            }
          }
        } else {
          // 已存在 RRset：合并现有值与待添加的值
          const existingValues = Array.isArray(existing.values) && existing.values.length > 0
            ? [...existing.values]
            : existing.value ? [existing.value] : [];

          const newToAdd: string[] = [];
          for (const it of group.items) {
            if (!existingValues.includes(it.formattedVal) && !newToAdd.includes(it.formattedVal)) {
              newToAdd.push(it.formattedVal);
            }
          }

          const combined = [...existingValues];
          const acceptedNewValues = new Set<string>();

          for (const val of newToAdd) {
            if (combined.length < 16) {
              combined.push(val);
              acceptedNewValues.add(val);
            }
          }

          if (acceptedNewValues.size > 0) {
            await this.request(
              "PATCH",
              `/domains/${encodeURIComponent(params.domain)}/dns/records/${encodeURIComponent(existing.id)}`,
              {
                idempotencyKey: crypto.randomUUID(),
                ifMatchEtag: existing.etag,
                body: {
                  values: combined,
                  ttl: group.ttl || Number(existing.ttl) || 300,
                },
              }
            );
          }

          for (const it of group.items) {
            const label = `${it.raw.type || "?"} ${it.raw.name} → ${it.raw.content || "(空)"}`;
            if (existingValues.includes(it.formattedVal)) {
              successCount++;
              results.push({ label, success: true, message: "记录已存在（已自动合并）" });
            } else if (acceptedNewValues.has(it.formattedVal)) {
              successCount++;
              results.push({ label, success: true, message: "已并入现有记录集" });
            } else {
              failCount++;
              results.push({ label, success: false, message: "DigitalPlat 单条记录集最多包含 16 个记录值，超出上限" });
            }
          }
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : "创建失败";
        for (const it of group.items) {
          const label = `${it.raw.type || "?"} ${it.raw.name} → ${it.raw.content || "(空)"}`;
          failCount++;
          results.push({ label, success: false, message: errMsg });
        }
      }
    }

    return { results, successCount, failCount };
  }

  /**
   * 修改 DNS 解析记录
   *
   * NOTE: record_id 若形如 `<uuid>#<idx>`（多值展开产生的行），只更新该下标对应的单项值，
   * 完整保留同条 RRset 内的其他值，避免覆盖抹除。
   */
  async updateDnsRecord(params: {
    domain: string;
    record_id: string | number;
    content: string;
    originContent?: string;
    ttl?: number;
    type?: string;
    name?: string;
    priority?: number;
  }): Promise<ActionResponse> {
    const rawId = String(params.record_id);
    const [recordId, idxStr] = rawId.split("#");
    const targetIdx = idxStr !== undefined && idxStr !== "" ? parseInt(idxStr, 10) : -1;

    const raw = await this.listRawDnsRecords(params.domain);
    const target = raw.find((rec) => String(rec.id) === recordId);
    if (!target) {
      throw new Error("未在上游找到该解析记录（可能已被删除），请刷新记录列表后重试");
    }
    if (target.protected) {
      throw new Error("该记录由 DigitalPlat 服务管理（只读），无法通过 API 修改");
    }

    const type = String(params.type || target.type || "").toUpperCase();
    let content = String(params.content || "").trim();
    const priority = Number(params.priority);
    if ((type === "MX" || type === "SRV") && Number.isFinite(priority) && priority >= 0 && !/^\d+\s+/.test(content)) {
      content = `${priority} ${content}`;
    }

    const rawTargetName = params.name !== undefined ? String(params.name).trim() : target.name;
    const targetRelative = normalizeDpName(rawTargetName, params.domain);
    const existingRelative = normalizeDpName(target.name, params.domain);
    const nameChanged = targetRelative !== existingRelative;
    const typeChanged = type !== target.type.toUpperCase();

    // 当主机记录 (name) 或记录类型 (type) 改变时，属于 RRset 跨归属迁移
    if (nameChanged || typeChanged) {
      // 1. 事务安全铁律：先加后删（Add-Before-Delete）
      // 先将新记录安全并入目标 (name, type) 下，自动处理已有合并与去重
      // 若目标添加失败（例如超限 16 条、上游报错等），在此处抛出异常并中断，原记录完好无损！
      const createRes = await this.createDnsRecord({
        domain: params.domain,
        type,
        name: targetRelative,
        content: params.content,
        ttl: Number(params.ttl) > 0 ? Number(params.ttl) : (Number(target.ttl) || 300),
        priority: params.priority,
      });

      // 2. 目标确认添加/合并成功后，再从原 RRset 中剥离或删除旧记录
      try {
        const existingValues = Array.isArray(target.values) && target.values.length > 0
          ? [...target.values]
          : target.value ? [target.value] : [];

        if (existingValues.length > 1) {
          // 优先按记录值内容比对匹配要移除的项，防止批量连续修改时下标漂移（Index Drift）
          const valToFind = (params.originContent || params.content).trim();
          let removeIdx = existingValues.indexOf(valToFind);
          if (removeIdx === -1 && targetIdx >= 0 && targetIdx < existingValues.length) {
            removeIdx = targetIdx;
          }

          if (removeIdx >= 0 && removeIdx < existingValues.length) {
            existingValues.splice(removeIdx, 1);
          }

          if (existingValues.length > 0) {
            // 获取最新 etag 避免并发冲突
            const latestRaw = await this.listRawDnsRecords(params.domain);
            const latestTarget = latestRaw.find((rec) => String(rec.id) === recordId);
            const etagToUse = latestTarget?.etag || target.etag;
            if (etagToUse) {
              await this.request("PATCH", `/domains/${encodeURIComponent(params.domain)}/dns/records/${encodeURIComponent(recordId)}`, {
                idempotencyKey: crypto.randomUUID(),
                ifMatchEtag: etagToUse,
                body: { values: existingValues },
              });
            }
          } else {
            await this.deleteDnsRecord(params.domain, recordId);
          }
        } else {
          // 原 RRset 只有这 1 项或单值，直接删除原 RRset
          await this.deleteDnsRecord(params.domain, recordId);
        }
      } catch (cleanErr) {
        console.warn("清理原解析记录失败（新记录已成功添加）:", cleanErr);
      }

      return createRes;
    }

    // 主机记录未改变（原地修改记录值、TTL 等）
    if (!target.etag) {
      throw new Error("上游未返回该记录的 ETag，无法安全修改（缺少 If-Match）。请刷新记录列表后重试");
    }

    const body: Record<string, unknown> = {};
    if (Number(params.ttl) > 0) {
      body.ttl = Number(params.ttl);
    }

    if (targetIdx >= 0) {
      // 多值展开的某一行：只替换对应下标的值，保留同组其余值
      const values = Array.isArray(target.values) && target.values.length > 0
        ? [...target.values]
        : target.value ? [target.value] : [];

      if (targetIdx < values.length) {
        values[targetIdx] = content;
      } else {
        values.push(content);
      }

      body.values = values;
    } else {
      body.value = content;
    }

    await this.request("PATCH", `/domains/${encodeURIComponent(params.domain)}/dns/records/${encodeURIComponent(recordId)}`, {
      idempotencyKey: crypto.randomUUID(),
      ifMatchEtag: target.etag,
      body,
    });
    return { success: true };
  }

  /**
   * 删除 DNS 解析记录
   *
   * NOTE: recordId 若形如 `<uuid>#<idx>` 且 RRset 包含多个记录值时，只剔除对应下标的值，
   * 剩余值通过 PATCH 保留；只有当记录集仅剩最后 1 个值或无下标时才真正发 DELETE。
   */
  async deleteDnsRecord(domain: string | number, recordId: string | number): Promise<ActionResponse> {
    const domainName = String(domain);
    const rawId = String(recordId);
    const [realId, idxStr] = rawId.split("#");
    const targetIdx = idxStr !== undefined && idxStr !== "" ? parseInt(idxStr, 10) : -1;

    const raw = await this.listRawDnsRecords(domainName);
    const target = raw.find((rec) => String(rec.id) === realId);
    if (target?.protected) {
      throw new Error("该记录由 DigitalPlat 服务管理（只读），无法删除");
    }

    if (targetIdx >= 0 && target) {
      const values = Array.isArray(target.values) && target.values.length > 0
        ? [...target.values]
        : target.value ? [target.value] : [];

      if (values.length > 1) {
        // 多值展开的某一行：只剔除该行对应的值，更新剩余值
        if (targetIdx < values.length) {
          values.splice(targetIdx, 1);
          if (!target.etag) {
            throw new Error("上游未返回该记录的 ETag，无法安全删除单项值（缺少 If-Match）。请刷新记录列表后重试");
          }
          await this.request("PATCH", `/domains/${encodeURIComponent(domainName)}/dns/records/${encodeURIComponent(realId)}`, {
            idempotencyKey: crypto.randomUUID(),
            ifMatchEtag: target.etag,
            body: { values },
          });
          return { success: true };
        }
      }
    }

    // 单值或最后一条值：删除整条 RRset
    await this.request(
      "DELETE",
      `/domains/${encodeURIComponent(domainName)}/dns/records/${encodeURIComponent(realId)}`,
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
