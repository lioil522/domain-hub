/**
 * DNSPod（腾讯云 DNSPod）API 客户端封装
 *
 * NOTE: 与 CloudflareClient / DigitalPlatClient 保持同一套路由协作约定 ——
 * listDnsRecords / createDnsRecord / updateDnsRecord / deleteDnsRecord 方法签名一致，
 * index.ts 路由层按账号 provider 分发。
 *
 * 认证走腾讯云 API 3.0 的 TC3-HMAC-SHA256 签名（与 Cloudflare 的 Bearer、DigitalPlat
 * 的 Bearer 都不同）。签名需要一对凭据：
 *   - SecretId：腾讯云账号的 API 密钥 ID（`AKID` 开头）
 *   - SecretKey：对应的密钥明文
 * DNSPod 的「API Token」是另一套东西（登录态 Token + 账号 ID），这里**不支持** ——
 * TC3 签名体系下只能走 SecretId/SecretKey。
 *
 * NOTE: 该文件只依赖标准 fetch / crypto.subtle，两个运行时（Workers 的 WebCrypto、
 * Node 22 的 globalThis.crypto）都能跑，不使用任何 Workers 专属 API。
 *
 * 与 Cloudflare 的关键结构差异：
 *   1. 腾讯云 API 3.0 是 POST + JSON body 的 RPC 风格，全部动作打同一个域名
 *      （dnspod.tencentcloudapi.com），靠 X-TC-Action 头区分接口；
 *   2. 域名（Domain）与解析记录（Record）是两级资源，列表接口都带分页；
 *   3. 记录的 Host 字段是**相对名**（`@` / `www` / `_dmarc`），与 CF 要求的完整域名相反，
 *      读写都需要在相对名与完整名之间转换。
 */

import type { ActionResponse, CreateDnsRecordResponse, DnsRecordInfo, ListDnsRecordsResponse } from "./dnshe";
import type { UpstreamSubdomain } from "./db";
import { zoneIdToNumericId } from "./cloudflare";

/** DNSPod 服务端点（腾讯云 API 3.0 固定网关） */
const DNSPOD_ENDPOINT = "dnspod.tencentcloudapi.com";
const DNSPOD_API_VERSION = "2021-03-23";
const DNSPOD_REGION = "ap-guangzhou";

/** 单次列表请求的页大小（上游上限 3000，取 100 兼顾报文体积） */
const DNSPOD_PAGE_SIZE = 100;

/** 列表接口最多翻多少页（防御上游分页异常导致的死循环） */
const DNSPOD_MAX_PAGES = 50;

/** 凭据对（腾讯云 SecretId + SecretKey） */
export interface DnspodCredentials {
  secretId: string;
  secretKey: string;
}

/** TC3 签名所需的请求上下文 */
interface Tc3SignedHeaders {
  authorization: string;
  timestamp: number;
}

/**
 * 判断一个字符串是否形如腾讯云 SecretId
 *
 * NOTE: 用于绑定时的前置校验，把「填了 DNSPod 的 API Token（登录态 token）」这类
 * 最常见的误填在本地就拦下来，不必浪费一次上游调用去换一句难懂的报错。
 */
export function looksLikeTencentSecretId(value: string): boolean {
  return /^(AKID|IKID)[A-Za-z0-9]{5,}$/.test(String(value || "").trim());
}

/** 把 ArrayBuffer 编成小写十六进制 */
function bufToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bufToHex(digest);
}

async function hmac(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  // NOTE: 从 ArrayBuffer 构造 CryptoKey 时必须显式 cast —— TS 5.9 起
  // BufferSource 对 ArrayBufferLike 的约束收紧了，直接传 ArrayBuffer 会报类型不兼容。
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

/**
 * 计算 TC3-HMAC-SHA256 签名（腾讯云 API 3.0 标准流程）
 *
 * 步骤：规范化请求串 → 拼接待签串 → 逐级派生签名密钥（日期→服务→tc3_request）
 * → 算出签名 → 组装 Authorization 头。
 */
async function buildTc3Authorization(
  cred: DnspodCredentials,
  action: string,
  payload: string,
  timestamp: number
): Promise<string> {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const service = "dnspod";

  // 1) 规范化请求串（CanonicalRequest）
  //    HTTPRequestMethod + CanonicalURI + CanonicalQueryString + CanonicalHeaders +
  //    SignedHeaders + HashedRequestPayload
  const hashedPayload = await sha256Hex(payload);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${DNSPOD_ENDPOINT}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join("\n");

  // 2) 待签串（StringToSign）
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  // 3) 逐级派生签名密钥
  const kDate = await hmac(new TextEncoder().encode(`TC3${cred.secretKey}`), date);
  const kService = await hmac(kDate, service);
  const kSigning = await hmac(kService, "tc3_request");
  const signature = bufToHex(await hmac(kSigning, stringToSign));

  // 4) 组装 Authorization
  return (
    `TC3-HMAC-SHA256 Credential=${cred.secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

/** 腾讯云 API 3.0 统一响应外壳 */
interface TcResponse<T> {
  Response: T & {
    RequestId?: string;
    Error?: { Code: string; Message: string };
  };
}

/** DNSPod 域名信息（DescribeDomainList / DescribeDomain 返回，只保留面板需要的字段） */
export interface DnspodDomainInfo {
  DomainId?: number;
  Name?: string;
  Status?: string;
  DomainGrade?: string;
  /** 域名的 NS 列表（DescribeDomainList 不返回，DescribeDomain 返回） */
  NameServers?: string[];
  CreatedOn?: string;
  UpdatedOn?: string;
  /** 记录数 */
  RecordCount?: number;
  /**
   * 域名在 DNSPod 的套餐到期时间
   *
   * NOTE: 这是**解析服务套餐**的到期时间，不是域名注册到期时间 —— DNSPod 是解析
   * 服务商，注册商侧有效期不在它的 API 里。面板上写「永久」（占位）避免误导。
   */
  EffectiveDNS?: string[];
}

/** DNSPod 记录原始形状（Host 是相对名，Value 是记录值） */
interface DnspodRecord {
  RecordId: number;
  Name: string;
  Type: string;
  Value: string;
  TTL: number;
  MX?: number;
  Line?: string;
  Status?: string;
  Weight?: number;
}

/**
 * 把 DNSPod 记录映射为与 DNSHE 一致的内部形状
 *
 * NOTE: DNSPod 的 `Name` 是相对名（`@` / `www`），但面板与 Cloudflare 一样统一
 * 以**完整域名**展示（前端按 full_domain 高亮、跨源搜索也按完整名匹配）。
 * 这里补全域名后缀；`@` 展开为域名本身。TTL 上游以 600 为默认，0 视作自动。
 */
function mapDnspodRecord(rec: DnspodRecord, domainName: string): DnsRecordInfo {
  const host = String(rec.Name || "").trim();
  const zone = String(domainName || "").trim().toLowerCase();
  const fqdn = !host || host === "@" ? zone : host.toLowerCase().endsWith(`.${zone}`) ? host.toLowerCase() : `${host.toLowerCase()}.${zone}`;

  return {
    id: rec.RecordId,
    name: fqdn,
    type: String(rec.Type || "").toUpperCase(),
    content: String(rec.Value || ""),
    // DNSPod 允许 0 表示「默认」；统一按面板惯例给 600
    ttl: Number(rec.TTL) > 0 ? Number(rec.TTL) : 600,
    priority: Number.isFinite(Number(rec.MX)) && Number(rec.MX) > 0 ? Number(rec.MX) : null,
    line: rec.Line ? String(rec.Line) : null,
    proxied: false,
  };
}

/**
 * 把主机记录转为 DNSPod 要求的**相对名**
 *
 * NOTE: 与 Cloudflare 的 toFqdnRecordName 正好相反 —— DNSPod 写接口只接受
 * `@` 或相对名，传完整域名会被上游拒绝（`Record name must be relative`）。
 * 路由层的 normalizeDnsRecordName 已经统一产出相对名，这里是第二道保险，
 * 保证前端「批量编辑回填完整域名」时也能正确折叠。
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
 * 把 DNSPod 域名映射为 domains_cache 的上游行
 *
 * NOTE: 数值主键复用 zoneIdToNumericId（对域名字符串做双 FNV-1a 稳定哈希），
 * 与 Cloudflare / DigitalPlat 的 id 空间不相交（前者哈希 zone id、后者哈希域名，
 * 但 DNSPod 的哈希输入加 `dnspod:` 前缀做命名空间隔离，避免「同一域名既在 CF
 * 又在 DNSPod」时两行撞同一个主键）。
 * expires_at 用 0000 前缀占位（前端 formatDate 显示「永久」）—— DNSPod 是解析
 * 服务商，注册商侧有效期不在它的 API 范围内，伪造一个日期会误导用户。
 */
export function mapDnspodDomainToUpstream(domain: DnspodDomainInfo): UpstreamSubdomain {
  const domainName = String(domain.Name || "").trim();
  const nameservers = (domain.NameServers || []).map((ns) => String(ns));

  return {
    id: zoneIdToNumericId(`dnspod:${domainName}`),
    subdomain: "",
    rootdomain: domainName,
    full_domain: domainName,
    // 上游 status 形如 ENABLE / PAUSE / SPAM，面板各标签页自己渲染，不走 DNSHE 三态
    status: domain.Status || "ENABLE",
    created_at: String(domain.CreatedOn || "").replace("T", " ").slice(0, 19),
    expires_at: "0000-00-00 00:00:00",
    has_dns: 1,
    dns_provider: "DNSPod",
    provider_account_id: domain.DomainId ?? null,
    remote_id: domainName,
    dns_state_known: true,
    // NS 列表随行带上，供前端「当前 DNS 服务器」一栏直接渲染（无需单独查一次）
    ns1: nameservers[0],
    ns2: nameservers[1],
  };
}

const DNSPOD_LINE_MAP: Record<string, string> = {
  default: "默认",
  telecom: "电信",
  unicom: "联通",
  mobile: "移动",
  oversea: "境外",
  edu: "教育网",
};

/**
 * DNSPod API 请求封装类
 *
 * 全部请求走 POST + JSON，靠 X-TC-Action 头区分接口，响应统一包在 `Response` 字段里。
 */
export class DnspodClient {
  private secretId: string;
  private secretKey: string;
  private baseUrl = `https://${DNSPOD_ENDPOINT}`;

  constructor(secretId: string, secretKey: string) {
    this.secretId = String(secretId || "").trim();
    this.secretKey = String(secretKey || "").trim();
  }

  /**
   * 通用请求封装 —— 发送 TC3 签名请求，非 2xx 或响应带 Error 时抛出中文异常
   */
  private async request<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    // 时间戳必须是秒级；payload 必须是**与签名时完全一致的字符串**，故先序列化再签名
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify(params);
    const authorization = await buildTc3Authorization(
      { secretId: this.secretId, secretKey: this.secretKey },
      action,
      payload,
      timestamp
    );

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json; charset=utf-8",
          Host: DNSPOD_ENDPOINT,
          "X-TC-Action": action,
          "X-TC-Version": DNSPOD_API_VERSION,
          "X-TC-Timestamp": String(timestamp),
          "X-TC-Region": DNSPOD_REGION,
        },
        body: payload,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "网络请求失败";
      throw new Error(`DNSPod API 请求失败：${message}`);
    }

    let data: TcResponse<T>;
    try {
      data = (await response.json()) as TcResponse<T>;
    } catch {
      throw new Error(`DNSPod API 响应异常 (HTTP ${response.status})`);
    }

    const body = data?.Response;
    if (!body) {
      throw new Error(`DNSPod API 响应格式异常 (HTTP ${response.status})`);
    }
    if (body.Error) {
      throw new Error(translateDnspodError(body.Error.Code, body.Error.Message));
    }
    if (!response.ok) {
      throw new Error(`DNSPod API 错误: HTTP ${response.status}`);
    }
    return body as T;
  }

  /**
   * 列出账号下全部域名（同时用于绑定时的凭据有效性校验）
   *
   * NOTE: 上游只返回 DomainId / Name / Status 等基础字段，**不含 NS**。需要 NS 时
   * 得对每个域名单独调 DescribeDomain（额外 N 次子请求）。面板的「当前 DNS 服务器」
   * 一栏在 DNSPod 标签页恒为 DNSPod 托管，故这里不额外拉 NS，省下配额。
   */
  async listDomains(): Promise<DnspodDomainInfo[]> {
    const domains: DnspodDomainInfo[] = [];
    let offset = 0;
    for (let page = 0; page < DNSPOD_MAX_PAGES; page++) {
      const res = await this.request<{ DomainList?: DnspodDomainInfo[]; DomainCountInfo?: { AllTotal?: number } }>(
        "DescribeDomainList",
        { Offset: offset, Limit: DNSPOD_PAGE_SIZE }
      );
      const list = Array.isArray(res.DomainList) ? res.DomainList : [];
      domains.push(...list.filter((d) => String(d.Name || "").trim() !== ""));
      if (list.length < DNSPOD_PAGE_SIZE) break;
      offset += DNSPOD_PAGE_SIZE;
    }
    return domains;
  }

  /**
   * 查询单个域名详情（含 NameServers 与套餐到期时间）
   *
   * 面板未直接使用，保留给「域名详情」类需求与排障时手工调用。
   */
  async describeDomain(domainName: string): Promise<DnspodDomainInfo> {
    const res = await this.request<{ DomainInfo?: DnspodDomainInfo }>("DescribeDomain", {
      Domain: String(domainName || "").trim(),
    });
    return res.DomainInfo || {};
  }

  /**
   * 分页列出域名下全部 DNS 解析记录（映射为内部形状）
   *
   * NOTE: `Domain` 参数接受**域名本身**（不是 DomainId）—— 路由层传的 remote_id
   * 是 DomainId 数字，这里需要调用方把域名传进来。为兼容两种入参，参数名为
   * `domain`，调用方（index.ts）统一传 domainInfo.full_domain。
   */
  async listDnsRecords(domain: string | number): Promise<ListDnsRecordsResponse> {
    const domainName = String(domain || "").trim();
    if (!domainName) {
      throw new Error("DNSPod 解析记录列表需要域名作为参数");
    }

    const records: DnsRecordInfo[] = [];
    let offset = 0;
    for (let page = 0; page < DNSPOD_MAX_PAGES; page++) {
      const res = await this.request<{ RecordList?: DnspodRecord[] }>("DescribeRecordList", {
        Domain: domainName,
        Offset: offset,
        Limit: DNSPOD_PAGE_SIZE,
      });
      const list = Array.isArray(res.RecordList) ? res.RecordList : [];
      records.push(...list.map((rec) => mapDnspodRecord(rec, domainName)));
      if (list.length < DNSPOD_PAGE_SIZE) break;
      offset += DNSPOD_PAGE_SIZE;
    }
    return { success: true, records };
  }

  /**
   * 把面板传入的写参数转为 DNSPod 的 Create/Modify 请求体
   *
   * NOTE: MX / SRV 的优先级用独立的 MX 字段承载（不是写在 Value 前缀里）——
   * 面板上用户按 BIND 惯例填「10 mail.example.com」，这里拆开；若前端已单独
   * 传了 priority 则优先用它。
   */
  private buildRecordPayload(params: {
    domain: string;
    type: string;
    name: string;
    content: string;
    ttl?: number;
    priority?: number;
    line?: string;
  }): Record<string, unknown> {
    const type = String(params.type || "").trim().toUpperCase();
    let content = String(params.content || "").trim();
    let priority = Number(params.priority);

    if (type === "MX") {
      if (!Number.isFinite(priority) || priority < 0) {
        const match = content.match(/^(\d+)\s+(.+)$/);
        if (match) {
          priority = Number(match[1]);
          content = match[2];
        }
      }
    }

    const lineKey = String(params.line || "default").trim().toLowerCase();
    const recordLine = DNSPOD_LINE_MAP[lineKey] || params.line || "默认";

    const payload: Record<string, unknown> = {
      Domain: String(params.domain || "").trim(),
      SubDomain: toRelativeRecordName(params.name, params.domain),
      RecordType: type,
      RecordLine: recordLine,
      Value: content,
      TTL: Number(params.ttl) > 0 ? Number(params.ttl) : 600,
    };
    if (type === "MX" && Number.isFinite(priority) && priority >= 0) {
      payload.MX = priority;
    }
    return payload;
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
    line?: string;
    record_id?: string | number;
  }): Promise<CreateDnsRecordResponse> {
    const res = await this.request<{ RecordId?: number }>(
      "CreateRecord",
      this.buildRecordPayload(params)
    );
    const lineKey = String(params.line || "default").trim().toLowerCase();
    const recordLine = DNSPOD_LINE_MAP[lineKey] || params.line || "默认";
    return {
      success: true,
      record: res.RecordId
        ? { id: res.RecordId, name: params.name, type: params.type, content: params.content, ttl: Number(params.ttl) || 600, priority: null, line: recordLine, proxied: false }
        : undefined,
    };
  }

  /**
   * 修改 DNS 解析记录
   *
   * NOTE: 上游 ModifyRecord 以 RecordId + Domain 定位记录，其余字段整条覆盖。
   * RecordLine 不传时上游按「默认」处理，这里显式下发避免记录被改到其他线路。
   */
  async updateDnsRecord(params: {
    domain: string;
    record_id: string | number;
    type: string;
    name: string;
    content: string;
    ttl?: number;
    priority?: number;
    line?: string;
  }): Promise<ActionResponse> {
    await this.request("ModifyRecord", {
      ...this.buildRecordPayload(params),
      RecordId: Number(params.record_id),
    });
    return { success: true };
  }

  /**
   * 删除 DNS 解析记录
   *
   * NOTE: 上游 DeleteRecord 需要 RecordId（数字）+ Domain，`domain` 参数即域名本身。
   */
  async deleteDnsRecord(domain: string | number, recordId: string | number): Promise<ActionResponse> {
    await this.request("DeleteRecord", {
      Domain: String(domain || "").trim(),
      RecordId: Number(recordId),
    });
    return { success: true };
  }
}

/**
 * 把腾讯云错误码翻译为可操作的中文指引
 *
 * NOTE: 腾讯云的原始报错是英文 + 错误码（如 `AuthFailure.SignatureFailure`），
 * 直接透传给用户几乎无法定位问题。这里覆盖了实际对接中最常撞上的几类：
 * 凭据无效 / 签名失败 / 权限不足 / 域名不在账号下 / 记录不存在。
 */
export function translateDnspodError(code: string, message: string): string {
  const c = String(code || "");
  const m = String(message || "");

  if (c === "AuthFailure.SignatureExpire" || /signature expired/i.test(m)) {
    return "DNSPod 签名已过期：通常是服务器时间与标准时间偏差过大（超过 5 分钟），请检查部署环境的时钟同步";
  }
  if (c === "AuthFailure.SignatureFailure" || /signature/i.test(m)) {
    return "DNSPod 签名校验失败：请核对 SecretKey 是否填写正确（SecretId 与 SecretKey 必须成对来自同一个腾讯云 API 密钥）";
  }
  if (c === "AuthFailure.SecretIdNotFound" || /secretid/i.test(m)) {
    return "DNSPod SecretId 不存在：请到腾讯云控制台「访问管理 → API 密钥管理」核对，或该密钥已被删除";
  }
  if (c === "AuthFailure" || c === "AuthFailure.TokenFailure") {
    return "DNSPod 认证失败：请在腾讯云控制台确认该 API 密钥处于「启用」状态且未被禁用";
  }
  if (c === "UnauthorizedOperation" || c === "FailedOperation.NotRealName" || /permission|not authorized|实名/i.test(m)) {
    return "DNSPod 权限不足：请确认该腾讯云账号已完成实名认证，且子账号具备 QcloudDNSPodFullAccess 策略";
  }
  if (c === "ResourceNotFound.NoDataOfDomain" || /domain.*not.*exist|域名不存在/i.test(m)) {
    return "该域名不在这个 DNSPod 账号下：请检查填写的账号是否正确，或域名尚未添加到 DNSPod";
  }
  if (c === "ResourceNotFound.NoDataOfRecord" || /record.*not.*exist/i.test(m)) {
    return "未在上游找到该解析记录（可能已被删除），请刷新记录列表后重试";
  }
  if (c === "FailedOperation.DomainIsLocked" || /locked/i.test(m)) {
    return "该域名在 DNSPod 中被锁定（可能因欠费或违规），请先到 DNSPod 控制台解除锁定";
  }
  if (c === "LimitExceeded.RecordLimitExceeded" || /record.*limit/i.test(m)) {
    return "该域名在 DNSPod 的解析记录数量已达套餐上限，请升级套餐或删除无用记录";
  }

  const detail = m ? `${c || "未知错误"}: ${m}` : c || "未知错误";
  return `DNSPod API 错误: ${detail}`;
}
