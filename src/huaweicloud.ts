/**
 * 华为云云解析服务（DNS）API 客户端封装
 *
 * NOTE: 与 CloudflareClient / DigitalPlatClient / DnspodClient / AlidnsClient 保持
 * 同一套路由协作约定 —— listDnsRecords / createDnsRecord / updateDnsRecord /
 * deleteDnsRecord 方法签名一致，index.ts 路由层按账号 provider 分发。
 *
 * 认证走华为云的 SDK-HMAC-SHA256 签名：
 *   - AccessKeyId：华为云账号的 AK（惯例是 20 位大写字母数字）
 *   - SecretAccessKey：对应的 SK
 * 签名规则：`SDK-HMAC-SHA256 Access=<AK>, SignedHeaders=<...>, Signature=<hex>`，
 * 待签串是 `SDK-HMAC-SHA256\n<X-Sdk-Date>\n<CanonicalRequest>`，其中 CanonicalRequest
 * 的头部值必须与请求实际下发的完全一致（含 host、x-sdk-date），且**规范 URI 必须补尾斜杠**。
 *
 * NOTE: 华为云有中国站与国际站两个相互独立的站点，但两者共用同一套
 * `myhuaweicloud.com` 终端节点，所以终端节点不区分站点 —— 见 HUAWEI_DNS_HOSTS。
 *
 * NOTE: 该文件只依赖标准 fetch / crypto.subtle，两个运行时都能跑，不使用 Workers 专属 API。
 *
 * 与 Cloudflare 的关键结构差异：
 *   1. 华为云是 REST 风格 —— 路径为 `/v2/zones/{zone_id}/recordsets/{recordset_id}`，
 *      认证放 Authorization 头，与 CF 的 Bearer 结构类似但签名方式不同；
 *   2. DNS 记录是 **Recordset 模型**（同名同类型合并为一条，`records` 是值数组），
 *      与 DigitalPlat 的 RRset 一致、与 CF 的「一条一值」相反；
 *   3. 记录名必须是**带尾点的完整域名**（`www.example.com.`），既不是 CF 的裸完整名
 *      （`www.example.com`），也不是 DNSPod / 阿里的相对名。
 */

import type { ActionResponse, CreateDnsRecordResponse, DnsRecordInfo, ListDnsRecordsResponse } from "./dnshe";
import type { UpstreamSubdomain } from "./db";
import { zoneIdToNumericId } from "./cloudflare";

/**
 * 华为云 DNS 终端节点候选表（按优先级，命中即止）
 *
 * 华为云有**中国站**与**国际站**两个相互独立的站点 —— 账号体系完全隔离，
 * 同一份 AK/SK 不能跨站使用（官方 FAQ 原文：「中国站和国际站是相互独立的」）。
 * 但两站的云解析 API 网关是**同一套** `myhuaweicloud.com` 域名，也就是说
 * 终端节点不区分站点，是 AK/SK 决定你落在哪个站点。
 *
 * 所以这里默认用官方的**全局节点** `dns.myhuaweicloud.com`（文档推荐，自动
 * 路由到最优节点）—— 它同时覆盖中国站与国际站的账号，不必让用户选站点。
 * 后面几个区域节点只作兜底：全局节点在个别网络环境下可能不可达，
 * 而区域节点在极端环境下仍有直连价值。
 *
 * NOTE: 公网域名在华为云是**全局资源**（官方文档：「公网域名为全局资源，
 * 请选择华北-北京四区域调用」），所以区域节点的差异只在接入点，不影响
 * 能看到哪些域名 —— 换节点不会让域名列表变多或变少。
 */
const HUAWEI_DNS_HOSTS: readonly string[] = [
  "dns.myhuaweicloud.com", // 全局节点（官方推荐，同时服务中国站与国际站）
  "dns.cn-north-4.myhuaweicloud.com", // 中国站 · 华北-北京四（公网域名官方指定区域）
  "dns.ap-southeast-1.myhuaweicloud.com", // 国际站 · 亚太-中国香港
  "dns.ap-southeast-3.myhuaweicloud.com", // 国际站 · 亚太-新加坡
];

/**
 * 已探明的可用节点（按 AK 记忆）
 *
 * WHY 按 AK 缓存：换节点的唯一原因是「节点不可达」，而可达性基本由部署环境
 * 决定、与具体账号无关；但缓存键仍用 AK 而不是全局单值，避免多账号共存时
 * 互相覆盖已探明的结果。isolate 重建后缓存丢失只会多探一次，无正确性风险。
 */
const resolvedHuaweiHost = new Map<string, string>();

/** 单次列表请求的条数（上游上限 500，取 100 兼顾报文体积） */
const HUAWEI_PAGE_SIZE = 100;

/** 列表接口最多翻多少页（防御上游分页异常导致的死循环） */
const HUAWEI_MAX_PAGES = 50;

/**
 * 节点级失败 —— 只说明**这个接入点**用不了，与凭据无关，可以顺延到下一个候选节点。
 *
 * NOTE: 必须与「凭据级失败」严格区分开。认证失败（401 / APIGW.0301）是凭据的
 * 结论，换节点重试没有意义，而且会让用户等 4 倍时间才看到真正的错误。
 */
class HuaweiEndpointUnreachableError extends Error {}

/**
 * 判断一个字符串是否形如华为云 AccessKey ID（20 位大写字母数字）
 *
 * NOTE: 这只是**经验形状**，不是华为云公开承诺的规则，因此只用于「认证失败后
 * 的补充提示」，绝不能拿它当绑定前的拦截条件 —— 猜错就会把有效凭据挡在门外。
 */
export function looksLikeHuaweiAccessKeyId(value: string): boolean {
  return /^[A-Z0-9]{20}$/.test(String(value || "").trim());
}

/**
 * 计算签名用的规范 URI —— **必须补上尾斜杠**
 *
 * 华为云签名文档（「构造规范请求 · 步骤 2」）原文：
 *   「如果 URI 路径不以`/`结尾，则在尾部添加`/`」
 *   「计算签名时，URI 必须以`/`结尾。**发送请求时，可以不以`/`结尾**」
 *
 * NOTE: 这正是踩过的坑 —— 原先直接把 `/v2/zones` 拿去签名，网关按带斜杠的
 * `/v2/zones/` 重算规范请求，两边哈希对不上，一律回 APIGW.0301「认证失败」。
 * 错误信息看着像 AK/SK 填错了，实际是路径少了尾斜杠，属于最误导人的一类失败。
 */
function toSignablePath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

/**
 * 按 RFC 3986 做百分号编码（华为云规范查询串要求）
 *
 * NOTE: `encodeURIComponent` 会漏掉 `!'()*` 五个字符，而华为云要求除
 * `A-Za-z0-9-_.~` 之外一律编码；空格也必须是 `%20`，不能是表单式的 `+`。
 */
function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * 构造规范查询串（华为云签名文档「步骤 3」）
 *
 * 参数按名称字符码升序排列，名与值都做 RFC 3986 编码。
 *
 * NOTE: 产出的这个字符串会**原样**用在请求 URL 上，而不是重新拼一遍 ——
 * 签名与实际下发必须是同一个字节序列，否则网关算出的哈希和客户端不一致。
 * （`URLSearchParams` 把空格编成 `+`、且英文排序规则不完全等同字符码排序，
 * 另拼一次就是埋一个只在特定参数值下才炸的雷。）
 */
function buildCanonicalQuery(query?: Record<string, unknown>): string {
  if (!query) return "";
  return Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${rfc3986Encode(key)}=${rfc3986Encode(value)}`)
    .join("&");
}

function bufToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * 组装规范请求（CanonicalRequest）—— 华为云签名「步骤 1」
 *
 * 单独抽成纯函数对外导出，是为了能用官方文档给出的**已知哈希**做回归测试
 * （见 huaweicloud-signature.test.ts）：签名这类代码「看起来对」和「真的对」
 * 之间只差一个字符，只能靠外部金标准向量来钉住。
 *
 * 规范请求 = `请求方法\n规范URI\n规范查询串\n规范消息头\nSignedHeaders\nbody哈希`
 * 其中规范消息头自身**每条都以换行结尾（最后一条也是）**，叠加 join 的分隔换行，
 * 于是 SignedHeaders 之前必然出现一个空行 —— 这是文档明确说明的行为，不是笔误。
 *
 * @param headers 参与签名的消息头（大小写不敏感，函数内部统一转小写、去首尾空格后按名排序）
 */
export function buildHuaweiCanonicalRequest(params: {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  headers: Array<[string, string]>;
  payloadHash: string;
}): { canonicalRequest: string; signedHeaders: string; canonicalQuery: string; signedPath: string } {
  const canonicalQuery = buildCanonicalQuery(params.query);
  const signedPath = toSignablePath(params.path);

  const sortedHeaders = params.headers
    .map(([name, value]) => [name.toLowerCase(), String(value).trim()] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const signedHeaders = sortedHeaders.map(([name]) => name).join(";");
  const canonicalHeaders = sortedHeaders.map(([name, value]) => `${name}:${value}\n`).join("");

  const canonicalRequest = [
    params.method,
    signedPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    params.payloadHash,
  ].join("\n");

  return { canonicalRequest, signedHeaders, canonicalQuery, signedPath };
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bufToHex(digest);
}

async function hmacSha256(key: string, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

/** 华为云域名信息（ListPublicZones / ListPrivateZones 返回，只保留面板需要的字段） */
export interface HuaweiZoneInfo {
  id: string;
  name: string;
  description?: string;
  type?: string;
  ttl?: number;
  email?: string;
  record_num?: number;
  status?: string;
  pool_id?: string;
  zone_type?: string;
  created_at?: string;
  updated_at?: string;
  nameservers?: string[];
}

/** 华为云 Recordset 原始形状（records 是值数组） */
interface HuaweiRecordSet {
  id: string;
  name: string;
  type: string;
  ttl: number;
  records: string[];
  line?: string;
  status?: string;
  description?: string;
  zone_id?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * 把华为云的完整域名（带尾点）转为面板惯例的裸域名
 *
 * NOTE: 华为云的记录名与 zone 名都带尾点（`www.example.com.`），面板与其余托管商
 * 一律用不带尾点的形式，这里统一去掉。
 */
function stripTrailingDot(value: string): string {
  return String(value || "").trim().replace(/\.+$/, "").toLowerCase();
}

/**
 * 把 Recordset 展开为与 DNSHE 一致的内部形状
 *
 * NOTE: Recordset 是多值合并模型（一条记录最多 20 个值），面板按「一条一值」展示，
 * 所以一条 Recordset 会展开成 N 行 —— 每行共用同一个 recordset id，编辑任一行都会
 * 覆盖整条 Recordset 的所有值。这与 DigitalPlat 的处理方式一致。
 *
 * 华为云把 MX / SRV 的优先级写在值的前缀里（`10 mail.example.com.`），与阿里云相同。
 */
function mapHuaweiRecordSet(rs: HuaweiRecordSet): DnsRecordInfo[] {
  const name = stripTrailingDot(rs.name);
  const type = String(rs.type || "").toUpperCase();
  const ttl = Number(rs.ttl) > 0 ? Number(rs.ttl) : 300;

  return (Array.isArray(rs.records) ? rs.records : []).map((raw, idx) => {
    const value = String(raw || "");
    let priority: number | null = null;
    if (type === "MX" || type === "SRV") {
      const m = value.match(/^(\d+)\s+(.+)$/);
      if (m) priority = Number(m[1]);
    }
    return {
      // 同一 Recordset 的多值共享 id —— 前端按行渲染，末尾追加下标避免 React key 冲突
      id: rs.records.length > 1 ? `${rs.id}#${idx}` : rs.id,
      name,
      type,
      // NOTE: 华为云的值带尾点（target 类记录），前端展示与其余托管商保持一致去掉
      content: type === "CNAME" || type === "MX" || type === "NS" || type === "SRV" || type === "PTR"
        ? stripTrailingDot(value.replace(/^\d+\s+/, ""))
        : value,
      ttl,
      priority,
      line: rs.line ? String(rs.line) : null,
      proxied: false,
    };
  });
}

/**
 * 把 HuaweiZoneInfo 映射为 domains_cache 的上游行
 *
 * NOTE: 数值主键复用 zoneIdToNumericId，哈希输入加 `huawei:` 前缀做命名空间隔离。
 * remote_id 存 zone id（华为云后续的记录路径都以 zone id 为参数）。
 * expires_at 用 0000 前缀占位 —— 华为云 DNS 是解析服务，域名注册有效期不在其 API 内。
 */
export function mapHuaweiZoneToUpstream(zone: HuaweiZoneInfo): UpstreamSubdomain {
  const zoneName = stripTrailingDot(zone.name);

  return {
    id: zoneIdToNumericId(`huawei:${zone.id}`),
    subdomain: "",
    rootdomain: zoneName,
    full_domain: zoneName,
    status: zone.status || "ACTIVE",
    created_at: String(zone.created_at || "").replace("T", " ").slice(0, 19),
    expires_at: "0000-00-00 00:00:00",
    has_dns: 1,
    dns_provider: "HuaweiCloud",
    provider_account_id: zone.id,
    remote_id: zone.id,
    dns_state_known: true,
  };
}

/** 判断一个线路值是否为默认线路（空、null、undefined、default、default_line、default_view 统一视作默认） */
export function isHuaweiDefaultLine(line: string | undefined | null): boolean {
  const s = String(line || "").trim().toLowerCase();
  return (
    !s ||
    s === "default" ||
    s === "default_line" ||
    s === "default_view" ||
    s === "null" ||
    s === "undefined"
  );
}

/** 比较两个华为云线路标识是否相等（默认线路之间互等） */
export function isHuaweiLineEqual(lineA: string | undefined | null, lineB: string | undefined | null): boolean {
  if (isHuaweiDefaultLine(lineA) && isHuaweiDefaultLine(lineB)) return true;
  return String(lineA || "").trim().toLowerCase() === String(lineB || "").trim().toLowerCase();
}

/**
 * 华为云云解析 DNS API 请求封装类
 */
export class HuaweiCloudClient {
  private accessKeyId: string;
  private secretAccessKey: string;
  /** 显式固定的终端节点；为空时按候选表自动探测 */
  private pinnedHost: string;

  /**
   * @param host 可选。显式指定终端节点（绕过自动探测）。常规调用不要传，
   *             让客户端自己走「全局节点 → 区域节点」的候选顺序，这样
   *             中国站与国际站的账号都不需要用户额外选择站点。
   */
  constructor(accessKeyId: string, secretAccessKey: string, host?: string) {
    this.accessKeyId = String(accessKeyId || "").trim();
    this.secretAccessKey = String(secretAccessKey || "").trim();
    this.pinnedHost = String(host || "").trim();
  }

  /** 本次请求依次尝试的终端节点 */
  private candidateHosts(): string[] {
    if (this.pinnedHost) return [this.pinnedHost];
    const cached = resolvedHuaweiHost.get(this.accessKeyId);
    if (!cached) return [...HUAWEI_DNS_HOSTS];
    // 探明过的节点排最前，其余仍留作兜底
    return [cached, ...HUAWEI_DNS_HOSTS.filter((h) => h !== cached)];
  }

  /**
   * 通用请求封装 —— 组装 SDK-HMAC-SHA256 签名请求
   *
   * NOTE: 待签串里 CanonicalHeaders 必须与实际下发的 host / x-sdk-date **逐字符一致**，
   * 且 SignedHeaders 要按字母序声明；body 的哈希用空串的 SHA-256（GET/DELETE）或
   * 实际 body 的 SHA-256。规范 URI 必须补尾斜杠（见 toSignablePath，这是本项目
   * 踩过的真实坑）。按候选择终端节点依次尝试：只有**节点级失败**才顺延，
   * 拿到任何真实的 API 应答即返回。
   */
  private async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown } = {}
  ): Promise<T> {
    const bodyText = options.body === undefined ? "" : JSON.stringify(options.body);
    const xSdkDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
    const bodyHash = await sha256Hex(bodyText);

    let lastError: unknown = null;
    for (const host of this.candidateHosts()) {
      // 规范请求与实际下发的查询串由同一个函数产出，杜绝两边编码规则不一致
      const { canonicalRequest, signedHeaders, canonicalQuery } = buildHuaweiCanonicalRequest({
        method,
        path,
        query: options.query,
        headers: [
          ["host", host],
          ["x-sdk-date", xSdkDate],
        ],
        payloadHash: bodyHash,
      });
      // 发送用原始路径，签名用补了尾斜杠的路径 —— 华为云明确允许两者不同
      const requestUrl = `https://${host}${path}${canonicalQuery ? `?${canonicalQuery}` : ""}`;

      // 待签串 → 签名
      const stringToSign = `SDK-HMAC-SHA256\n${xSdkDate}\n${await sha256Hex(canonicalRequest)}`;
      const signature = bufToHex(await hmacSha256(this.secretAccessKey, stringToSign));
      const authorization =
        `SDK-HMAC-SHA256 Access=${this.accessKeyId}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

      let response: Response;
      try {
        response = await fetch(requestUrl, {
          method,
          headers: {
            Authorization: authorization,
            // NOTE: 不再手工下发 Host —— 它属于 fetch 的禁止标头，运行时只会
            // 静默忽略；请求实际使用的 Host 由 URL 决定，与签名里的 host 天然一致。
            "X-Sdk-Date": xSdkDate,
            "Content-Type": "application/json",
          },
          body: bodyText === "" ? undefined : bodyText,
        });
      } catch (e: unknown) {
        // 连不上 / 域名解析不了 —— 节点级失败，换下一个候选
        lastError = new HuaweiEndpointUnreachableError(
          `华为云 DNS 终端节点 ${host} 不可达：${e instanceof Error ? e.message : "网络请求失败"}`
        );
        continue;
      }

      if (response.status === 204) {
        resolvedHuaweiHost.set(this.accessKeyId, host);
        return {} as T;
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new Error(`华为云 DNS API 响应异常 (HTTP ${response.status})`);
      }

      if (!response.ok) {
        const err = data as { error_code?: string; error_msg?: string; message?: string; code?: string };
        const code = String(err?.error_code || err?.code || "");
        const message = String(err?.error_msg || err?.message || "");

        // 404 /「接口未在该环境发布」= 这个接入点根本没有该 API，属节点级失败，可以顺延。
        // NOTE: 401(APIGW.0301) 是**凭据级**结论 —— 换节点结果完全一样，必须立刻抛给
        // 用户，否则要多花 3 次请求才看到同一句「认证失败」，白白拖慢绑定。
        if (response.status === 404 || /does not exist or has not been published/i.test(message)) {
          lastError = new HuaweiEndpointUnreachableError(
            `华为云 DNS 终端节点 ${host} 未提供该接口 (HTTP ${response.status})`
          );
          continue;
        }

        const translated = translateHuaweiError(code, message, response.status);
        throw new HuaweiApiError(translated, code, response.status, message);
      }

      resolvedHuaweiHost.set(this.accessKeyId, host);
      return data as T;
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("华为云 DNS API 不可达：所有候选终端节点均连接失败");
  }

  /**
   * 列出账号下全部公网域名（同时用于绑定时的 AK/SK 有效性校验）
   *
   * NOTE: 只列公网域名（ListPublicZones）—— 面板管理的是公网解析，私网 zone
   * 没有对外的 NS 委派，列出来只会让用户困惑。分页参数是 limit/offset。
   */
  async listDomains(): Promise<HuaweiZoneInfo[]> {
    const zones: HuaweiZoneInfo[] = [];
    for (let page = 0; page < HUAWEI_MAX_PAGES; page++) {
      const res = await this.request<{ zones?: HuaweiZoneInfo[] }>("GET", "/v2/zones", {
        query: { limit: HUAWEI_PAGE_SIZE, offset: page * HUAWEI_PAGE_SIZE, type: "public" },
      });
      const list = Array.isArray(res.zones) ? res.zones : [];
      zones.push(...list.filter((z) => String(z.name || "").trim() !== ""));
      if (list.length < HUAWEI_PAGE_SIZE) break;
    }
    return zones;
  }

  /**
   * 在华为云中创建公网域名（Zone，支持主域与子域）
   *
   * @param zoneName 域名，如 example.com 或 sub.example.com
   */
  async createZone(zoneName: string): Promise<HuaweiZoneInfo> {
    const raw = String(zoneName || "").trim().toLowerCase();
    if (!raw) {
      throw new Error("域名不能为空");
    }
    const formatted = raw.endsWith(".") ? raw : `${raw}.`;
    const res = await this.request<HuaweiZoneInfo>("POST", "/v2/zones", {
      body: {
        name: formatted,
        zone_type: "public",
      },
    });
    if (!res || !res.id) {
      throw new Error("华为云创建公网域名失败，上游未返回数据");
    }
    return res;
  }

  /**
   * 分页列出 zone 下全部原始 Recordset
   *
   * NOTE: 上下游统一复用本方法的分页逻辑（limit: 100, offset: page * 100），杜绝 limit: 500 导致网关报 400
   */
  async listAllRawRecordSets(zoneId: string | number): Promise<HuaweiRecordSet[]> {
    const id = String(zoneId || "").trim();
    if (!id) return [];

    const recordsets: HuaweiRecordSet[] = [];
    for (let page = 0; page < HUAWEI_MAX_PAGES; page++) {
      const res = await this.request<{ recordsets?: HuaweiRecordSet[] }>(
        "GET",
        `/v2/zones/${encodeURIComponent(id)}/recordsets`,
        { query: { limit: HUAWEI_PAGE_SIZE, offset: page * HUAWEI_PAGE_SIZE } }
      );
      const list = Array.isArray(res.recordsets) ? res.recordsets : [];
      recordsets.push(...list);
      if (list.length < HUAWEI_PAGE_SIZE) break;
    }
    return recordsets;
  }

  /**
   * 分页列出 zone 下全部 Recordset（展开多值后映射为内部形状）
   *
   * NOTE: `zoneId` 是华为云的 zone id（domains_cache.remote_id 存的就是它）。
   */
  async listDnsRecords(zoneId: string | number): Promise<ListDnsRecordsResponse> {
    const id = String(zoneId || "").trim();
    if (!id) {
      throw new Error("华为云 DNS 解析记录列表需要 zone id 作为参数");
    }

    const rawList = await this.listAllRawRecordSets(id);
    const records: DnsRecordInfo[] = [];
    for (const rs of rawList) {
      records.push(...mapHuaweiRecordSet(rs));
    }
    return { success: true, records };
  }

  /**
   * 根据 ID 查询单个 RecordSet
   *
   * NOTE: 华为云官方公网单条 RecordSet 详情标准路径为 GET /v2/zones/{zoneId}/recordsets/{id}；
   * 若返回 404 或不可用，备用尝试 GET /v2/recordsets/{id}，兜底从稳健的 listAllRawRecordSets 列表中查找。
   */
  async getRecordSetById(zoneId: string | number, recordSetId: string): Promise<HuaweiRecordSet | null> {
    const id = String(recordSetId || "").split("#")[0].trim();
    if (!id) return null;

    // 1. 优先调用官方标准路径 GET /v2/zones/{zoneId}/recordsets/{id}
    try {
      const res = await this.request<HuaweiRecordSet>(
        "GET",
        `/v2/zones/${encodeURIComponent(String(zoneId))}/recordsets/${encodeURIComponent(id)}`
      );
      if (res && res.id) return res;
    } catch {
      // 容错降级
    }

    // 2. 备用尝试 GET /v2/recordsets/{id}
    try {
      const res = await this.request<HuaweiRecordSet>(
        "GET",
        `/v2/recordsets/${encodeURIComponent(id)}`
      );
      if (res && res.id) return res;
    } catch {
      // 容错降级
    }

    // 3. 兜底：直接拉取该 zone 下的 recordsets 列表在本地匹配
    try {
      const list = await this.listAllRawRecordSets(zoneId);
      const found = list.find((rs) => rs.id === id);
      if (found) return found;
    } catch {
      // 容错
    }

    return null;
  }

  /**
   * 根据 name、type、line 精确查找单个 RecordSet
   * 若精确匹配未命中，采用同名同类型的强力兜底匹配；若发现同名互斥记录（如已存在 CNAME），抛出明确提示
   */
  async findRecordSet(params: {
    zoneId: string | number;
    zoneName: string;
    type: string;
    name: string;
    line?: string;
  }): Promise<HuaweiRecordSet | null> {
    const type = String(params.type || "").trim().toUpperCase();
    const zone = stripTrailingDot(params.zoneName);
    const rawName = String(params.name || "").trim().replace(/\.+$/, "");
    const fqdn = !rawName || rawName === "@" ? zone : rawName.toLowerCase().endsWith(`.${zone}`) ? rawName.toLowerCase() : `${rawName.toLowerCase()}.${zone}`;

    // 1. 优先从稳健的全量列表拉取进行双层本地比对
    let list: HuaweiRecordSet[] = [];
    try {
      list = await this.listAllRawRecordSets(params.zoneId);
    } catch {
      // 容错降级
    }

    if (list.length > 0) {
      // 1.1 第一优先级：精确匹配 (fqdn, type, line)
      const exactMatch = list.find(
        (rs) =>
          stripTrailingDot(rs.name) === fqdn &&
          String(rs.type).toUpperCase() === type &&
          isHuaweiLineEqual(rs.line, params.line)
      );
      if (exactMatch) return exactMatch;

      // 1.2 第二优先级（强力兜底）：同名同类型匹配
      // 在公网解析场景下，一旦上游返回 409 Conflict，说明该同名同类型的 RecordSet 已经存在。
      // 华为云可能将默认线路返回为 null/undefined/""/"default_view"，无论如何该 FQDN+Type 均属同一个 RecordSet
      const sameTypeRecords = list.filter(
        (rs) => stripTrailingDot(rs.name) === fqdn && String(rs.type).toUpperCase() === type
      );
      if (sameTypeRecords.length === 1) {
        return sameTypeRecords[0];
      }
      if (sameTypeRecords.length > 1) {
        // 多条记录集时，优先匹配默认线路
        const defaultMatch = sameTypeRecords.find((rs) => isHuaweiDefaultLine(rs.line));
        if (defaultMatch) return defaultMatch;
        return sameTypeRecords[0];
      }

      // 1.3 若未找到同名同类型，检查是否已存在同名但不同类型的互斥记录集（例如已存在 CNAME）
      const conflictRecord = list.find((rs) => stripTrailingDot(rs.name) === fqdn);
      if (conflictRecord && String(conflictRecord.type).toUpperCase() !== type) {
        throw new Error(
          `该主机名已存在同名 ${conflictRecord.type} 解析记录（记录值: ${conflictRecord.records?.join(", ") || "(空)"}），DNS 规范不允许 ${conflictRecord.type} 与 ${type} 共存，请先删除该 ${conflictRecord.type} 记录后再添加`
        );
      }
    }

    // 2. 备用尝试：带 name / type 查询（分带点和不带点兼容各网关版本）
    try {
      const res = await this.request<{ recordsets?: HuaweiRecordSet[] }>(
        "GET",
        `/v2/zones/${encodeURIComponent(String(params.zoneId))}/recordsets`,
        {
          query: {
            name: `${fqdn}.`,
            type,
            limit: HUAWEI_PAGE_SIZE,
          },
        }
      );
      const queryList = Array.isArray(res.recordsets) ? res.recordsets : [];
      const found = queryList.find(
        (rs) =>
          stripTrailingDot(rs.name) === fqdn &&
          String(rs.type).toUpperCase() === type
      );
      if (found) return found;
    } catch {
      // 容错
    }

    try {
      const res = await this.request<{ recordsets?: HuaweiRecordSet[] }>(
        "GET",
        `/v2/zones/${encodeURIComponent(String(params.zoneId))}/recordsets`,
        {
          query: {
            name: fqdn,
            type,
            limit: HUAWEI_PAGE_SIZE,
          },
        }
      );
      const queryList = Array.isArray(res.recordsets) ? res.recordsets : [];
      const found = queryList.find(
        (rs) =>
          stripTrailingDot(rs.name) === fqdn &&
          String(rs.type).toUpperCase() === type
      );
      if (found) return found;
    } catch {
      // 容错
    }

    return null;
  }

  /**
   * 把面板传入的写参数转为华为云 Recordset 请求体
   *
   * NOTE: 华为云要求记录名是**带尾点的完整域名**，值里 CNAME/MX/NS/SRV/PTR 类目标
   * 也必须带尾点。MX / SRV 的优先级写在值前缀（与阿里云一致）。
   * 面板传进来的 name 是相对名（路由层 normalizeDnsRecordName 产出），这里补全。
   * 公网域名的 TTL 合法范围为 300 ~ 2147483647，小于 300 一律安全兜底为 300。
   */
  private buildRecordSetPayload(params: {
    zoneId: string;
    zoneName: string;
    type: string;
    name: string;
    content: string;
    ttl?: number;
    priority?: number;
    line?: string;
  }): Record<string, unknown> {
    const type = String(params.type || "").trim().toUpperCase();
    const zone = stripTrailingDot(params.zoneName);
    const rawName = String(params.name || "").trim().replace(/\.+$/, "");
    const fqdn = !rawName || rawName === "@" ? zone : rawName.toLowerCase().endsWith(`.${zone}`) ? rawName.toLowerCase() : `${rawName.toLowerCase()}.${zone}`;

    const content = formatHuaweiRecordContent(type, params.content, params.priority);
    const safeTtl = Number(params.ttl) >= 300 ? Number(params.ttl) : 300;

    const payload: Record<string, unknown> = {
      name: `${fqdn}.`,
      type,
      ttl: safeTtl,
      records: [content],
    };
    if (params.line && !isHuaweiDefaultLine(params.line)) {
      payload.line = params.line;
    }

    return payload;
  }

  /**
   * 创建 DNS 解析记录
   *
   * NOTE: 华为云的 CreateRecordSet 对「同名同类型已存在」会返回 409。
   * 这里捕获冲突并自动调用 PUT 并入现有的 Recordset，真正符合 RRset 模型的自然语义。
   */
  async createDnsRecord(params: {
    zoneId: string;
    zoneName: string;
    type: string;
    name: string;
    content: string;
    ttl?: number;
    priority?: number;
    line?: string;
    record_id?: string | number;
  }): Promise<CreateDnsRecordResponse> {
    const payload = this.buildRecordSetPayload(params);
    try {
      const res = await this.request<HuaweiRecordSet>(
        "POST",
        `/v2/zones/${encodeURIComponent(params.zoneId)}/recordsets`,
        { body: payload }
      );
      return {
        success: true,
        record: res?.id
          ? {
              id: res.id,
              name: stripTrailingDot(res.name),
              type: String(res.type || params.type).toUpperCase(),
              content: params.content,
              ttl: Number(res.ttl) >= 300 ? Number(res.ttl) : (Number(params.ttl) >= 300 ? Number(params.ttl) : 300),
              priority: null,
              line: params.line || null,
              proxied: false,
            }
          : undefined,
      };
    } catch (e: unknown) {
      const errObj = e as any;
      const isConflict =
        (e instanceof HuaweiApiError || (e && typeof e === "object" && ("httpStatus" in errObj || "code" in errObj))) &&
        (errObj.httpStatus === 409 ||
          errObj.code === "DNS.0304" ||
          errObj.code === "DNS.0312" ||
          /record\s*set.*exist/i.test(errObj.rawMessage || errObj.message || "") ||
          /conflict/i.test(errObj.rawMessage || errObj.message || ""));

      if (!isConflict) {
        throw e;
      }

      // 409/400 冲突：同名同类型 RecordSet 已存在，自动并入
      // 华为云主从同步延迟兜底：阶梯重试检索已有记录集（300ms, 800ms, 1500ms）
      let existing = await this.findRecordSet(params);
      const retryDelays = [300, 800, 1500];
      for (const delay of retryDelays) {
        if (existing) break;
        await new Promise((r) => setTimeout(r, delay));
        existing = await this.findRecordSet(params);
      }
      if (!existing) {
        throw e;
      }

      const formattedVal = formatHuaweiRecordContent(params.type, params.content, params.priority);
      const existingRecords = Array.isArray(existing.records) ? existing.records : [];

      // 若已经包含该记录值，直接幂等返回成功
      if (existingRecords.includes(formattedVal)) {
        const valIdx = existingRecords.indexOf(formattedVal);
        return {
          success: true,
          record: {
            id: existingRecords.length > 1 ? `${existing.id}#${valIdx}` : existing.id,
            name: stripTrailingDot(existing.name),
            type: String(existing.type).toUpperCase(),
            content: params.content,
            ttl: Number(existing.ttl) >= 300 ? Number(existing.ttl) : (Number(params.ttl) >= 300 ? Number(params.ttl) : 300),
            priority: null,
            line: existing.line || null,
            proxied: false,
          },
        };
      }

      // 华为云单个 RecordSet 限制最多 20 条记录值
      if (existingRecords.length >= 20) {
        throw new Error("华为云单个记录集最多包含 20 个记录值，已达上限");
      }

      // Set 去重，彻底防止 DNS.0308 重复值错误
      const updatedRecords = Array.from(new Set([...existingRecords, formattedVal]));
      const safeTtl = Number(params.ttl) >= 300 ? Number(params.ttl) : (Number(existing.ttl) >= 300 ? Number(existing.ttl) : 300);
      // NOTE: 华为云 UpdateRecordSet API（PUT /v2/zones/{zone_id}/recordsets/{recordset_id}）
      // 官方规范 Body 仅接收 records / ttl / description。严禁下发 name / type / line，
      // 否则华为云网关会触发唯一性校验判定同名冲突，返回 409 DNS.0304！
      const putBody: Record<string, unknown> = {
        records: updatedRecords,
        ttl: safeTtl,
      };

      await this.request(
        "PUT",
        `/v2/zones/${encodeURIComponent(params.zoneId)}/recordsets/${encodeURIComponent(existing.id)}`,
        { body: putBody }
      );

      return {
        success: true,
        record: {
          id: `${existing.id}#${updatedRecords.length - 1}`,
          name: stripTrailingDot(existing.name),
          type: String(existing.type).toUpperCase(),
          content: params.content,
          ttl: safeTtl,
          priority: null,
          line: existing.line || null,
          proxied: false,
        },
      };
    }
  }

  /**
   * 批量创建/合并 DNS 解析记录
   *
   * 按 (name, type, line) 自动分组聚合，针对同组多值一次性提交，大幅减少 API 请求并避免冲突。
   */
  async batchCreateDnsRecords(params: {
    zoneId: string;
    zoneName: string;
    items: Array<{
      type: string;
      name: string;
      content: string;
      ttl?: number;
      priority?: number;
      line?: string;
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
        line?: string;
        ttl: number;
        items: GroupItem[];
      }
    >();

    for (const item of params.items) {
      const type = String(item.type || "").trim().toUpperCase();
      const rawName = String(item.name ?? "").trim();
      const line = item.line && item.line !== "default" ? item.line : undefined;
      const ttl = Number(item.ttl) >= 300 ? Number(item.ttl) : 300;
      const formattedVal = formatHuaweiRecordContent(type, item.content, item.priority);

      const groupKey = `${type}:::${rawName}:::${line || ""}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          name: rawName,
          type,
          line,
          ttl,
          items: [],
        });
      }
      groups.get(groupKey)!.items.push({ raw: item, formattedVal });
    }

    for (const group of groups.values()) {
      try {
        const existing = await this.findRecordSet({
          zoneId: params.zoneId,
          zoneName: params.zoneName,
          type: group.type,
          name: group.name,
          line: group.line,
        });

        if (!existing) {
          // 不存在该 RecordSet：一次性 POST 创建该组全部记录
          const uniqueValues: string[] = [];
          for (const it of group.items) {
            if (!uniqueValues.includes(it.formattedVal)) {
              uniqueValues.push(it.formattedVal);
            }
          }

          const zone = stripTrailingDot(params.zoneName);
          const rawName = group.name.replace(/\.+$/, "");
          const fqdn = !rawName || rawName === "@" ? zone : rawName.toLowerCase().endsWith(`.${zone}`) ? rawName.toLowerCase() : `${rawName.toLowerCase()}.${zone}`;

          const toAdd = uniqueValues.slice(0, 20);
          const payload: Record<string, unknown> = {
            name: `${fqdn}.`,
            type: group.type,
            ttl: group.ttl,
            records: toAdd,
          };
          if (group.line) payload.line = group.line;

          await this.request("POST", `/v2/zones/${encodeURIComponent(params.zoneId)}/recordsets`, { body: payload });

          for (const it of group.items) {
            const label = `${it.raw.type || "?"} ${it.raw.name} → ${it.raw.content || "(空)"}`;
            if (toAdd.includes(it.formattedVal)) {
              successCount++;
              results.push({ label, success: true, message: "创建成功" });
            } else {
              failCount++;
              results.push({ label, success: false, message: "华为云单个记录集最多包含 20 个记录值，超出上限" });
            }
          }
        } else {
          // 已存在 RecordSet：合并现有值与待添加的值
          const existingRecords = Array.isArray(existing.records) ? [...existing.records] : [];
          const newToAdd: string[] = [];

          for (const it of group.items) {
            if (!existingRecords.includes(it.formattedVal) && !newToAdd.includes(it.formattedVal)) {
              newToAdd.push(it.formattedVal);
            }
          }

          const combined = [...existingRecords];
          const acceptedNewValues = new Set<string>();

          for (const val of newToAdd) {
            if (combined.length < 20) {
              combined.push(val);
              acceptedNewValues.add(val);
            }
          }

          if (acceptedNewValues.size > 0) {
            await this.request(
              "PUT",
              `/v2/zones/${encodeURIComponent(params.zoneId)}/recordsets/${encodeURIComponent(existing.id)}`,
              {
                body: {
                  ttl: group.ttl || Number(existing.ttl) || 300,
                  records: combined,
                },
              }
            );
          }

          for (const it of group.items) {
            const label = `${it.raw.type || "?"} ${it.raw.name} → ${it.raw.content || "(空)"}`;
            if (existingRecords.includes(it.formattedVal)) {
              successCount++;
              results.push({ label, success: true, message: "记录已存在（已自动合并）" });
            } else if (acceptedNewValues.has(it.formattedVal)) {
              successCount++;
              results.push({ label, success: true, message: "已并入现有记录集" });
            } else {
              failCount++;
              results.push({ label, success: false, message: "华为云单个记录集最多包含 20 个记录值，超出上限" });
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
   * 完整保留同条 Recordset 内的其他值，避免覆盖抹除。
   */
  async updateDnsRecord(params: {
    zoneId: string;
    zoneName: string;
    record_id: string | number;
    type: string;
    name: string;
    content: string;
    originContent?: string;
    ttl?: number;
    priority?: number;
    line?: string;
  }): Promise<ActionResponse> {
    const rawId = String(params.record_id);
    const [recordSetId, idxStr] = rawId.split("#");
    const targetIdx = idxStr !== undefined && idxStr !== "" ? parseInt(idxStr, 10) : -1;

    const existing = await this.getRecordSetById(params.zoneId, recordSetId);
    if (!existing) {
      throw new Error("未在上游找到该解析记录（可能已被删除），请刷新记录列表后重试");
    }

    const type = String(params.type || existing.type || "").trim().toUpperCase();
    const zone = stripTrailingDot(params.zoneName);
    const rawName = String(params.name || "").trim().replace(/\.+$/, "");
    const targetFqdn = !rawName || rawName === "@"
      ? `${zone}.`
      : rawName.toLowerCase().endsWith(`.${zone}`)
      ? `${rawName.toLowerCase()}.`
      : `${rawName.toLowerCase()}.${zone}.`;

    const existingFqdn = existing.name.toLowerCase();
    const nameChanged = targetFqdn.toLowerCase() !== existingFqdn;
    const typeChanged = existing.type.toUpperCase() !== type;
    const existingLine = existing.line || "default";
    const targetLine = params.line && params.line !== "default" ? params.line : "default";
    const lineChanged = existingLine !== targetLine;

    // 当主机记录 (name)、类型 (type) 或解析线路 (line) 改变时，属于 RecordSet 跨归属迁移
    if (nameChanged || typeChanged || lineChanged) {
      // 1. 事务安全铁律：先加后删（Add-Before-Delete）
      // 先将新记录安全并入目标 (name, type, line) 下，自动处理已有合并与去重
      // 若目标添加失败（例如超限 20 条、上游校验报错等），在此处抛出异常并中断，原记录完好无损！
      const safeTtl = Number(params.ttl) >= 300 ? Number(params.ttl) : (Number(existing.ttl) >= 300 ? Number(existing.ttl) : 300);
      const createRes = await this.createDnsRecord({
        zoneId: params.zoneId,
        zoneName: params.zoneName,
        type,
        name: params.name,
        content: params.content,
        ttl: safeTtl,
        priority: params.priority,
        line: params.line,
      });

      // 2. 目标确认添加/合并成功后，再从原 RecordSet 中剥离旧值或删除旧记录
      try {
        const existingRecords = Array.isArray(existing.records) ? [...existing.records] : [];
        if (existingRecords.length > 1) {
          // 优先按记录值内容比对匹配要移除的项，防止批量连续修改时下标漂移（Index Drift）
          const valToFind = formatHuaweiRecordContent(existing.type, params.originContent || params.content, params.priority);
          let removeIdx = existingRecords.indexOf(valToFind);
          if (removeIdx === -1 && targetIdx >= 0 && targetIdx < existingRecords.length) {
            removeIdx = targetIdx;
          }

          if (removeIdx >= 0 && removeIdx < existingRecords.length) {
            existingRecords.splice(removeIdx, 1);
          }

          if (existingRecords.length > 0) {
            const putOldBody: Record<string, unknown> = {
              ttl: Number(existing.ttl) >= 300 ? Number(existing.ttl) : 300,
              records: existingRecords,
            };
            await this.request("PUT", `/v2/zones/${encodeURIComponent(params.zoneId)}/recordsets/${encodeURIComponent(recordSetId)}`, {
              body: putOldBody,
            });
          } else {
            await this.request("DELETE", `/v2/zones/${encodeURIComponent(params.zoneId)}/recordsets/${encodeURIComponent(recordSetId)}`);
          }
        } else {
          // 原 RecordSet 只有这 1 项或单值，直接删除原 RecordSet
          await this.request("DELETE", `/v2/zones/${encodeURIComponent(params.zoneId)}/recordsets/${encodeURIComponent(recordSetId)}`);
        }
      } catch (cleanErr) {
        console.warn("清理华为云原解析记录失败（新记录已成功添加）:", cleanErr);
      }

      return createRes;
    }

    // 主机记录未改变（仅原地修改记录值、TTL 等）
    const formattedVal = formatHuaweiRecordContent(type, params.content, params.priority);
    const safeTtl = Number(params.ttl) >= 300 ? Number(params.ttl) : (Number(existing.ttl) >= 300 ? Number(existing.ttl) : 300);

    if (targetIdx >= 0) {
      // 多值展开的某一行：只替换对应下标的值，去重保留同组其余值
      const records = Array.isArray(existing.records) ? [...existing.records] : [];
      if (targetIdx < records.length) {
        records[targetIdx] = formattedVal;
      } else {
        records.push(formattedVal);
      }
      const uniqueRecords = Array.from(new Set(records));
      const putBody: Record<string, unknown> = {
        ttl: safeTtl,
        records: uniqueRecords,
      };

      await this.request("PUT", `/v2/zones/${encodeURIComponent(params.zoneId)}/recordsets/${encodeURIComponent(recordSetId)}`, {
        body: putBody,
      });
      return { success: true };
    }

    // 单值记录集：直接覆盖（保留原有合法 fqdn 与线路）
    const singlePutBody: Record<string, unknown> = {
      ttl: safeTtl,
      records: [formattedVal],
    };

    await this.request("PUT", `/v2/zones/${encodeURIComponent(params.zoneId)}/recordsets/${encodeURIComponent(recordSetId)}`, {
      body: singlePutBody,
    });
    return { success: true };
  }

  /**
   * 删除 DNS 解析记录
   *
   * NOTE: record_id 若形如 `<uuid>#<idx>` 且 Recordset 包含多个记录值时，只剔除对应下标的值，
   * 剩余值通过 PUT 保留；只有当记录集仅剩最后 1 个值或无下标时才真正发 DELETE。
   */
  async deleteDnsRecord(zoneId: string | number, recordId: string | number): Promise<ActionResponse> {
    const rawId = String(recordId);
    const [recordSetId, idxStr] = rawId.split("#");
    const targetIdx = idxStr !== undefined && idxStr !== "" ? parseInt(idxStr, 10) : -1;

    if (targetIdx >= 0) {
      // 多值展开的某一行：只剔除该行对应的值；若只剩最后 1 个值则直接删整条
      const existing = await this.getRecordSetById(zoneId, recordSetId);
      if (existing && Array.isArray(existing.records) && existing.records.length > 1) {
        const records = [...existing.records];
        if (targetIdx < records.length) {
          records.splice(targetIdx, 1);
          const putRemainBody: Record<string, unknown> = {
            ttl: Number(existing.ttl) || 300,
            records,
          };
          await this.request("PUT", `/v2/zones/${encodeURIComponent(String(zoneId))}/recordsets/${encodeURIComponent(recordSetId)}`, {
            body: putRemainBody,
          });
          return { success: true };
        }
      }
    }


    // 单值或最后一条值：删除整条 RecordSet
    await this.request(
      "DELETE",
      `/v2/zones/${encodeURIComponent(String(zoneId))}/recordsets/${encodeURIComponent(recordSetId)}`
    );
    return { success: true };
  }
}

/**
 * 把华为云错误码翻译为可操作的中文指引
 *
 * NOTE: 华为云的错误体是 `{"error_code":"DNS.xxxx","error_msg":"..."}`。这里覆盖
 * 实际对接中最常撞上的几类：凭据无效 / 权限不足 / zone 不存在 / 记录冲突。
 */
export function translateHuaweiError(code: string, message: string, httpStatus?: number): string {
  const c = String(code || "");
  const m = String(message || "");

  if (c === "APIGW.0301" || /signature|authentication|unauthorized/i.test(m) || httpStatus === 401) {
    // NOTE: 这一条是最常撞上的失败，但成因不唯一，所以把可排查的几种一次列全 ——
    // 只说「认证失败」会让用户反复去控制台核对 AK/SK，而真实原因可能是站点不符。
    return (
      "华为云认证失败（APIGW.0301）：请核对 AccessKey ID（AK）与 Secret Access Key（SK）是否成对来自同一个华为云「访问密钥」。" +
      "常见原因：① AK/SK 粘贴错位或残缺；② 该密钥已被停用或删除；" +
      "③ 密钥与域名不在同一个站点 —— 华为云中国站与国际站账号相互独立，AK/SK 不能跨站使用；" +
      "④ 服务器时间与标准时间偏差超过 15 分钟，签名时间戳会被网关拒绝。"
    );
  }
  if (httpStatus === 403 || /forbidden|permission|not authorized/i.test(m)) {
    return "华为云权限不足：请确认该 AK/SK 所属 IAM 用户已被授予 DNS FullAccess 策略";
  }
  if (c === "DNS.0201" || /zone.*not.*exist/i.test(m)) {
    return "该域名不在这个华为云账号的云解析中：请检查账号是否正确，或域名尚未添加到公网域名列表";
  }
  if (c === "DNS.0304" || /recordset.*exist/i.test(m) || /conflict/i.test(m)) {
    return "该同名同类型的解析记录已存在（华为云按 Recordset 合并同名同类型）：请改用「修改」把新值并入，或先删除再创建";
  }
  if (c === "DNS.0305" || /recordset.*not.*exist/i.test(m)) {
    return "未在上游找到该解析记录（可能已被删除），请刷新记录列表后重试";
  }
  if (c === "DNS.0307" || /frozen|locked/i.test(m)) {
    return "该域名在华为云云解析中被冻结，请先到华为云控制台处理欠费或违规";
  }
  if (/quota|limit exceeded/i.test(m)) {
    return "华为云云解析记录数量已达配额上限，请提交工单扩容或删除无用记录";
  }

  const detail = m ? `${c || "未知错误"}: ${m}` : c || "未知错误";
  return `华为云 DNS API 错误: ${detail}`;
}

/**
 * 格式化华为云 RecordSet 的单条 record 字符串
 * MX / SRV 带有优先级前缀，CNAME/MX/NS/SRV/PTR 带尾点
 */
export function formatHuaweiRecordContent(type: string, content: string, priority?: number): string {
  const t = String(type || "").trim().toUpperCase();
  let val = String(content || "").trim();
  const pri = Number(priority);
  if ((t === "MX" || t === "SRV") && Number.isFinite(pri) && pri >= 0 && !/^\d+\s+/.test(val)) {
    val = `${pri} ${val}`;
  }
  if (["CNAME", "MX", "NS", "SRV", "PTR"].includes(t) && val && !val.endsWith(".")) {
    val = `${val}.`;
  }
  return val;
}

/**
 * 华为云 API 结构化错误类
 */
export class HuaweiApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number,
    public readonly rawMessage: string
  ) {
    super(message);
    this.name = "HuaweiApiError";
  }
}
