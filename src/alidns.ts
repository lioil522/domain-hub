/**
 * 阿里云云解析 DNS（Alidns）API 客户端封装
 *
 * NOTE: 与 CloudflareClient / DigitalPlatClient / DnspodClient 保持同一套路由协作约定 ——
 * listDnsRecords / createDnsRecord / updateDnsRecord / deleteDnsRecord 方法签名一致，
 * index.ts 路由层按账号 provider 分发。
 *
 * 认证走阿里云 RPC 风格签名（HMAC-SHA1）：
 *   - AccessKeyId：阿里云账号的 AccessKey ID（`LTAI` 开头）
 *   - AccessKeySecret：对应的密钥明文
 * 签名的正则是「把公共参数 + 业务参数按 key 字典序排列 → 拼成
 * `k=v&k=v` 的规范化查询串 → 拼上 `&Signature=<HMAC-SHA1(secret, "POST&%2F&" + 编码后的串)>`」。
 *
 * NOTE: 该文件只依赖标准 fetch / crypto.subtle，两个运行时（Workers 的 WebCrypto、
 * Node 22 的 globalThis.crypto）都能跑，不使用任何 Workers 专属 API。
 *
 * 与 Cloudflare 的关键结构差异：
 *   1. 阿里云是 RPC 风格 —— 参数走 query string（POST 但 URL 带参），
 *      响应是 XML（这里用正则解析出需要的字段，不引入 XML 依赖）；
 *   2. 域名与解析记录两级资源，列表都带分页（PageNumber / PageSize）；
 *   3. 记录的 RR 字段是**相对名**（`@` / `www`），与 DNSPod 相同、与 CF 相反；
 *   4. MX / SRV 的优先级写在 **Value 前缀**（`10 mail.example.com`），没有独立字段。
 */

import type { ActionResponse, CreateDnsRecordResponse, DnsRecordInfo, ListDnsRecordsResponse } from "./dnshe";
import type { UpstreamSubdomain } from "./db";
import { zoneIdToNumericId } from "./cloudflare";

const ALIDNS_ENDPOINT = "https://alidns.aliyuncs.com/";
const ALIDNS_API_VERSION = "2015-01-09";

/** 单次列表请求的页大小（上游上限 100） */
const ALIDNS_PAGE_SIZE = 100;

/** 列表接口最多翻多少页（防御上游分页异常导致的死循环） */
const ALIDNS_MAX_PAGES = 50;

/**
 * 判断一个字符串是否形如阿里云 AccessKey ID
 *
 * NOTE: 绑定时的前置校验。阿里云还有 RAM 子账号的 AccessKey，同样是 `LTAI` 开头，
 * 无法只靠前缀区分，因此这里只做「是不是 AccessKey 而不是别的什么」的粗筛。
 */
export function looksLikeAliyunAccessKeyId(value: string): boolean {
  return /^LTAI[A-Za-z0-9]{8,}$/.test(String(value || "").trim());
}

/** 阿里云 RPC 签名要求的百分号编码（与 encodeURIComponent 的差异见注释） */
function percentEncode(value: string): string {
  // NOTE: RFC 3986 的 unreserved 集合是 A-Za-z0-9-_.~，而 encodeURIComponent
  // 不编码 !'()* —— 阿里云签名要求这几个也编码，故逐个替换。
  return encodeURIComponent(value)
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~")
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  const bytes = new Uint8Array(sig);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * 从 XML 响应里取出某个标签的文本内容
 *
 * NOTE: 不引入 XML 解析依赖 —— 阿里云的响应结构扁平稳定，正则足够且没有 XXE 风险。
 * 只取第一个匹配（响应里的同名标签都是列表项级别的，调用方按 <Record> / <Domain>
 * 分块后再逐个取值）。
 */
function pickXml(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeXmlEntities(m[1]) : "";
}

/** 按标签名切出全部区块（用于列表响应逐项解析） */
function pickXmlBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

/** 还原 XML 实体（域名 / 记录值里可能出现 & < > " '） */
function decodeXmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

/** 阿里云域名信息（DescribeDomains 返回，只保留面板需要的字段） */
export interface AlidnsDomainInfo {
  DomainName?: string;
  DomainId?: string;
  /** 域名在阿里云解析的当前 NS 列表（DescribeDomains 一般返回 GroupName 而非 NS，拉详情才有） */
  DnsServers?: { DnsServer: string[] };
  RecordCount?: number;
  DomainLoggingSwitchStatus?: string;
  AliDomain?: boolean;
  VersionCode?: string;
  VersionName?: string;
  PunyCode?: string;
  InstanceId?: string;
}

/** 阿里云解析记录原始形状（RR 是相对名，Value 可能带 MX/SRV 优先级前缀） */
interface AlidnsRecord {
  RecordId: string;
  RR: string;
  Type: string;
  Value: string;
  TTL: number;
  Line?: string;
  Priority?: number;
  Status?: string;
  Weight?: number;
  Locked?: boolean;
}

/**
 * 把阿里云记录映射为与 DNSHE 一致的内部形状
 *
 * NOTE: RR 是相对名（`@` / `www`），面板统一以完整域名展示，这里补全后缀。
 * MX / SRV 的优先级阿里云自带 `Priority` 字段，优先读它；读不到时从 Value 前缀
 * 兜底解析（老账号可能只在 Value 里写）。
 */
function mapAlidnsRecord(rec: AlidnsRecord, domainName: string): DnsRecordInfo {
  const rr = String(rec.RR || "").trim();
  const zone = String(domainName || "").trim().toLowerCase();
  const fqdn = !rr || rr === "@" ? zone : rr.toLowerCase().endsWith(`.${zone}`) ? rr.toLowerCase() : `${rr.toLowerCase()}.${zone}`;

  const type = String(rec.Type || "").toUpperCase();
  let content = String(rec.Value || "");
  let priority: number | null = Number.isFinite(Number(rec.Priority)) && Number(rec.Priority) > 0 ? Number(rec.Priority) : null;

  // 兜底：老数据可能把优先级写在 Value 前缀（"10 mail.example.com"）
  if (priority === null && (type === "MX" || type === "SRV")) {
    const m = content.match(/^(\d+)\s+(.+)$/);
    if (m) priority = Number(m[1]);
  }

  return {
    id: rec.RecordId,
    name: fqdn,
    type,
    content,
    ttl: Number(rec.TTL) > 0 ? Number(rec.TTL) : 600,
    priority,
    line: rec.Line && rec.Line !== "default" ? String(rec.Line) : null,
    proxied: false,
  };
}

/**
 * 把主机记录转为阿里云要求的**相对名**
 *
 * NOTE: 与 DNSPod 的 toRelativeRecordName 同理 —— 阿里云写接口只接受 `@` 或相对名。
 * 保留原大小写（阿里云的 RR 大小写不敏感，但原样回传更贴近用户输入）。
 */
function toRelativeRecordName(name: string, domainName: string): string {
  const trimmed = String(name || "").trim().replace(/\.+$/, "");
  if (!trimmed || trimmed === "@") return "@";
  const zone = String(domainName || "").trim().toLowerCase().replace(/\.+$/, "");
  const lowered = trimmed.toLowerCase();
  if (zone && lowered === zone) return "@";
  if (zone && lowered.endsWith(`.${zone}`)) {
    return trimmed.slice(0, -(zone.length + 1)) || "@";
  }
  return trimmed;
}

/**
 * 把阿里云域名映射为 domains_cache 的上游行
 *
 * NOTE: 数值主键复用 zoneIdToNumericId，哈希输入加 `alidns:` 前缀与 DNSPod / CF
 * 做命名空间隔离，避免同一域名在多个托管商账号下撞同一个主键。
 * expires_at 用 0000 前缀占位 —— 阿里云解析是解析服务，域名注册有效期不在它的 API 里。
 */
export function mapAlidnsDomainToUpstream(domain: AlidnsDomainInfo): UpstreamSubdomain {
  const domainName = String(domain.DomainName || "").trim();
  // DnsServers.DnsServer 是字符串数组；空数组表示该域名用阿里云默认 NS
  const nameservers = Array.isArray(domain.DnsServers?.DnsServer)
    ? domain.DnsServers!.DnsServer.map((ns) => String(ns))
    : [];

  return {
    id: zoneIdToNumericId(`alidns:${domainName}`),
    subdomain: "",
    rootdomain: domainName,
    full_domain: domainName,
    status: "ENABLE",
    created_at: "",
    expires_at: "0000-00-00 00:00:00",
    has_dns: 1,
    dns_provider: "Aliyun",
    provider_account_id: domain.DomainId || null,
    remote_id: domainName,
    dns_state_known: true,
    ns1: nameservers[0],
    ns2: nameservers[1],
  };
}

/**
 * 阿里云云解析 DNS API 请求封装类
 *
 * 全部请求走 POST + query string 参数，响应是 XML。
 */
export class AlidnsClient {
  private accessKeyId: string;
  private accessKeySecret: string;

  constructor(accessKeyId: string, accessKeySecret: string) {
    this.accessKeyId = String(accessKeyId || "").trim();
    this.accessKeySecret = String(accessKeySecret || "").trim();
  }

  /**
   * 通用请求封装 —— 组装 RPC 参数、签名，返回原始 XML
   *
   * NOTE: 签名串要求除 Signature 以外的全部参数按 key 字典序排列，且 key/value 都
   * 经过 percentEncode。POST 请求的待签串固定是 `POST&%2F&<encoded query>`。
   */
  private async requestXml(action: string, params: Record<string, unknown> = {}): Promise<string> {
    const common: Record<string, string> = {
      Format: "JSON",
      Version: ALIDNS_API_VERSION,
      AccessKeyId: this.accessKeyId,
      SignatureMethod: "HMAC-SHA1",
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      SignatureVersion: "1.0",
      SignatureNonce: crypto.randomUUID(),
      Action: action,
    };

    const all: Record<string, string> = { ...common };
    for (const [key, val] of Object.entries(params)) {
      if (val === undefined || val === null || val === "") continue;
      all[key] = String(val);
    }

    const canonical = Object.keys(all)
      .sort()
      .map((key) => `${percentEncode(key)}=${percentEncode(all[key])}`)
      .join("&");

    const stringToSign = `POST&${percentEncode("/")}&${percentEncode(canonical)}`;
    const signature = await hmacSha1Base64(this.accessKeySecret, stringToSign);
    const query = `${canonical}&Signature=${percentEncode(signature)}`;

    let response: Response;
    try {
      response = await fetch(ALIDNS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: query,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "网络请求失败";
      throw new Error(`阿里云 DNS API 请求失败：${message}`);
    }

    const text = await response.text();

    // 阿里云失败时返回 4xx + JSON 错误体（{"Code":"...","Message":"..."}），
    // 成功时返回 XML。两种都要看一眼 Code 字段。
    if (!response.ok || /<Code>/.test(text.slice(0, 400))) {
      const jsonCode = text.match(/"Code"\s*:\s*"([^"]+)"/)?.[1];
      const jsonMessage = text.match(/"Message"\s*:\s*"([^"]*)"/)?.[1];
      const code = jsonCode || pickXml(text, "Code");
      const message = jsonMessage || pickXml(text, "Message");
      if (code || message) {
        throw new Error(translateAlidnsError(code, message));
      }
      throw new Error(`阿里云 DNS API 错误: HTTP ${response.status}`);
    }

    return text;
  }

  /**
   * 列出账号下全部域名（同时用于绑定时的 AccessKey 有效性校验）
   */
  async listDomains(): Promise<AlidnsDomainInfo[]> {
    const domains: AlidnsDomainInfo[] = [];
    for (let page = 1; page <= ALIDNS_MAX_PAGES; page++) {
      const xml = await this.requestXml("DescribeDomains", {
        PageNumber: page,
        PageSize: ALIDNS_PAGE_SIZE,
      });
      const blocks = pickXmlBlocks(xml, "Domain");
      for (const block of blocks) {
        const name = pickXml(block, "DomainName");
        if (!name) continue;
        const nsRaw = pickXmlBlocks(block, "DnsServer").map((ns) => decodeXmlEntities(ns).trim()).filter(Boolean);
        domains.push({
          DomainName: name,
          DomainId: pickXml(block, "DomainId"),
          RecordCount: Number(pickXml(block, "RecordCount")) || 0,
          DnsServers: nsRaw.length > 0 ? { DnsServer: nsRaw } : undefined,
          AliDomain: /true/i.test(pickXml(block, "AliDomain")),
        });
      }
      if (blocks.length < ALIDNS_PAGE_SIZE) break;
    }
    return domains;
  }

  /**
   * 分页列出域名下全部解析记录（映射为内部形状）
   *
   * NOTE: `domain` 参数即域名本身（阿里云 DescribeDomainRecords 以 DomainName 定位）。
   * 路由层的 remote_id 对 Alidns 行存的就是域名，故可直接传。
   */
  async listDnsRecords(domain: string | number): Promise<ListDnsRecordsResponse> {
    const domainName = String(domain || "").trim();
    if (!domainName) {
      throw new Error("阿里云 DNS 解析记录列表需要域名作为参数");
    }

    const records: DnsRecordInfo[] = [];
    for (let page = 1; page <= ALIDNS_MAX_PAGES; page++) {
      const xml = await this.requestXml("DescribeDomainRecords", {
        DomainName: domainName,
        PageNumber: page,
        PageSize: ALIDNS_PAGE_SIZE,
      });
      const blocks = pickXmlBlocks(xml, "Record");
      for (const block of blocks) {
        records.push(
          mapAlidnsRecord(
            {
              RecordId: pickXml(block, "RecordId"),
              RR: pickXml(block, "RR"),
              Type: pickXml(block, "Type"),
              Value: pickXml(block, "Value"),
              TTL: Number(pickXml(block, "TTL")) || 600,
              Line: pickXml(block, "Line"),
              Priority: Number(pickXml(block, "Priority")) || undefined,
              Status: pickXml(block, "Status"),
            },
            domainName
          )
        );
      }
      if (blocks.length < ALIDNS_PAGE_SIZE) break;
    }
    return { success: true, records };
  }

  /**
   * 把面板传入的写参数转为阿里云的 Add/Update 请求体
   *
   * NOTE: 阿里云的 MX / SRV 优先级有两种承载方式 —— 独立 `Priority` 参数（新）或
   * Value 前缀（老）。这里**统一用 Value 前缀**提交，因为这是官方文档的主推写法且
   * 向下兼容（阿里云会自动识别前缀并填 Priority 字段）。前端已单独填了优先级时，
   * 若 Value 里没有前缀则补上。
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
    const priority = Number(params.priority);
    const needsPriority = type === "MX" || type === "SRV";

    if (needsPriority && Number.isFinite(priority) && priority >= 0 && !/^\d+\s+/.test(content)) {
      content = `${priority} ${content}`;
    }

    const line = params.line ? String(params.line).toLowerCase() : "default";

    return {
      DomainName: String(params.domain || "").trim(),
      RR: toRelativeRecordName(params.name, params.domain),
      Type: type,
      Value: content,
      TTL: Number(params.ttl) > 0 ? Number(params.ttl) : 600,
      Line: line,
    };
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
    const xml = await this.requestXml("AddDomainRecord", this.buildRecordPayload(params));
    const recordId = pickXml(xml, "RecordId");
    return {
      success: true,
      record: recordId
        ? {
            id: recordId,
            name: params.name,
            type: params.type,
            content: params.content,
            ttl: Number(params.ttl) || 600,
            priority: null,
            line: params.line || "default",
            proxied: false,
          }
        : undefined,
    };
  }

  /**
   * 修改 DNS 解析记录
   *
   * NOTE: 阿里云的 UpdateDomainRecord 是**整条覆盖**语义，参数与 Add 基本一致，
   * 额外带 RecordId。RR / Type 也必须一并下发，否则会被上游清空。
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
    await this.requestXml("UpdateDomainRecord", {
      ...this.buildRecordPayload(params),
      RecordId: String(params.record_id),
    });
    return { success: true };
  }

  /**
   * 删除 DNS 解析记录
   *
   * NOTE: 阿里云 DeleteDomainRecord 只需 RecordId，但这里仍要求传 domain ——
   * 与其余三个客户端的方法签名保持一致（路由层统一传 remoteId, recordId）。
   */
  async deleteDnsRecord(_domain: string | number, recordId: string | number): Promise<ActionResponse> {
    await this.requestXml("DeleteDomainRecord", { RecordId: String(recordId) });
    return { success: true };
  }
}

/**
 * 把阿里云错误码翻译为可操作的中文指引
 *
 * NOTE: 阿里云的报错码形如 `InvalidAccessKeyId.NotFound` / `SignatureDoesNotMatch`，
 * 原始英文信息对用户无意义。这里覆盖实际对接中最常撞上的几类。
 */
export function translateAlidnsError(code: string, message: string): string {
  const c = String(code || "").trim();
  const m = String(message || "");

  if (c === "InvalidAccessKeyId.NotFound") {
    return "阿里云 AccessKey ID 不存在：请到阿里云控制台「访问控制 → 用户 → 创建 AccessKey」核对，或该 AccessKey 已被删除";
  }
  if (c === "SignatureDoesNotMatch") {
    return "阿里云签名不匹配：请核对 AccessKey Secret 是否填写正确（AccessKey ID 与 Secret 必须成对来自同一个 AccessKey）";
  }
  if (c === "Forbidden.RAM" || c === "Forbidden" || /forbidden|not authorized/i.test(m)) {
    return "阿里云权限不足：请确认该 AccessKey 所属账号已开通云解析 DNS，且 RAM 子账号具备 AliyunDNSFullAccess 策略";
  }
  if (c === "InvalidDomainName.NoExist" || /domain.*not.*exist|域名不存在/i.test(m)) {
    return "该域名不在这个阿里云账号的云解析中：请检查账号是否正确，或域名尚未添加到云解析 DNS";
  }
  if (c === "DomainRecordNotBelongToUser" || c === "InvalidRecordId.NotFound") {
    return "未在上游找到该解析记录（可能已被删除），请刷新记录列表后重试";
  }
  if (c === "DomainForbidden" || c === "DomainLocked") {
    return "该域名在阿里云云解析中被锁定，请先到阿里云控制台解除锁定";
  }
  if (c === "QuotaExceeded" || /quota|limit/i.test(m)) {
    return "阿里云云解析的记录数量已达套餐上限，请升级套餐或删除无用记录";
  }
  if (c === "Throttling" || /throttl/i.test(m)) {
    return "阿里云 API 请求过于频繁被限流，请稍后重试";
  }

  const detail = m ? `${c || "未知错误"}: ${m}` : c || "未知错误";
  return `阿里云 DNS API 错误: ${detail}`;
}
