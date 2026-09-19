import { DNSHEClient } from "../dnshe";
import { CloudflareClient } from "../cloudflare";
import { DigitalPlatClient } from "../digitalplat";
import { DnspodClient } from "../dnspod";
import { AlidnsClient } from "../alidns";
import { HuaweiCloudClient } from "../huaweicloud";
import { VercelClient } from "../vercel";

// ===== 核心类型 =====

/** 绑定账号的提供商（custom = 无 API 的社区公益域名，手动录入域名+到期时间） */
export type AccountProvider =
  | "dnshe"
  | "cloudflare"
  | "digitalplat"
  | "dnspod"
  | "alidns"
  | "huaweicloud"
  | "vercel"
  | "custom";

/**
 * 上游 API 客户端联合类型
 *
 * NOTE: 四个新托管商的客户端与 DNSHE / Cloudflare / DigitalPlat 实现同一套
 * listDnsRecords / createDnsRecord / updateDnsRecord / deleteDnsRecord 签名，
 * 路由层按 `instanceof` 分发后再调用，联合类型让 TS 能逐分支收窄。
 */
export type UpstreamClient =
  | DNSHEClient
  | CloudflareClient
  | DigitalPlatClient
  | DnspodClient
  | AlidnsClient
  | HuaweiCloudClient
  | VercelClient;

/** 鉴权配置（读取后的解密/明文形态） */
export interface AuthConfig {
  username: string;
  passHash: string;
  passSalt: string;
  twoFaEnabled: boolean;
  twoFaSecret: string; // 已解密的 TOTP 密钥（Base32），未开启则为空
  initialized: boolean; // 是否已完成首次密码设置
}

export interface DBAccount {
  id: number;
  alias: string;
  api_key: string;
  provider: AccountProvider;
  created_at: string;
  /** 官网链接（仅自定义服务商分组使用，NULL=未填写） */
  website?: string | null;
}

export interface DBDomain {
  id: number;
  account_id: number;
  account_alias?: string;
  subdomain: string;
  rootdomain: string;
  full_domain: string;
  status: string;
  created_at?: string;
  expires_at: string;
  last_renewed_at: string | null;
  has_dns?: number;
  dns_provider?: string | null;
  /** 解析服务商账号 ID，用于判断该域名是否支持按线路解析（见 dnshe.ts 的字段注释） */
  provider_account_id?: string | null;
  /** 上游对象 ID：Cloudflare 行存 zone id；DNSHE 行为空，主键 id 即 subdomain_id */
  remote_id?: string | null;
  updated_at: string;
}

export interface DBLog {
  id: number;
  type: string;
  category: string;
  message: string;
  details: string | null;
  created_at: string;
}

/**
 * 写入 domains_cache 的上游域名数据
 *
 * NOTE: dns_state_known 表示本次调用已经拉取过该域名的真实解析记录，
 * 因此 status / has_dns / dns_provider 可信、允许覆盖数据库中的旧值。
 * 由 dns-provider.ts 的 computeDnsState() 统一产出，不要手工拼装。
 */
export interface UpstreamSubdomain {
  id: number;
  subdomain: string;
  rootdomain: string;
  full_domain: string;
  status: string;
  created_at?: string;
  expires_at?: string;
  disable_ns_management?: boolean | number;
  has_dns?: boolean | number;
  ns1?: string;
  ns2?: string;
  dns_provider?: string;
  provider_account_id?: number | string | null;
  /** Cloudflare 行携带 zone id；DNSHE 行留空 */
  remote_id?: string | null;
  dns_state_known?: boolean;
}

/** 配额缓存中的单个账号条目：成功时展开 quota 字段，失败时带 error */
export type QuotaEntry = { account_id: number; alias: string; [key: string]: unknown };

// ===== 常量 =====

/**
 * 无需 DNSHE 式配额概念的 provider 集合
 *
 * WHY 单独抽成常量：这个判断散落在 fetchAllQuotas、refreshAccountQuotaCache、
 * getDomains 的 SQL 过滤、/api/whois 的账号查找四处，靠人肉同步极易改漏
 * （新增托管商时漏一处就会出现「配额页报错」或「DNSHE 列表混入别的托管商域名」）。
 */
export const NON_QUOTA_PROVIDERS: readonly AccountProvider[] = [
  "cloudflare",
  "digitalplat",
  "dnspod",
  "alidns",
  "huaweicloud",
  "vercel",
  "custom",
];

/**
 * 数据导入/导出的快照格式版本
 *
 * NOTE: 导入时要求**严格相等**。备份格式一旦变更（增删列、改语义），旧文件必须被明确
 * 拒绝而不是「尽力而为地导入」—— 静默地按新格式解读旧数据，是数据损坏最难排查的一类。
 * 改格式时把这个数字加一，并在导入侧补上迁移分支。
 */
export const DATA_EXPORT_VERSION = 1;

/** 全部账号配额的缓存键（内容为按 account_id 升序排列的数组） */
export const QUOTA_CACHE_KEY = "api_cache:quota";

/**
 * RDAP 到期时间查询结果的缓存键前缀（与 index.ts 的 /api/expiry 共用同一命名空间）
 *
 * NOTE: 版本号必须与 index.ts 的 RDAP_CACHE_KEY_PREFIX 保持一致 —— 两边读写的是同一批键，
 * 任何一边改了版本号，另一边的读就会整批落空（那边表现为重复回源、这边表现为永不提醒）。
 */
export const RDAP_CACHE_PREFIX = "rdap:4:";

/** domains_cache.status 允许的三态取值（由 computeDnsState 产出） */
export const THREE_STATE_STATUSES = new Set(["已委派", "已解析", "未解析"]);

/** 双凭据型托管商（需要 AccessKey ID + Secret 两件套，api_key 与 api_secret 都要用） */
export const DUAL_CREDENTIAL_PROVIDERS: readonly AccountProvider[] = ["dnspod", "alidns", "huaweicloud"];

// ===== 纯工具函数 =====

/** 生成 SQL 的 NOT IN 列表（供 getDomains 的 DNSHE 分支复用） */
export function nonDnsheProviderSqlList(): string {
  return NON_QUOTA_PROVIDERS.map((p) => `'${p}'`).join(", ");
}

/**
 * 双凭据型托管商 accounts.api_key 的存储值（唯一键 + 明文展示位 + AccessKey 来源）
 *
 * 🔴 WHY 双凭据型**必须存真实 AccessKey，不能存哈希**：
 * `getClientForAccount` 是全局唯一的凭据出口，双凭据型要拿 `api_key` 当 AccessKey ID
 * 去重建客户端。若像单凭据型（DP/CF/Vercel）那样把哈希存进 `api_key`，绑定后所有上游
 * 请求都会「拿哈希当 AccessKey 签名」→ 恒回认证失败。
 */
export function dualCredentialApiKey(provider: string, accessKeyId: string): string {
  return `${provider}:${accessKeyId}`;
}

/**
 * 从 accounts.api_key 取回真实 AccessKey ID（双凭据型）
 *
 * 兼容两种形态：新格式 `dnspod:AKIDxxx`（带 provider 前缀）原样剥前缀返回；
 * 无前缀的历史值原样返回（避免把真实凭据误伤成空串）。
 */
export function accessKeyIdFromApiKey(apiKey: string): string {
  const value = String(apiKey || "");
  const idx = value.indexOf(":");
  if (idx > 0 && DUAL_CREDENTIAL_PROVIDERS.includes(value.slice(0, idx) as AccountProvider)) {
    return value.slice(idx + 1);
  }
  return value;
}

/**
 * 判断 accounts.api_key 是否是「旧版双凭据存储格式」（`provider:` 后接 32 位小写十六进制哈希）
 *
 * WHY：旧版本误把 AccessKey 的 SHA-256 前 32 位当作 `api_key` 存储（真实 AK 被丢弃），
 * 导致这些账号绑定后所有上游请求恒认证失败。修复后新绑定的账号存 `provider:真实AK`，
 * 但旧行无法自动恢复。这里识别旧行，在凭据出口抛出「请解绑后重新绑定」的明确指引。
 */
export function isLegacyHashedDualCredentialKey(apiKey: string): boolean {
  const value = String(apiKey || "");
  const idx = value.indexOf(":");
  if (idx <= 0) return false;
  if (!DUAL_CREDENTIAL_PROVIDERS.includes(value.slice(0, idx) as AccountProvider)) return false;
  return /^[0-9a-f]{32}$/.test(value.slice(idx + 1));
}

/**
 * 归一化自动解析出的 Cloudflare 账号别名
 *
 * NOTE: Cloudflare 给个人账号生成的默认名是「<邮箱>'s Account」，后缀是界面噪音，
 * 自动命名时直接去掉；账号名本身没有该后缀、或剥掉后为空时保持原样。
 */
export function normalizeCfAlias(name: string): string {
  const stripped = String(name || "").replace(/\s*'s\s+account$/i, "").trim();
  return stripped || String(name || "").trim();
}
