import { DNSHEClient } from "../dnshe";
import { CloudflareClient } from "../cloudflare";
import { DigitalPlatClient } from "../digitalplat";
import { DnspodClient, looksLikeTencentSecretId } from "../dnspod";
import { AlidnsClient, looksLikeAliyunAccessKeyId } from "../alidns";
import { HuaweiCloudClient, looksLikeHuaweiAccessKeyId } from "../huaweicloud";
import { VercelClient } from "../vercel";

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

/** 生成 SQL 的 NOT IN 列表（供 getDomains 的 DNSHE 分支复用） */
export function nonDnsheProviderSqlList(): string {
  return NON_QUOTA_PROVIDERS.map((p) => `'${p}'`).join(", ");
}

/**
 * 数据导入/导出的快照格式版本
 *
 * NOTE: 导入时要求**严格相等**。备份格式一旦变更（增删列、改语义），旧文件必须被明确
 * 拒绝而不是「尽力而为地导入」—— 静默地按新格式解读旧数据，是数据损坏最难排查的一类。
 * 改格式时把这个数字加一，并在导入侧补上迁移分支。
 */
export const DATA_EXPORT_VERSION = 1;

/**
 * 归一化自动解析出的 Cloudflare 账号别名
 *
 * NOTE: Cloudflare 给个人账号生成的默认名是「<邮箱>'s Account」，后缀是界面噪音，
 * 自动命名时直接去掉（如 Lioil@nmail.art's Account → Lioil@nmail.art）；
 * 账号名本身没有该后缀、或剥掉后为空时保持原样。用户显式填写的别名不经过这里。
 */
function normalizeCfAlias(name: string): string {
  const stripped = String(name || "").replace(/\s*'s\s+account$/i, "").trim();
  return stripped || String(name || "").trim();
}

/**
 * 导入 Crypto 工具以处理 AES 加密
 * 
 * NOTE: 使用 SHA-256 将任意长度的密钥材料派生为 256 位 AES-GCM 密钥
 */
async function getCryptoKey(aesKeyStr: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(aesKeyStr);
  const hash = await crypto.subtle.digest("SHA-256", keyData);
  return await crypto.subtle.importKey(
    "raw",
    hash,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * AES-GCM 加密文本
 * 
 * NOTE: 当 aesKeyStr 存在但加密失败时，抛出异常而非静默降级为 Base64。
 * 仅在 aesKeyStr 本身为空时允许使用 Base64 弱编码作为降级方案。
 */
export async function encryptText(text: string, aesKeyStr?: string): Promise<string> {
  if (!aesKeyStr) {
    return "plain:" + btoa(text);
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await getCryptoKey(aesKeyStr);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    data
  );
  
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, "0")).join("");
  const encryptedHex = Array.from(new Uint8Array(encrypted)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${ivHex}:${encryptedHex}`;
}

/**
 * AES-GCM 解密文本
 */
export async function decryptText(encryptedText: string, aesKeyStr?: string): Promise<string> {
  if (encryptedText.startsWith("plain:")) {
    return atob(encryptedText.substring(6));
  }
  if (!aesKeyStr) {
    throw new Error("Encrypted secret requires AES_KEY to decrypt");
  }

  const parts = encryptedText.split(":");
  if (parts.length !== 2) {
    throw new Error("Invalid cipher format");
  }
  const ivHex = parts[0];
  const encryptedHex = parts[1];
  
  const iv = new Uint8Array(ivHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  const encrypted = new Uint8Array(encryptedHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  
  const cryptoKey = await getCryptoKey(aesKeyStr);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encrypted
  );
  
  return new TextDecoder().decode(decrypted);
}

/**
 * 使用 PBKDF2-HMAC-SHA256 派生密码哈希（10 万轮）
 *
 * NOTE: 返回十六进制的 32 字节派生密钥。盐值由调用方生成并单独存储，
 * 校验时使用相同盐值重新派生并做恒定时间比较，避免时序侧信道。
 */
export async function hashPassword(password: string, saltHex: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = new Uint8Array(saltHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(derived))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 生成 16 字节随机盐值的十六进制字符串
 */
export function generateSalt(): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(salt).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 恒定时间字符串比较，防止基于响应耗时的时序攻击
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * 计算 SHA-256 十六进制摘要
 *
 * NOTE: 会话 token 落库前先哈希再存 —— 即使 D1 被读出，
 *       攻击者也拿不到可用于重放在线会话的原始 token。
 */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 双凭据型托管商（需要 AccessKey ID + Secret 两件套，api_key 与 api_secret 都要用） */
const DUAL_CREDENTIAL_PROVIDERS: readonly AccountProvider[] = ["dnspod", "alidns", "huaweicloud"];

/**
 * 双凭据型托管商 accounts.api_key 的存储值（唯一键 + 明文展示位 + AccessKey 来源）
 *
 * 🔴 WHY 双凭据型**必须存真实 AccessKey，不能存哈希**：
 * `getClientForAccount` 是全局唯一的凭据出口，双凭据型要拿 `api_key` 当 AccessKey ID
 * 去重建客户端。若像单凭据型（DP/CF/Vercel）那样把哈希存进 `api_key`，绑定后所有上游
 * 请求都会「拿哈希当 AccessKey 签名」→ 恒回认证失败，**症状是「能绑定成功，但之后
 * 什么都用不了」**（华为云是 APIGW.0301，DNSPod / 阿里云是各自的签名错误）。
 *
 * 唯一性由 AccessKey 本身保证（同一密钥对重复绑定应被 UNIQUE 拒绝），所以存明文即可
 * 同时满足「唯一」与「可重建客户端」。`provider:` 前缀用于与 DNSHE（裸 Key）/
 * CF（`cf:`）/ DP（`dp:`）的 id 空间隔离。
 */
function dualCredentialApiKey(provider: string, accessKeyId: string): string {
  return `${provider}:${accessKeyId}`;
}

/**
 * 从 accounts.api_key 取回真实 AccessKey ID（双凭据型）
 *
 * 兼容两种形态：新格式 `dnspod:AKIDxxx`（带 provider 前缀）原样剥前缀返回；
 * 无前缀的历史值原样返回（避免把真实凭据误伤成空串）。
 *
 * NOTE: 与 dualCredentialApiKey 成对导出，供 `test:credentials` 锁定存储格式契约
 * （这个 bug 的本质就是「写入格式」与「读取格式」不一致）。
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
 * WHY：续七首次接入双凭据型托管商时，`addAccount` 误把 AccessKey 的 SHA-256 前 32 位
 * 当作 `api_key` 存储（**真实 AK 被丢弃**），导致这些账号绑定后所有上游请求恒认证失败
 * （华为云 APIGW.0301）。修复后新绑定的账号存 `provider:真实AK`，但**旧行无法自动恢复**
 * —— 哈希不可逆，真实 AK 已永久丢失。这里识别旧行，在凭据出口抛出「请解绑后重新绑定」
 * 的明确指引，而不是让用户对着「认证失败」去反复核对 AK/SK。
 *
 * NOTE: 真实 AccessKey（华为 20 位大写字母数字 / 腾讯 `AKID…` / 阿里 `LTAI…`）
 * 都不会恰好是 32 位小写十六进制，故不会误伤。
 */
function isLegacyHashedDualCredentialKey(apiKey: string): boolean {
  const value = String(apiKey || "");
  const idx = value.indexOf(":");
  if (idx <= 0) return false;
  if (!DUAL_CREDENTIAL_PROVIDERS.includes(value.slice(0, idx) as AccountProvider)) return false;
  return /^[0-9a-f]{32}$/.test(value.slice(idx + 1));
}

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

/** domains_cache.status 允许的三态取值（由 computeDnsState 产出） */
const THREE_STATE_STATUSES = new Set(["已委派", "已解析", "未解析"]);

/** 全部账号配额的缓存键（内容为按 account_id 升序排列的数组） */
export const QUOTA_CACHE_KEY = "api_cache:quota";

/**
 * RDAP 到期时间查询结果的缓存键前缀（与 index.ts 的 /api/expiry 共用同一命名空间）
 *
 * NOTE: 版本号必须与 index.ts 的 RDAP_CACHE_KEY_PREFIX 保持一致 —— 两边读写的是同一批键，
 * 任何一边改了版本号，另一边的读就会整批落空（那边表现为重复回源、这边表现为永不提醒）。
 * 提到模块级导出是为了让定时任务的批量读缓存能复用同一常量，而不是各自硬编码字符串。
 */
export const RDAP_CACHE_PREFIX = "rdap:4:";

/** 配额缓存中的单个账号条目：成功时展开 quota 字段，失败时带 error */
export type QuotaEntry = { account_id: number; alias: string; [key: string]: unknown };

/**
 * 数据库封装操作
 *
 * NOTE: 使用 D1Database 类型替代 any，获得完整的编译期类型检查
 */
export class DatabaseManager {
  private db: D1Database;
  private aesKey?: string;

  constructor(d1Database: D1Database, aesKey?: string) {
    this.db = d1Database;
    this.aesKey = aesKey;
  }

  /**
   * 自动确保所需的 D1 数据库表结构存在
   *
   * 返回是否自举成功。调用方（index.ts 的 ensureSchemaOnce）据此决定
   * 是否缓存结果——失败就不缓存，留给下一次请求重试。
   */
  async ensureTables(): Promise<boolean> {
    try {
      await this.db.batch([
        this.db.prepare(`
          CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alias TEXT NOT NULL,
            api_key TEXT NOT NULL UNIQUE,
            api_secret TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'dnshe',
            website TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `),
        this.db.prepare(`
          CREATE TABLE IF NOT EXISTS domains_cache (
            id INTEGER PRIMARY KEY,
            account_id INTEGER NOT NULL,
            subdomain TEXT NOT NULL,
            rootdomain TEXT NOT NULL,
            full_domain TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT,
            expires_at TEXT NOT NULL,
            last_renewed_at TEXT,
            has_dns INTEGER DEFAULT 1,
            dns_provider TEXT,
            provider_account_id TEXT,
            remote_id TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
          );
        `),
        this.db.prepare(`
          CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            category TEXT NOT NULL,
            message TEXT NOT NULL,
            details TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `),
        this.db.prepare(`
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `),
        this.db.prepare(`
          CREATE TABLE IF NOT EXISTS cache (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            expires_at INTEGER NOT NULL
          );
        `),
        this.db.prepare(`
          CREATE TABLE IF NOT EXISTS domain_date_overrides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            full_domain TEXT NOT NULL,
            registered_at TEXT,
            expires_at TEXT,
            source TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (account_id, full_domain),
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
          );
        `),
        this.db.prepare(`
          CREATE TABLE IF NOT EXISTS custom_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (group_id, name),
            FOREIGN KEY (group_id) REFERENCES accounts(id) ON DELETE CASCADE
          );
        `),
        this.db.prepare(`
          CREATE TABLE IF NOT EXISTS custom_domains (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            account_id INTEGER,
            full_domain TEXT NOT NULL,
            registered_at TEXT,
            expires_at TEXT NOT NULL,
            remark TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (group_id, account_id, full_domain),
            FOREIGN KEY (group_id) REFERENCES accounts(id) ON DELETE CASCADE,
            FOREIGN KEY (account_id) REFERENCES custom_accounts(id) ON DELETE CASCADE
          );
        `),
        this.db.prepare(`
          CREATE TABLE IF NOT EXISTS actions (
            id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0,
            started_at TEXT, finished_at TEXT, error TEXT, metadata TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `),
        this.db.prepare(`
          CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
            resource_type TEXT NOT NULL, resource_id TEXT, provider TEXT, result TEXT NOT NULL,
            details TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `),
        this.db.prepare(`
          CREATE TABLE IF NOT EXISTS scanner_jobs (
            id TEXT PRIMARY KEY, status TEXT NOT NULL, cursor TEXT NOT NULL, total_checked INTEGER NOT NULL DEFAULT 0,
            available INTEGER NOT NULL DEFAULT 0, registered INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
            started_at TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, finished_at TEXT, error TEXT
          );
        `)
      ]);

      // 兼容已部署的旧数据库：仅在缺少字段时执行一次轻量迁移。
      //
      // NOTE: 一次 PRAGMA 取回全部列名后统一补齐，缺几个字段都只多一次批量写，
      // 保持「自举 = 2 次串行往返」这个开销不变（见 README 的性能小节）。
      const domainColumns = await this.db.prepare("PRAGMA table_info(domains_cache)").all<{ name: string }>();
      const existingColumns = new Set((domainColumns.results || []).map((column) => column.name));
      const migrations: string[] = [];
      if (!existingColumns.has("dns_provider")) {
        migrations.push("ALTER TABLE domains_cache ADD COLUMN dns_provider TEXT");
      }
      if (!existingColumns.has("provider_account_id")) {
        migrations.push("ALTER TABLE domains_cache ADD COLUMN provider_account_id TEXT");
      }
      if (!existingColumns.has("remote_id")) {
        migrations.push("ALTER TABLE domains_cache ADD COLUMN remote_id TEXT");
      }
      const accountColumns = await this.db.prepare("PRAGMA table_info(accounts)").all<{ name: string }>();
      const accountColumnNames = new Set((accountColumns.results || []).map((column) => column.name));
      if (!accountColumnNames.has("provider")) {
        migrations.push("ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'dnshe'");
      }
      if (!accountColumnNames.has("website")) {
        migrations.push("ALTER TABLE accounts ADD COLUMN website TEXT");
      }
      const customDomainColumns = await this.db.prepare("PRAGMA table_info(custom_domains)").all<{ name: string }>();
      const customDomainColumnNames = new Set((customDomainColumns.results || []).map((column) => column.name));
      if (!customDomainColumnNames.has("registered_at")) {
        migrations.push("ALTER TABLE custom_domains ADD COLUMN registered_at TEXT");
      }
      if (migrations.length > 0) {
        await this.db.batch(migrations.map((sql) => this.db.prepare(sql)));
      }
      return true;
    } catch (e) {
      console.error("Auto ensureTables error:", e);
      return false;
    }
  }

  /**
   * 获取系统设置/会话配置
   */
  /** Repository escape hatch: parameterized raw queries for new infrastructure tables. */
  async executeRaw(sql: string, bindings: unknown[] = []): Promise<void> {
    await this.db.prepare(sql).bind(...bindings).run();
  }

  async firstRaw<T>(sql: string, bindings: unknown[] = []): Promise<T | null> {
    return (await this.db.prepare(sql).bind(...bindings).first<T>()) || null;
  }

  async allRaw<T>(sql: string, bindings: unknown[] = []): Promise<T[]> {
    const result = await this.db.prepare(sql).bind(...bindings).all<T>();
    return result.results || [];
  }

  async getSetting(key: string): Promise<string | null> {
    try {
      const res = await this.db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value?: unknown }>();
      return res ? String(res.value ?? "") : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 更新或保存系统设置/会话配置
   */
  async deleteSetting(key: string): Promise<void> {
    try { await this.db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run(); } catch (e) { console.error("deleteSetting error:", e); }
  }

  async setSetting(key: string, value: string): Promise<void> {
    try {
      const now = this.getBeijingNow();
      await this.db.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(key, value, now).run();
    } catch (e) {
      console.error("setSetting error:", e);
    }
  }

  /**
   * 批量读取所有以 cfg_ 为前缀的应用配置项，返回去前缀后的键值对象
   *
   * NOTE: 敏感字段（如 Telegram Token）以 AES 加密形式存储，此处返回解密后的原文，
   * 由上层接口决定是否打码后再下发前端。
   */
  async getAllAppSettings(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    try {
      const { results } = await this.db.prepare(
        "SELECT key, value FROM settings WHERE key LIKE 'cfg_%'"
      ).all<{ key: string; value: string }>();
      for (const row of results || []) {
        const shortKey = row.key.replace(/^cfg_/, "");
        let val = row.value;
        // 敏感字段解密
        if ((shortKey === "tg_token" || shortKey === "webhook_url") && val) {
          try {
            val = await decryptText(val, this.aesKey);
          } catch (e) {
            // 解密失败保持原值（可能是历史明文）
          }
        }
        out[shortKey] = val;
      }
    } catch (e) {
      console.error("getAllAppSettings error:", e);
    }
    return out;
  }

  /**
   * 保存单个应用配置项（自动加 cfg_ 前缀，敏感字段自动 AES 加密）
   */
  async setAppSetting(shortKey: string, value: string): Promise<void> {
    let stored = value;
    if ((shortKey === "tg_token" || shortKey === "webhook_url") && value) {
      try {
        stored = await encryptText(value, this.aesKey);
      } catch (e) {
        console.error("setAppSetting encrypt error:", e);
      }
    }
    await this.setSetting(`cfg_${shortKey}`, stored);
  }

  /**
   * 读取缓存值（仅在面板内写操作后失效，长期有效）
   *
   * NOTE: 此缓存模型为"写操作回源回填，读操作仅命中缓存"：
   * 只有面板内的增删改会删除/重填缓存，缓存本身不过期。
   * 为避免历史/意外长期占用，仍写入一个较远的绝对过期时间作为兜底。
   */
  async getCache(key: string): Promise<string | null> {
    try {
      const row = await this.db.prepare(
        "SELECT value FROM cache WHERE key = ? AND expires_at > ?"
      ).bind(key, Math.floor(Date.now() / 1000)).first<{ value: string }>();
      return row ? row.value : null;
    } catch (e) {
      console.error("getCache error:", e);
      return null;
    }
  }

  /**
   * 写入缓存（默认 1 年后过期，作为极端兜底；正常由写操作主动失效/重填）
   *
   * @param ttlSeconds 可选的自定义存活秒数。查重池等需要主动过期的场景传入较短 TTL
   *                   （如 7 天），以便结论到期后自动重新验证。
   */
  async setCache(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      // 默认 366 天的绝对过期时间，保证"不过期"语义的同时不会永久占用 D1 存储
      const ttl = ttlSeconds && ttlSeconds > 0 ? ttlSeconds : 366 * 24 * 3600;
      const expiresAt = Math.floor(Date.now() / 1000) + ttl;
      await this.db.prepare(
        "INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at"
      ).bind(key, value, expiresAt).run();
    } catch (e) {
      console.error("setCache error:", e);
    }
  }

  /**
   * 批量查询查重池：返回其中「已确认已注册且尚未过期」的域名集合。
   *
   * 池子只缓存"已注册"这一相对稳定的结论（未注册域名随时可能被抢注，缓存无意义），
   * 并带 7 天 TTL，以覆盖"他人续费释放 / 用户主动删除后重新可注册"的场景。
   */
  async getWhoisPool(domains: string[]): Promise<string[]> {
    if (domains.length === 0) return [];

    // ⚠️ D1 硬上限：每条查询最多 100 个绑定参数（不是 SQLite 默认的 999）。
    // 早期实现用 IN (?,?,...) 逐个绑定域名，批量规模下必然超限并抛
    // "too many SQL variables"，异常又被吞掉 => 池子长期静默失效、白跑往返。
    //
    // 域名在入口处已统一经 toASCII() 归一化（必为小写纯 ASCII），
    // 这里再做一次严格白名单校验后内联为字面量，绑定参数恒定为 1 个。
    // 字符集限定 [a-z0-9.-] 不含引号/反斜杠，不存在注入面。
    const safe = domains.filter(d => /^[a-z0-9][a-z0-9.-]{0,252}$/.test(d));
    if (safe.length === 0) return [];

    const now = Math.floor(Date.now() / 1000);
    const hits: string[] = [];
    // D1 单条 SQL 语句上限 100KB；400 个域名内联后约 14KB，留足余量
    const STMT_CHUNK = 400;

    for (let i = 0; i < safe.length; i += STMT_CHUNK) {
      const list = safe
        .slice(i, i + STMT_CHUNK)
        .map(d => `'whois_pool:${d}'`)
        .join(",");
      const rows = await this.db.prepare(
        `SELECT key FROM cache WHERE key IN (${list}) AND expires_at > ?`
      ).bind(now).all<{ key: string }>();
      for (const r of rows.results || []) {
        hits.push(r.key.replace(/^whois_pool:/, ""));
      }
    }

    return hits;
  }

  /**
   * 批量读取一批域名的解析记录缓存（单条 SQL，避免逐域名 getCache 往返）
   *
   * NOTE: 与 getWhoisPool 同样的两条硬约束 ——
   *   1. D1 每条 SQL 最多 100 个绑定参数（不是 SQLite 默认的 999），所以 key 必须内联
   *      成字面量、绑定参数只留「当前时间」这一个；
   *   2. 域名 id 在入口处已过滤为纯数字，内联无注入面。
   *
   * 返回 Map<subdomain_id, records 数组>；缓存缺失或内容损坏的域名不出现在结果里，
   * 由调用方决定怎么补（见 cron.ts 的 DNSHE 同步分支）。
   */
  async getDnsRecordsCacheBatch(ids: number[]): Promise<Map<number, unknown[]>> {
    const result = new Map<number, unknown[]>();
    const valid = ids.filter((id) => Number.isSafeInteger(id) && id >= 0);
    if (valid.length === 0) return result;

    const now = Math.floor(Date.now() / 1000);
    // 单条 SQL 上限 100KB；每行 key 约 24 字节，400 行内联后约 10KB，留足余量
    const STMT_CHUNK = 400;

    for (let i = 0; i < valid.length; i += STMT_CHUNK) {
      const list = valid.slice(i, i + STMT_CHUNK).map((id) => `'api_cache:dns:${id}'`).join(",");
      const rows = await this.db
        .prepare(`SELECT key, value FROM cache WHERE key IN (${list}) AND expires_at > ?`)
        .bind(now)
        .all<{ key: string; value: string }>();
      for (const row of rows.results || []) {
        const id = Number(String(row.key).replace(/^api_cache:dns:/, ""));
        if (!Number.isFinite(id)) continue;
        try {
          const parsed = JSON.parse(String(row.value));
          if (Array.isArray(parsed)) result.set(id, parsed);
        } catch {
          // 缓存内容损坏时跳过，调用方会为它回源重拉并覆盖
        }
      }
    }
    return result;
  }

  /**
   * 清理已过期的缓存行（含查重池），避免 cache 表只进不出无限膨胀
   *
   * @returns 被删除的行数
   */
  async purgeExpiredCache(): Promise<number> {
    try {
      const res = await this.db.prepare(
        "DELETE FROM cache WHERE expires_at <= ?"
      ).bind(Math.floor(Date.now() / 1000)).run();
      return res.meta?.changes ?? 0;
    } catch (e) {
      console.error("purgeExpiredCache error:", e);
      return 0;
    }
  }

  /**
   * 将一个已确认「已注册」的域名写入查重池（默认 7 天后自动失效需重新验证）
   */
  async addToWhoisPool(domain: string, ttlSeconds = 7 * 24 * 3600): Promise<void> {
    await this.setCache(
      `whois_pool:${domain}`,
      JSON.stringify({ registered: true, ts: Math.floor(Date.now() / 1000) }),
      ttlSeconds
    );
  }

  /**
   * 删除指定缓存（写操作后调用，强制下一次读取回源刷新）
   */
  async deleteCache(key: string): Promise<void> {
    try {
      await this.db.prepare("DELETE FROM cache WHERE key = ?").bind(key).run();
    } catch (e) {
      console.error("deleteCache error:", e);
    }
  }

  // ===== 配额缓存的按账号维护 =====
  //
  // NOTE: 配额缓存走的是「写操作回源回填、读操作只命中缓存」模型，TTL 长达 366 天。
  // 但账号的增删改会改变账号集合，这份缓存却一直没跟着变，于是「账户配额」页
  // 依然列着已解绑的账号、也看不到新绑定的账号，只能点「刷新」强制回源才对得上。
  // 下面三个方法按账号粒度打补丁：解绑与改名零上游调用，只有新绑定/换 Key 才拉一次配额。
  // 缓存本就不存在时一律直接跳过 —— 下一次读取会整体回源重建。

  /** 读取配额缓存数组；缓存不存在或内容损坏时返回 null */
  private async readQuotaCache(): Promise<QuotaEntry[] | null> {
    const cached = await this.getCache(QUOTA_CACHE_KEY);
    if (!cached) return null;
    try {
      const parsed = JSON.parse(cached);
      return Array.isArray(parsed) ? (parsed as QuotaEntry[]) : null;
    } catch (e) {
      return null;
    }
  }

  /** 写回配额缓存，并保持与 getAccounts() 相同的 id ASC 顺序（配额页按数组顺序渲染） */
  private async writeQuotaCache(entries: QuotaEntry[]): Promise<void> {
    const sorted = [...entries].sort((a, b) => Number(a.account_id) - Number(b.account_id));
    await this.setCache(QUOTA_CACHE_KEY, JSON.stringify(sorted));
  }

  /** 解绑账号：摘掉对应条目 */
  async removeAccountFromQuotaCache(accountId: number): Promise<void> {
    const cached = await this.readQuotaCache();
    if (cached === null) return;
    await this.writeQuotaCache(cached.filter((q) => Number(q.account_id) !== accountId));
  }

  /** 仅改别名：就地改写缓存里的别名 */
  async renameAccountInQuotaCache(accountId: number, alias: string): Promise<void> {
    const cached = await this.readQuotaCache();
    if (cached === null) return;
    if (!cached.some((q) => Number(q.account_id) === accountId)) return;
    await this.writeQuotaCache(
      cached.map((q) => (Number(q.account_id) === accountId ? { ...q, alias } : q))
    );
  }

  /** 新绑定 / 换 Key：拉一次该账号的配额写回缓存，只影响这一个账号（非 DNSHE 托管商无 DNSHE 式配额概念，直接清掉缓存条目） */
  async refreshAccountQuotaCache(accountId: number, alias: string, provider: AccountProvider = "dnshe"): Promise<void> {
    const cached = await this.readQuotaCache();
    if (cached === null) return;

    if (NON_QUOTA_PROVIDERS.includes(provider)) {
      await this.writeQuotaCache(cached.filter((q) => Number(q.account_id) !== accountId));
      return;
    }

    let entry: QuotaEntry;
    try {
      const { client } = await this.getClientForAccount(accountId);
      if (!(client instanceof DNSHEClient)) {
        await this.writeQuotaCache(cached.filter((q) => Number(q.account_id) !== accountId));
        return;
      }
      const qRes = await client.getQuota();
      entry = qRes && qRes.success
        ? { account_id: accountId, alias, ...qRes.quota }
        : { account_id: accountId, alias, error: qRes?.message || "获取额度失败" };
    } catch (e: unknown) {
      entry = { account_id: accountId, alias, error: e instanceof Error ? e.message : "获取额度失败" };
    }

    await this.writeQuotaCache([...cached.filter((q) => Number(q.account_id) !== accountId), entry]);
  }

  // ===== 会话 (Session) 管理 =====
  //
  // 会话以 settings 表中 key = `sess_<digest>` 的行表示（digest 是 token 的 SHA-256），
  // value 存放到期时间的 Unix 秒级时间戳（字符串形式）。原始 token 服务端不落库，
  // 因此拿到数据库文件也无法重放在线会话。
  //
  // NOTE: 历史版本把原始 token 直接当 key、value 固定写成 "valid" 且从不删除，于是
  //       这张表随每次登录只进不出，而鉴权中间件每个请求都要查它。那些旧行在此
  //       版本不再被 validateSession() 接受（键是原始 token，哈希后查不到），会在
  //       purgeExpiredSessions() 里按 updated_at 超过 TTL 后一并清掉，自然排空；
  //       升级部署后所有旧会话需要重新登录一次。

  /** 会话有效期：7 天 */
  static readonly SESSION_TTL_SECONDS = 7 * 24 * 3600;

  /** Session Token 前缀（鉴权中间件据此区分会话 token 与应急令牌） */
  static readonly SESSION_PREFIX = "dh_sess_";

  /**
   * 签发一个新会话，返回 Session Token
   *
   * NOTE: 库里只保存 token 的 SHA-256 摘要（key = `sess_<digest>`），
   * 原始 token 只在签发时返回给客户端一次，服务端无法反推。
   */
  async createSession(ttlSeconds = DatabaseManager.SESSION_TTL_SECONDS): Promise<string> {
    const token = `${DatabaseManager.SESSION_PREFIX}${crypto.randomUUID()}`;
    const digest = await sha256Hex(token);
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    await this.setSetting(`sess_${digest}`, String(expiresAt));
    return token;
  }

  /**
   * 校验会话是否有效（存在且未过期）
   *
   * NOTE: 只认哈希后的键。历史版本以原始 token 直接做 settings key 且值写死
   * "valid" 的行在此不再放行 —— 它们会在 cron 的 purgeExpiredSessions() 里被回收，
   * 升级后所有旧会话需要重新登录一次。
   */
  async validateSession(token: string): Promise<boolean> {
    if (!token.startsWith(DatabaseManager.SESSION_PREFIX)) return false;
    const digest = await sha256Hex(token);
    const stored = await this.getSetting(`sess_${digest}`);
    if (!stored) return false;
    const expiresAt = Number(stored);
    return Number.isFinite(expiresAt) && expiresAt > Math.floor(Date.now() / 1000);
  }

  /**
   * 注销会话（登出时删除对应的哈希行，使已签发的 token 立即失效）
   */
  async revokeSession(token: string): Promise<void> {
    if (!token || !token.startsWith(DatabaseManager.SESSION_PREFIX)) return;
    try {
      const digest = await sha256Hex(token);
      await this.db.prepare("DELETE FROM settings WHERE key = ?").bind(`sess_${digest}`).run();
    } catch (e) {
      console.error("revokeSession error:", e);
    }
  }

  /**
   * 清理已过期会话 — 供每日 cron 调用，返回清理条数
   */
  async purgeExpiredSessions(ttlSeconds = DatabaseManager.SESSION_TTL_SECONDS): Promise<number> {
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      // 1) 新格式：value 是到期时间戳，直接按数值比较
      const expired = await this.db.prepare(
        "DELETE FROM settings WHERE key LIKE 'sess_%' AND value != 'valid' AND CAST(value AS INTEGER) <= ?"
      ).bind(nowSec).run();

      // 2) 历史遗留格式：value = 'valid' 没有到期时间，退化为按 updated_at 超过 TTL 判定。
      //    updated_at 由 setSetting 以北京时间写入，所以这里也要用同一套格式生成截止值，
      //    否则会差 8 小时。格式定宽，字符串比较等价于时间比较。
      const legacyCutoff = this.toBeijingString(new Date((nowSec - ttlSeconds) * 1000));
      const legacy = await this.db.prepare(
        "DELETE FROM settings WHERE key LIKE 'sess_%' AND value = 'valid' AND updated_at <= ?"
      ).bind(legacyCutoff).run();

      return (expired.meta?.changes || 0) + (legacy.meta?.changes || 0);
    } catch (e) {
      console.error("purgeExpiredSessions error:", e);
      return 0;
    }
  }

  // ===== 登录失败限流 =====
  //
  // NOTE: 用 cache 表存「失败计数」，带窗口过期时间，由 purgeExpiredCache() 统一回收。
  // key 形如 login_fail:<scope>，scope 由调用方拼接（用户名 + 客户端 IP），
  // 必须在调用前完成长度限制，防止攻击者用超长输入把 cache 表撑爆。

  /** 读取指定 scope 当前的失败次数（已过期的计数返回 0） */
  async countLoginFailures(scope: string): Promise<number> {
    try {
      const row = await this.db.prepare(
        "SELECT value FROM cache WHERE key = ? AND expires_at > ?"
      ).bind(`login_fail:${scope}`, Math.floor(Date.now() / 1000)).first<{ value: string }>();
      if (!row) return 0;
      const n = parseInt(String(row.value), 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch (e) {
      console.error("countLoginFailures error:", e);
      return 0;
    }
  }

  /**
   * 记录一次登录失败（窗口内自增计数，窗口滑动到调用时刻 + windowSeconds）
   *
   * @returns 自增后的失败次数
   */
  async recordLoginFailure(scope: string, windowSeconds = 15 * 60): Promise<number> {
    try {
      const expiresAt = Math.floor(Date.now() / 1000) + windowSeconds;
      await this.db.prepare(
        `INSERT INTO cache (key, value, expires_at) VALUES (?, '1', ?)
         ON CONFLICT(key) DO UPDATE SET
           value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
           expires_at = excluded.expires_at`
      ).bind(`login_fail:${scope}`, expiresAt).run();
    } catch (e) {
      console.error("recordLoginFailure error:", e);
    }
    return this.countLoginFailures(scope);
  }

  /** 登录成功后清空该 scope 的失败计数 */
  async clearLoginFailures(scope: string): Promise<void> {
    try {
      await this.db.prepare("DELETE FROM cache WHERE key = ?").bind(`login_fail:${scope}`).run();
    } catch (e) {
      console.error("clearLoginFailures error:", e);
    }
  }

  /**
   * 读取管理员鉴权配置
   *
   * NOTE: 鉴权相关配置以 auth_ 前缀独立存储于 settings 表。
   * TOTP 密钥使用 AES-GCM 加密，读取时自动解密为原文。
   */
  async getAuthConfig(): Promise<AuthConfig> {
    // NOTE: 这里原先是 5 次串行 await getSetting()，也就是 5 条独立 SELECT、5 次 D1 往返。
    //       D1 主库与执行 Worker 的边缘节点常常不在同一区域，单次往返实测 300-450ms，
    //       仅这一个函数就能给 /api/auth/status 这类"只读几行配置"的接口压上约 2 秒。
    //       改为一条 IN 查询后 5 次往返收敛成 1 次。
    const AUTH_KEYS = [
      "auth_username",
      "auth_pass_hash",
      "auth_pass_salt",
      "auth_2fa_enabled",
      "auth_2fa_secret",
    ];

    const values = new Map<string, string>();
    try {
      const { results } = await this.db
        .prepare(
          `SELECT key, value FROM settings WHERE key IN (${AUTH_KEYS.map(() => "?").join(", ")})`
        )
        .bind(...AUTH_KEYS)
        .all<{ key: string; value: string }>();
      for (const row of results || []) {
        values.set(row.key, String(row.value));
      }
    } catch (e) {
      // 与原 getSetting 的容错行为保持一致：读失败按「尚未配置」处理，
      // 调用方会落到未初始化分支，而不是抛错把登录页打死。
      console.error("getAuthConfig read error:", e);
    }

    const passHash = values.get("auth_pass_hash") || "";
    const encryptedSecret = values.get("auth_2fa_secret") || "";

    let twoFaSecret = "";
    if (encryptedSecret) {
      try {
        twoFaSecret = await decryptText(encryptedSecret, this.aesKey);
      } catch (e) {
        console.error("Failed to decrypt 2FA secret:", e);
      }
    }

    return {
      username: values.get("auth_username") || "admin",
      passHash,
      passSalt: values.get("auth_pass_salt") || "",
      twoFaEnabled: values.get("auth_2fa_enabled") === "1",
      twoFaSecret,
      initialized: !!passHash,
    };
  }

  /**
   * 设置/修改管理员密码（自动生成新盐值并哈希存储）
   */
  async setPassword(username: string, password: string): Promise<void> {
    const salt = generateSalt();
    const hash = await hashPassword(password, salt);
    await this.setSetting("auth_username", username);
    await this.setSetting("auth_pass_hash", hash);
    await this.setSetting("auth_pass_salt", salt);
  }

  /**
   * 校验管理员密码
   */
  async verifyPassword(password: string): Promise<boolean> {
    const cfg = await this.getAuthConfig();
    if (!cfg.passHash || !cfg.passSalt) return false;
    const hash = await hashPassword(password, cfg.passSalt);
    return timingSafeEqual(hash, cfg.passHash);
  }

  /**
   * 保存（加密）待启用的 2FA TOTP 密钥
   */
  async setTwoFaSecret(secretBase32: string): Promise<void> {
    const encrypted = await encryptText(secretBase32, this.aesKey);
    await this.setSetting("auth_2fa_secret", encrypted);
  }

  /**
   * 开启/关闭 2FA
   */
  async setTwoFaEnabled(enabled: boolean): Promise<void> {
    await this.setSetting("auth_2fa_enabled", enabled ? "1" : "0");
    if (!enabled) {
      // 关闭时清除密钥，避免残留
      await this.setSetting("auth_2fa_secret", "");
    }
  }

  /**
   * 获取当前北京时间 (UTC+8) 的 ISO 格式字符串
   *
   * NOTE: Cloudflare Workers / D1 的 CURRENT_TIMESTAMP 默认为 UTC，
   * 为了让日志时间与用户所在时区一致，手动构造北京时间。
   */
  private getBeijingNow(): string {
    return this.toBeijingString(new Date());
  }

  /**
   * 把任意时刻格式化成与 getBeijingNow() 完全一致的北京时间字符串
   *
   * NOTE: 供 purgeExpiredSessions() 生成与 updated_at 同格式的比较基准用。
   * 格式定宽（YYYY-MM-DD HH:mm:ss.sss），因此字符串比较等价于时间先后比较。
   */
  private toBeijingString(date: Date): string {
    const beijingOffset = 8 * 60 * 60 * 1000;
    const beijingTime = new Date(date.getTime() + beijingOffset);
    return beijingTime.toISOString().replace("T", " ").replace("Z", "");
  }

  /**
   * 写入日志
   */
  async writeLog(type: "info" | "success" | "warning" | "error", category: "sync" | "renew" | "system" | "auth" | "api" | "operation", message: string, details?: unknown) {
    try {
      const detailsStr = details ? (typeof details === "string" ? details : JSON.stringify(details)) : null;
      const beijingNow = this.getBeijingNow();
      await this.db.prepare(
        "INSERT INTO logs (type, category, message, details, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(type, category, message, detailsStr, beijingNow).run();
    } catch (e) {
      console.error("Failed to write database log:", e);
    }
  }

  /**
   * 获取日志列表 (按时间倒序，限制100条)
   *
   * NOTE: 可选按 categories 过滤（传入分类数组，如 ["api","sync","renew"]）。
   */
  async getLogs(limit = 100, categories?: string[]): Promise<DBLog[]> {
    if (categories && categories.length > 0) {
      const placeholders = categories.map(() => "?").join(",");
      const { results } = await this.db.prepare(
        `SELECT * FROM logs WHERE category IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`
      ).bind(...categories, limit).all<DBLog>();
      return results || [];
    }
    const { results } = await this.db.prepare(
      "SELECT * FROM logs ORDER BY created_at DESC LIMIT ?"
    ).bind(limit).all<DBLog>();
    return results || [];
  }

  /**
   * 清理所有日志
   */
  async clearLogs() {
    await this.db.prepare("DELETE FROM logs").run();
    await this.writeLog("info", "operation", "已手动清空运行日志");
  }

  /**
   * 实时更新域名的解析状态与 NS 标记 (用于 DNS 增删改后精准即时刷新状态)
   */
  async updateDomainStatusAndDns(domainId: number, status: string, hasDns: number, dnsProvider?: string) {
    try {
      const beijingNow = this.getBeijingNow();
      await this.db.prepare(
        "UPDATE domains_cache SET status = ?, has_dns = ?, dns_provider = ?, updated_at = ? WHERE id = ?"
      ).bind(status, hasDns, dnsProvider || (hasDns ? "system" : "external"), beijingNow, domainId).run();
    } catch (e) {
      console.error("Failed to update domain status and dns:", e);
    }
  }

  /**
   * 自动清理过期日志（保留最近 30 天）
   * 
   * NOTE: 在每次 Cron 任务执行后调用此方法，防止日志无限增长
   * 占满 D1 免费版的 500MB 存储限制
   */
  async pruneExpiredLogs() {
    try {
      const result = await this.db.prepare(
        "DELETE FROM logs WHERE created_at < datetime('now', '-30 days')"
      ).run();
      const deletedCount = result.meta?.changes || 0;
      if (deletedCount > 0) {
        await this.writeLog("info", "system", `自动清理了 ${deletedCount} 条超过 30 天的过期日志`);
      }
    } catch (e) {
      console.error("Failed to prune expired logs:", e);
    }
  }

  /**
   * 通过 keys/list 接口校验 API 密钥有效性，并尝试自动解析密钥名称 (key_name) 作为账户别名
   * @returns 解析出的别名；密钥无效时抛出异常；有效但未找到名称时返回 null
   */
  async resolveAliasFromKey(client: DNSHEClient, apiKey: string): Promise<string | null> {
    try {
      const res = await client.listApiKeys();
      if (res && res.success && Array.isArray(res.keys)) {
        const match = res.keys.find((k) => k.api_key === apiKey);
        const keyName = match && match.key_name ? String(match.key_name).trim() : "";
        if (keyName) return keyName;
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "未知错误";
      throw new Error(`无法验证 API 密钥有效性: ${message}`);
    }
    return null;
  }

  /**
   * 添加 API 账户
   * alias 可留空，留空时自动通过 keys/list 接口解析密钥名称 (key_name) 作为别名
   */
  async addAccount(alias: string, apiKey: string, apiSecret: string, provider: AccountProvider = "dnshe", website?: string | null): Promise<DBAccount> {
    let uniqueKey = apiKey;
    let credential = apiSecret;
    let finalAlias = (alias || "").trim();
    const finalWebsite = (website || "").trim() || null;

    if (provider === "custom") {
      // 自定义服务商：无 API 凭据，是「手动录入域名」的分组容器。
      // api_key 有 UNIQUE 约束，用别名哈希生成稳定唯一键（同名别名冲突由 UNIQUE 兜底）；
      // api_secret 存空，不参与加解密校验。
      if (!finalAlias) throw new Error("自定义服务商必须填写分组名称");
      uniqueKey = `custom:${await sha256Hex(`custom:${finalAlias}`)}`;
      credential = "";
    } else if (provider === "cloudflare") {
      // Cloudflare 账号：apiSecret 即 API Token（apiKey 参数不使用）
      const cfClient = new CloudflareClient(apiSecret);
      let verify: { token_id: string; status: string };
      try {
        verify = await cfClient.verifyToken();
      } catch (e: unknown) {
        throw new Error(`Cloudflare Token 校验失败: ${e instanceof Error ? e.message : "未知错误"}`);
      }
      if (verify.status && verify.status.toLowerCase() !== "active") {
        throw new Error(`Cloudflare Token 状态异常 (${verify.status})，请检查 Token 是否被禁用`);
      }

      // 别名留空时自动解析 Cloudflare 账号名。
      // NOTE: 实测仅有 Zone 类权限的 Token 调 GET /accounts 会「成功但返回空列表」
      //（没有 Account:Read 权限时不报错、只是看不到账号），因此「结果为空」与
      //「请求失败」都要回退到 GET /zones —— 每个 zone 都内嵌 account.id / account.name，
      // 凭 Zone:Read 即可拿到；两者都拿不到才退回 Token id。
      let cfAccount: { id?: string; name?: string } | undefined;
      try {
        cfAccount = (await cfClient.listAccounts())[0];
      } catch {
        cfAccount = undefined;
      }
      if (!cfAccount) {
        try {
          // 只为取一个 account.id 做别名回退，拉第一页（50 个 zone）足够
          cfAccount = (await cfClient.listZones({ maxPages: 1 })).zones.find((z) => z.account?.id)?.account;
        } catch {
          cfAccount = undefined;
        }
      }
      if (cfAccount?.id) {
        if (!finalAlias) finalAlias = normalizeCfAlias(cfAccount.name || "") || cfAccount.id;
        uniqueKey = `cf:${cfAccount.id}`;
      }
      if (!finalAlias) finalAlias = `Cloudflare ${String(verify.token_id).slice(0, 8)}`;
      if (uniqueKey === apiKey) uniqueKey = `cf:token:${verify.token_id}`;
    } else if (provider === "digitalplat") {
      // DigitalPlat 账号：apiSecret 即 API Key（dp_live_ / dp_test_，apiKey 参数不使用）。
      // 上游没有 whoami / keys 接口，用 GET /domains 做校验 —— 能列出域名即密钥有效。
      const dpClient = new DigitalPlatClient(credential);
      try {
        await dpClient.listDomains();
      } catch (e: unknown) {
        throw new Error(`DigitalPlat API Key 校验失败: ${e instanceof Error ? e.message : "未知错误"}`);
      }
      if (!finalAlias) {
        // 上游不返回账号名，用 Key 尾号做可辨认的默认别名
        finalAlias = `DigitalPlat ••••${credential.slice(-4)}`;
      }
      // api_key 列有 UNIQUE 约束且是明文展示位（前端显示尾号），存 Key 的 SHA-256 前缀
      // 而不是 Key 本身，避免凭据明文落库；`dp:` 前缀与 CF 的 `cf:` 空间区分。
      uniqueKey = `dp:${(await sha256Hex(credential)).slice(0, 32)}`;
    } else if (provider === "dnspod") {
      // DNSPod：apiKey 参数承载 SecretId，apiSecret 承载 SecretKey。
      // 上游没有 whoami 接口，用 DescribeDomainList 做校验 —— 能列出域名即凭据有效。
      if (!looksLikeTencentSecretId(apiKey)) {
        throw new Error(
          "DNSPod 的 SecretId 格式不正确（应以 AKID 开头，来自腾讯云「访问管理 → API 密钥管理」）；" +
            "请注意 DNSPod 控制台里的「API Token」是另一套凭据，本面板使用腾讯云 API 密钥"
        );
      }
      const dnspodClient = new DnspodClient(apiKey, credential);
      try {
        await dnspodClient.listDomains();
      } catch (e: unknown) {
        throw new Error(`DNSPod 凭据校验失败: ${e instanceof Error ? e.message : "未知错误"}`);
      }
      if (!finalAlias) finalAlias = `DNSPod ••••${apiKey.slice(-6)}`;
      // NOTE: 存**真实 SecretId**（不是哈希）—— 双凭据型的客户端重建需要它当 AccessKey，
      // 详见 dualCredentialApiKey 的说明。唯一性由 SecretId 本身保证。
      uniqueKey = dualCredentialApiKey("dnspod", apiKey);
    } else if (provider === "alidns") {
      // 阿里云云解析：apiKey 承载 AccessKeyId，apiSecret 承载 AccessKeySecret
      if (!looksLikeAliyunAccessKeyId(apiKey)) {
        throw new Error(
          "阿里云 AccessKey ID 格式不正确（应以 LTAI 开头，来自阿里云控制台「访问控制 → 用户 → 创建 AccessKey」）"
        );
      }
      const alidnsClient = new AlidnsClient(apiKey, credential);
      try {
        await alidnsClient.listDomains();
      } catch (e: unknown) {
        throw new Error(`阿里云 DNS 凭据校验失败: ${e instanceof Error ? e.message : "未知错误"}`);
      }
      if (!finalAlias) finalAlias = `阿里云 DNS ••••${apiKey.slice(-6)}`;
      // NOTE: 存**真实 AccessKeyId**（不是哈希）—— 同 DNSPod，见 dualCredentialApiKey。
      uniqueKey = dualCredentialApiKey("alidns", apiKey);
    } else if (provider === "huaweicloud") {
      // 华为云云解析：apiKey 承载 AccessKeyId（AK），apiSecret 承载 SecretAccessKey（SK）
      //
      // NOTE: 这里**不做** AK 格式预判。华为云没有公开承诺 AK 的字符集与长度，
      // 早先按「20 位大写字母数字」硬拦，一旦猜测有偏差就会把有效凭据挡在门外，
      // 而报错是「格式不正确」—— 用户对着控制台反复核对也看不出哪里不对。
      // 正确做法是让 API 当裁判：真的不对会在下面的 listDomains() 里以 APIGW.0301 暴露。
      const huaweiClient = new HuaweiCloudClient(apiKey, credential);
      try {
        await huaweiClient.listDomains();
      } catch (e: unknown) {
        const detail = e instanceof Error ? e.message : "未知错误";
        // 形状预判只作为失败后的补充提示，不参与拦截
        const shapeHint = looksLikeHuaweiAccessKeyId(apiKey)
          ? ""
          : "（补充：该 AK 不是常见的 20 位大写字母数字形式，请确认没有误填成 Secret Access Key）";
        throw new Error(`华为云 DNS 凭据校验失败: ${detail}${shapeHint}`);
      }
      if (!finalAlias) finalAlias = `华为云 DNS ••••${apiKey.slice(-6)}`;
      // NOTE: 存**真实 AK**（不是哈希）—— 同 DNSPod，见 dualCredentialApiKey。
      uniqueKey = dualCredentialApiKey("huaweicloud", apiKey);
    } else if (provider === "vercel") {
      // Vercel：apiSecret 即 Access Token（apiKey 参数不使用）。
      // 用 GET /v2/user 做校验并顺便拿用户名当别名。
      const vercelClient = new VercelClient(credential);
      let vercelUser: { id: string; username?: string; email?: string };
      try {
        vercelUser = await vercelClient.verifyToken();
      } catch (e: unknown) {
        throw new Error(`Vercel Token 校验失败: ${e instanceof Error ? e.message : "未知错误"}`);
      }
      if (!finalAlias) {
        finalAlias = vercelUser.username
          ? `Vercel · ${vercelUser.username}`
          : `Vercel ••••${credential.slice(-4)}`;
      }
      // 唯一键用用户 id（不是 Token 本身）—— 同一账号重新签发 Token 时应被视为同一个账号
      uniqueKey = vercelUser.id
        ? `vercel:${vercelUser.id}`
        : `vercel:${(await sha256Hex(credential)).slice(0, 32)}`;
    } else {
      const client = new DNSHEClient(apiKey, apiSecret);

      // 别名处理：为空时调用 keys/list 同时完成校验与别名解析（一次请求）
      if (!finalAlias) {
        const resolved = await this.resolveAliasFromKey(client, apiKey);
        if (!resolved) {
          throw new Error("API 密钥有效但未能自动获取密钥名称作为别名，请手动填写别名");
        }
        finalAlias = resolved;
      } else {
        // 显式提供别名时，仍需校验密钥是否可用
        try {
          await client.getQuota();
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : "未知错误";
          throw new Error(`无法验证 API 密钥有效性: ${message}`);
        }
      }
    }

    const encryptedSecret = await encryptText(credential, this.aesKey);

    // NOTE: 先执行写库（api_key 有 UNIQUE 约束），只有真正入库成功后才写"绑定成功"日志，
    // 避免重复绑定等失败场景下 INSERT 抛异常、成功日志却已落库导致的"失败却显示成功"问题。
    try {
      await this.db.prepare(
        "INSERT INTO accounts (alias, api_key, api_secret, provider, website) VALUES (?, ?, ?, ?, ?)"
      ).bind(finalAlias, uniqueKey, encryptedSecret, provider, finalWebsite).run();
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      // 唯一约束冲突（重复绑定同一凭据）翻译为友好中文提示
      if (raw.includes("UNIQUE") || raw.toLowerCase().includes("unique constraint")) {
        throw new Error(
          provider === "cloudflare"
            ? "该 Cloudflare 账号已被绑定，请勿重复绑定（别名: " + finalAlias + "）"
            : `该 API Key 已被绑定，请勿重复绑定（别名: ${finalAlias}）`
        );
      }
      throw new Error(`账户入库失败: ${raw}`);
    }

    const result = await this.db.prepare(
      "SELECT id, alias, api_key, provider, website, created_at FROM accounts WHERE api_key = ?"
    ).bind(uniqueKey).first<DBAccount>();

    // 入库成功后再记录日志：区分是否启用了 AES-GCM 加密
    if (!this.aesKey) {
      await this.writeLog("warning", "operation", `账户 [${finalAlias}] 已绑定，但由于未配置 AES_KEY，秘钥将以不安全的方式（弱 Base64 编码）存储在 D1 中！`);
    } else {
      await this.writeLog("success", "operation", `账户 [${finalAlias}] 绑定成功，已启用 AES-GCM 安全加密`);
    }

    return result as DBAccount;
  }

  /**
   * 获取所有账户
   */
  async getAccounts(provider?: AccountProvider): Promise<DBAccount[]> {
    const query = provider
      ? "SELECT id, alias, api_key, provider, website, created_at FROM accounts WHERE provider = ? ORDER BY id ASC"
      : "SELECT id, alias, api_key, provider, website, created_at FROM accounts ORDER BY id ASC";
    const statement = this.db.prepare(query);
    const { results } = provider
      ? await statement.bind(provider).all<DBAccount>()
      : await statement.all<DBAccount>();
    return results || [];
  }

  /**
   * 更新 API 账户（可仅修改别名，或同时更换凭据）
   */
  async updateAccount(id: number, alias: string, apiKey?: string, apiSecret?: string): Promise<DBAccount> {
    const existing = await this.db.prepare(
      "SELECT alias, api_key, api_secret, provider FROM accounts WHERE id = ?"
    ).bind(id).first();
    if (!existing) {
      throw new Error(`未找到 ID 为 ${id} 的账户`);
    }
    const existingRow = existing as { alias: string; api_key: string; api_secret: string; provider?: string };

    const finalAlias = (alias || "").trim() || existingRow.alias;
    let finalApiKey = existingRow.api_key;
    let finalEncryptedSecret = existingRow.api_secret;

    if (existingRow.provider === "cloudflare") {
      // Cloudflare 账号：apiSecret 即 API Token，只需单独更换 Token；api_key（账号唯一键）保持不变
      const newToken = (apiSecret || "").trim();
      if (newToken) {
        const cfClient = new CloudflareClient(newToken);
        try {
          const verify = await cfClient.verifyToken();
          if (verify.status && verify.status.toLowerCase() !== "active") {
            throw new Error(`Token 状态异常 (${verify.status})`);
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : "未知错误";
          throw new Error(`无法验证新 Cloudflare Token: ${message}`);
        }
        finalEncryptedSecret = await encryptText(newToken, this.aesKey);
      }
    } else if (existingRow.provider === "digitalplat") {
      // DigitalPlat 账号：apiSecret 即 API Key，留空保持不变
      const newKey = (apiSecret || "").trim();
      if (newKey) {
        const dpClient = new DigitalPlatClient(newKey);
        try {
          await dpClient.listDomains();
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : "未知错误";
          throw new Error(`无法验证新 DigitalPlat API Key: ${message}`);
        }
        finalApiKey = `dp:${(await sha256Hex(newKey)).slice(0, 32)}`;
        finalEncryptedSecret = await encryptText(newKey, this.aesKey);
      }
    } else if (
      existingRow.provider === "dnspod" ||
      existingRow.provider === "alidns" ||
      existingRow.provider === "huaweicloud"
    ) {
      // 双凭据型托管商：apiKey=AccessKey，apiSecret=Secret。
      //
      // 🔴 WHY 必须单独一支：原先没有这一支，会掉进下面的 DNSHE 分支 —— 用 DNSHEClient
      // 去校验华为云/DNSPod/阿里云的凭据必然失败，于是「编辑账号换凭据」根本用不了。
      // 校验必须用**该托管商自己的客户端**。
      const provider = existingRow.provider as AccountProvider;
      const newKey = (apiKey || "").trim();
      const newSecret = (apiSecret || "").trim();
      if (newKey || newSecret) {
        if (!newKey || !newSecret) {
          throw new Error("更换凭据时，AccessKey ID 与 Secret 必须同时填写");
        }
        try {
          if (provider === "dnspod") await new DnspodClient(newKey, newSecret).listDomains();
          else if (provider === "alidns") await new AlidnsClient(newKey, newSecret).listDomains();
          else await new HuaweiCloudClient(newKey, newSecret).listDomains();
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : "未知错误";
          throw new Error(`无法验证新凭据有效性: ${message}`);
        }
        // NOTE: 同 addAccount —— 存**真实 AccessKey**（不是哈希），见 dualCredentialApiKey
        finalApiKey = dualCredentialApiKey(provider, newKey);
        finalEncryptedSecret = await encryptText(newSecret, this.aesKey);
      }
    } else {
      // DNSHE：若提供了新的 API Key/Secret，则校验有效性并加密替换；留空表示保持不变
      const newKey = (apiKey || "").trim();
      const newSecret = (apiSecret || "").trim();
      if (newKey || newSecret) {
        if (!newKey || !newSecret) {
          throw new Error("更换 API 密钥时，API Key 与 API Secret 必须同时填写");
        }
        const client = new DNSHEClient(newKey, newSecret);
        try {
          await client.getQuota();
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : "未知错误";
          throw new Error(`无法验证新 API 密钥有效性: ${message}`);
        }
        finalApiKey = newKey;
        finalEncryptedSecret = await encryptText(newSecret, this.aesKey);
      }
    }

    try {
      await this.db.prepare(
        "UPDATE accounts SET alias = ?, api_key = ?, api_secret = ? WHERE id = ?"
      ).bind(finalAlias, finalApiKey, finalEncryptedSecret, id).run();
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      if (raw.includes("UNIQUE") || raw.toLowerCase().includes("unique constraint")) {
        throw new Error("该 API Key 已被其他账号绑定，请勿重复使用");
      }
      throw new Error(`账户更新失败: ${raw}`);
    }

    const result = await this.db.prepare(
      "SELECT id, alias, api_key, provider, website, created_at FROM accounts WHERE id = ?"
    ).bind(id).first<DBAccount>();

    await this.writeLog("success", "operation", `账户 [${finalAlias}] 信息已更新`);
    return result as DBAccount;
  }

  /**
   * 删除账户
   */
  async deleteAccount(id: number) {
    const account = await this.db.prepare("SELECT alias FROM accounts WHERE id = ?").bind(id).first();
    const alias = account ? (account as { alias: string }).alias : `ID ${id}`;

    // NOTE: domains_cache 会随账号级联删除，但这些域名的 DNS 记录缓存不会——
    // cache 表里会留下一批永远不会再被读取的孤儿行，直到 366 天兜底 TTL 到期。
    // 必须在删账号之前清，否则级联删完就查不到这些域名的 id 了。
    try {
      await this.db.prepare(
        "DELETE FROM cache WHERE key IN (SELECT 'api_cache:dns:' || id FROM domains_cache WHERE account_id = ?)"
      ).bind(id).run();
    } catch (e) {
      console.error("Failed to purge dns cache for account:", e);
    }

    await this.db.prepare("DELETE FROM accounts WHERE id = ?").bind(id).run();
    await this.writeLog("info", "operation", `解绑了账户 [${alias}]，其名下的域名缓存已被自动级联清理`);
  }

  /**
   * 根据 ID 获取解密后的 API 客户端
   *
   * NOTE: 这是全项目**唯一**的凭据出口 —— 任何需要访问上游的地方都必须经过这里，
   * 不得自行读 accounts 表解密。四个新托管商沿用同一约定：
   *   - 单凭据型（Vercel）：Token 存 api_secret，api_key 留空
   *   - 双凭据型（DNSPod / 阿里云 / 华为云）：api_key 存 `provider:AccessKey` 前缀串
   *     （见 dualCredentialApiKey，用 accessKeyIdFromApiKey 取回），api_secret 存 Secret 密文
   * custom 返回 DNSHEClient 占位，调用方必须先按 provider === "custom" 分流。
   */
  async getClientForAccount(id: number): Promise<{ client: UpstreamClient; alias: string; provider: AccountProvider }> {
    const account = await this.db.prepare(
      "SELECT alias, api_key, api_secret, provider FROM accounts WHERE id = ?"
    ).bind(id).first();

    if (!account) {
      throw new Error(`未找到 ID 为 ${id} 的账户`);
    }

    const typedAccount = account as { alias: string; api_key: string; api_secret: string; provider?: string };
    const apiSecret = await decryptText(typedAccount.api_secret, this.aesKey);

    // 旧版双凭据行的 api_key 是哈希（真实 AK 已丢失），无法重建客户端 —— 提前给出
    // 「解绑后重新绑定」的明确指引，而不是让用户对着恒定的「认证失败」空猜。
    if (isLegacyHashedDualCredentialKey(typedAccount.api_key)) {
      throw new Error(
        `账号 [${typedAccount.alias}] 的凭据是旧版格式（早期版本误将 AccessKey 的哈希存入，真实 AccessKey 已不可恢复）。` +
          `请解绑该账号后重新绑定一次，新绑定的账号即可正常同步。`
      );
    }
    if (typedAccount.provider === "cloudflare") {
      return {
        client: new CloudflareClient(apiSecret),
        alias: typedAccount.alias,
        provider: "cloudflare"
      };
    }
    if (typedAccount.provider === "digitalplat") {
      return {
        client: new DigitalPlatClient(apiSecret),
        alias: typedAccount.alias,
        provider: "digitalplat"
      };
    }
    if (typedAccount.provider === "dnspod") {
      return {
        client: new DnspodClient(accessKeyIdFromApiKey(typedAccount.api_key), apiSecret),
        alias: typedAccount.alias,
        provider: "dnspod"
      };
    }
    if (typedAccount.provider === "alidns") {
      return {
        client: new AlidnsClient(accessKeyIdFromApiKey(typedAccount.api_key), apiSecret),
        alias: typedAccount.alias,
        provider: "alidns"
      };
    }
    if (typedAccount.provider === "huaweicloud") {
      return {
        client: new HuaweiCloudClient(accessKeyIdFromApiKey(typedAccount.api_key), apiSecret),
        alias: typedAccount.alias,
        provider: "huaweicloud"
      };
    }
    if (typedAccount.provider === "vercel") {
      return {
        client: new VercelClient(apiSecret),
        alias: typedAccount.alias,
        provider: "vercel"
      };
    }
    if (typedAccount.provider === "custom") {
      // 自定义服务商：无上游 API，返回 DNSHEClient 占位（调用方必须先按 provider==="custom"
      // 分流，不得拿这个占位 client 做任何上游请求）。
      return {
        client: new DNSHEClient("", ""),
        alias: typedAccount.alias,
        provider: "custom"
      };
    }
    return {
      client: new DNSHEClient(typedAccount.api_key, apiSecret),
      alias: typedAccount.alias,
      provider: "dnshe"
    };
  }

  /**
   * 跨账号列出域名（包含所属账户别名），支持搜索与状态过滤
   *
   * NOTE: provider 过滤 —— 缺省时排除 Cloudflare / DigitalPlat 账号的行（它们在各自
   * 的独立标签页展示，DNSHE 域名页不应混入）；显式传 "cloudflare" 时只返回 CF zone 行，
   * 传 "digitalplat" 时只返回 DigitalPlat 行，传 "dnshe" 时只返回 DNSHE 账号的行。
   */
  async getDomains(
    search = "",
    status = "",
    accountId?: number,
    provider?: AccountProvider
  ): Promise<DBDomain[]> {
    let query = `
      SELECT d.*, a.alias as account_alias, a.provider as account_provider
      FROM domains_cache d
      LEFT JOIN accounts a ON d.account_id = a.id
      WHERE 1=1
    `;
    const binds: (string | number)[] = [];

    if (search) {
      query += " AND (d.subdomain LIKE ? OR d.rootdomain LIKE ? OR d.full_domain LIKE ?)";
      const searchPattern = `%${search}%`;
      binds.push(searchPattern, searchPattern, searchPattern);
    }

    if (status) {
      query += " AND d.status = ?";
      binds.push(status);
    }

    if (accountId) {
      query += " AND d.account_id = ?";
      binds.push(accountId);
    }

    if (provider === "cloudflare") {
      query += " AND a.provider = 'cloudflare'";
    } else if (provider === "digitalplat") {
      query += " AND a.provider = 'digitalplat'";
    } else if (
      provider === "dnspod" ||
      provider === "alidns" ||
      provider === "huaweicloud" ||
      provider === "vercel"
    ) {
      // 四个新托管商各有独立标签页，各自只返回自己账号的行
      query += " AND a.provider = ?";
      binds.push(provider);
    } else if (provider === "dnshe") {
      query += ` AND IFNULL(a.provider, 'dnshe') NOT IN (${nonDnsheProviderSqlList()})`;
    } else {
      query += ` AND IFNULL(a.provider, 'dnshe') NOT IN (${nonDnsheProviderSqlList()})`;
    }

    query += " ORDER BY d.expires_at ASC";

    const { results } = await this.db.prepare(query).bind(...binds).all<DBDomain & { account_provider?: string }>();
    return results || [];
  }

  /**
   * 按主键查询单条域名记录
   * 
   * NOTE: 替代原先的 getDomains() + Array.find() 全表扫描模式，
   * 直接使用 WHERE d.id = ? 走主键索引，性能从 O(N) 提升至 O(1)
   */
  async getDomainById(id: number): Promise<DBDomain | null> {
    const result = await this.db.prepare(`
      SELECT d.*, a.alias as account_alias 
      FROM domains_cache d
      LEFT JOIN accounts a ON d.account_id = a.id
      WHERE d.id = ?
    `).bind(id).first<DBDomain>();

    return result || null;
  }

  /**
   * 构造单条域名的 UPSERT 语句
   *
   * NOTE: 只有当调用方带上 dns_state_known（即本次确实拉取到了该域名的解析记录）时，
   * 才允许覆盖已有行的 status / has_dns / dns_provider。否则仅刷新到期时间等注册信息，
   * 保留数据库中已识别出的三态 —— 否则上游 subdomains/list 返回的 active 状态
   * 会把整个账号下的「已委派」域名刷成「已解析 + 系统默认」。
   */
  private buildDomainUpsert(accountId: number, sub: UpstreamSubdomain): D1PreparedStatement {
    let hasDnsVal = 1;
    if (sub.dns_state_known) {
      // 调用方已经读过该域名的真实解析记录，直接采信，不再从注册商层面的 ns1/ns2 反推
      hasDnsVal = sub.has_dns ? 1 : 0;
    } else if (sub.disable_ns_management) {
      hasDnsVal = 0;
    } else if (sub.ns1 || sub.ns2) {
      // 判断 NS 是否为默认 ns1.dnshe.com / ns2.dnshe.com
      const ns1 = (sub.ns1 || "").toLowerCase();
      const ns2 = (sub.ns2 || "").toLowerCase();
      const isDefault = ns1.includes("dnshe.com") || ns2.includes("dnshe.com");
      hasDnsVal = isDefault ? 1 : 0;
    } else if (sub.has_dns !== undefined) {
      hasDnsVal = sub.has_dns ? 1 : 0;
    }
    const dnsProvider = sub.dns_provider ?? null;

    // 解析服务商账号 ID —— 与三态不同，它来自 subdomains/list，任何一次同步都可信，
    // 因此不受 dns_state_known 约束；统一转成字符串存，避免上游在 number / string
    // 之间摇摆时前端比较失配。
    const providerAccountId =
      sub.provider_account_id === undefined || sub.provider_account_id === null
        ? null
        : String(sub.provider_account_id);

    // 解析状态未知时，冲突分支保持数据库中的原值不动
    const dnsStateAssignments = sub.dns_state_known
      ? `status = excluded.status,
            has_dns = excluded.has_dns,
            dns_provider = COALESCE(excluded.dns_provider, domains_cache.dns_provider),`
      : "";

    // 绑定的 status 在「解析状态未知」时只对 INSERT 生效（新行没有旧值可保留）。
    //
    // NOTE: 此时上游给的是注册态（active / Registered），前端会把它显示成「已解析」——
    // 新绑定账号里恰好被限流、没拉到解析记录的域名就会挂上一个假的「已解析 + 系统默认」。
    // 落成中性的「未解析」宁可少报也不误报，下一次同步会纠正过来。
    const statusVal = sub.dns_state_known || THREE_STATE_STATUSES.has(sub.status)
      ? sub.status
      : "未解析";

    return this.db.prepare(`
      INSERT INTO domains_cache (id, account_id, subdomain, rootdomain, full_domain, status, created_at, expires_at, has_dns, dns_provider, provider_account_id, remote_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        account_id = excluded.account_id,
        provider_account_id = COALESCE(excluded.provider_account_id, domains_cache.provider_account_id),
        remote_id = COALESCE(excluded.remote_id, domains_cache.remote_id),
        ${dnsStateAssignments}
        created_at = COALESCE(NULLIF(excluded.created_at, ''), domains_cache.created_at),
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).bind(
      sub.id,
      accountId,
      sub.subdomain,
      sub.rootdomain,
      sub.full_domain,
      statusVal,
      sub.created_at || "",
      sub.expires_at || "",
      hasDnsVal,
      dnsProvider,
      providerAccountId,
      sub.remote_id || null,
      this.getBeijingNow()
    );
  }

  /**
   * 写入/更新单条域名缓存（不做账号级别的清理扫描）
   *
   * NOTE: 供在线注册等「只新增一个域名」的场景使用。不能改用 syncAccountDomains，
   * 因为后者会把没出现在入参列表里的域名当作上游已删除而清除。
   */
  async upsertDomain(accountId: number, sub: UpstreamSubdomain): Promise<void> {
    await this.buildDomainUpsert(accountId, sub).run();
  }

  /**
   * 同步单个账号名下的域名到缓存表
   */
  async syncAccountDomains(accountId: number, subdomains: UpstreamSubdomain[]) {
    const statements: D1PreparedStatement[] = [];

    // 1. 获取当前缓存中该账号所有的域名 ID 集合，以便删除在 DNSHE 后台已经被删掉的域名
    const cachedDomains = await this.db.prepare(
      "SELECT id FROM domains_cache WHERE account_id = ?"
    ).bind(accountId).all();
    const cachedIds = new Set((cachedDomains.results || []).map((d: Record<string, unknown>) => d.id as number));
    const activeIds = new Set(subdomains.map(s => s.id));

    // 2. 准备插入/更新操作
    for (const sub of subdomains) {
      statements.push(this.buildDomainUpsert(accountId, sub));
    }

    // 3. 准备删除操作（清理已经被删除的域名）
    // NOTE: 改为每条 DELETE 使用独立的参数化语句，消除动态 SQL 拼接的注入风险。
    // 同时带上 account_id 条件 —— 虽然 cachedIds 本身来自 WHERE account_id = ?，
    // 但 DNSHE 的 id（小整数 subdomain_id）与 Cloudflare 的 id（zone id 哈希）属于
    // 两套不相交的命名空间，理论上不会碰撞；显式加 account_id 是双保险，
    // 万一未来 id 空间重叠也不会误删另一账号的行。
    const deleteIds = [...cachedIds].filter(id => !activeIds.has(id));
    for (const deleteId of deleteIds) {
      statements.push(
        this.db.prepare("DELETE FROM domains_cache WHERE id = ? AND account_id = ?").bind(deleteId, accountId)
      );
    }

    if (statements.length > 0) {
      await this.db.batch(statements);
    }
  }

  /**
   * 增量写入该账号的一批域名（不删除任何行）
   *
   * NOTE: 与 syncAccountDomains 的区别只在「不清理差集」——用于跨多次 Worker 调用分片
   * 拉取上游的场景（Cloudflare zone 列表分页续拉）。分片同步时每次只拿到上游的一个
   * 子集，若照常做差集删除，没轮到的分片会被当成「上游已删除」而误删。
   * 只有拿到完整列表（hasMore=false）的那一次调用才该走 syncAccountDomains。
   */
  async upsertAccountDomains(accountId: number, subdomains: UpstreamSubdomain[]) {
    if (subdomains.length === 0) return;
    const statements = subdomains.map((sub) => this.buildDomainUpsert(accountId, sub));
    await this.db.batch(statements);
  }

  /**
   * 标记域名已续期成功
   */
  async markDomainRenewed(id: number, newExpiresAt: string) {
    const beijingNow = this.getBeijingNow();
    await this.db.prepare(`
      UPDATE domains_cache
      SET expires_at = ?, last_renewed_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(newExpiresAt, beijingNow, beijingNow, id).run();
  }

  /**
   * 从本地缓存中移除一条域名记录（上游删除成功后调用，避免列表残留幽灵条目）
   */
  async deleteDomainFromCache(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM domains_cache WHERE id = ?").bind(id).run();
  }

  // ===== 自定义服务商（无 API，三层结构：分组 → 账号 → 域名） =====

  /** 列出某个服务商分组下的所有账号 */
  async listCustomAccounts(groupId: number): Promise<
    Array<{ id: number; group_id: number; name: string; updated_at: string }>
  > {
    const { results } = await this.db
      .prepare("SELECT id, group_id, name, updated_at FROM custom_accounts WHERE group_id = ? ORDER BY id ASC")
      .bind(groupId)
      .all<{ id: number; group_id: number; name: string; updated_at: string }>();
    return results || [];
  }

  /**
   * 跨分组列出所有账号（配合 listAllCustomDomains 供「一次拉齐」的总览接口用）
   *
   * 前端原先按分组逐个请求 accounts + domains（1 + 2N 次串行往返），分组一多首屏就要等几秒；
   * 两张表各一次全量查询即可，分组数不再影响请求数。
   */
  async listAllCustomAccounts(): Promise<
    Array<{ id: number; group_id: number; name: string; updated_at: string }>
  > {
    const { results } = await this.db
      .prepare("SELECT id, group_id, name, updated_at FROM custom_accounts ORDER BY group_id ASC, id ASC")
      .all<{ id: number; group_id: number; name: string; updated_at: string }>();
    return results || [];
  }

  /** 新增账号（同名 upsert 更新） */
  async upsertCustomAccount(groupId: number, name: string): Promise<number> {
    const now = this.getBeijingNow();
    await this.db.prepare(`
      INSERT INTO custom_accounts (group_id, name, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(group_id, name) DO UPDATE SET updated_at = excluded.updated_at
    `).bind(groupId, name, now).run();
    const row = await this.db
      .prepare("SELECT id FROM custom_accounts WHERE group_id = ? AND name = ?")
      .bind(groupId, name)
      .first<{ id: number }>();
    return row ? row.id : 0;
  }

  /** 删除账号（级联删除其下域名） */
  async deleteCustomAccount(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM custom_accounts WHERE id = ?").bind(id).run();
  }

  /**
   * 新增手动域名（同名 upsert，更新注册/到期时间与备注）。accountId 为 null 表示直接挂在分组下
   *
   * registeredAt 可选：公益域名常常查不到注册时间，留空存 NULL，前端显示「—」
   */
  async upsertCustomDomain(groupId: number, accountId: number | null, fullDomain: string, expiresAt: string, remark: string, registeredAt?: string | null): Promise<void> {
    const now = this.getBeijingNow();

    // NOTE: SQLite 的 UNIQUE 把每个 NULL 视作互不相同，所以 account_id 为空（域名直接挂在
    // 分组下）时 ON CONFLICT(group_id, account_id, full_domain) 永远不会命中 —— 每次保存都
    // 插一条新行，界面上就出现同名域名的多张卡片。这类行先按 IS NULL 查一次再决定更新/插入。
    if (accountId === null) {
      const existing = await this.db
        .prepare("SELECT id FROM custom_domains WHERE group_id = ? AND account_id IS NULL AND full_domain = ?")
        .bind(groupId, fullDomain)
        .first<{ id: number }>();
      if (existing?.id) {
        await this.db
          .prepare("UPDATE custom_domains SET registered_at = ?, expires_at = ?, remark = ?, updated_at = ? WHERE id = ?")
          .bind(registeredAt || null, expiresAt, remark || null, now, existing.id)
          .run();
        return;
      }
      await this.db
        .prepare(`
          INSERT INTO custom_domains (group_id, account_id, full_domain, registered_at, expires_at, remark, updated_at)
          VALUES (?, NULL, ?, ?, ?, ?, ?)
        `)
        .bind(groupId, fullDomain, registeredAt || null, expiresAt, remark || null, now)
        .run();
      return;
    }

    await this.db.prepare(`
      INSERT INTO custom_domains (group_id, account_id, full_domain, registered_at, expires_at, remark, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_id, account_id, full_domain) DO UPDATE SET
        registered_at = excluded.registered_at,
        expires_at = excluded.expires_at,
        remark = excluded.remark,
        updated_at = excluded.updated_at
    `).bind(groupId, accountId, fullDomain, registeredAt || null, expiresAt, remark || null, now).run();
  }

  /**
   * 按行 id 更新一条手动域名（编辑弹窗用，支持改域名本身）
   *
   * 走 id 而不是「域名 upsert」，改名时才不会留下旧行；返回 false 表示这条 id 不在该分组下。
   */
  async updateCustomDomainById(
    id: number,
    groupId: number,
    fullDomain: string,
    expiresAt: string,
    remark: string,
    registeredAt?: string | null
  ): Promise<boolean> {
    const now = this.getBeijingNow();
    const row = await this.db
      .prepare("SELECT id FROM custom_domains WHERE id = ? AND group_id = ?")
      .bind(id, groupId)
      .first<{ id: number }>();
    if (!row?.id) return false;
    await this.db
      .prepare(`
        UPDATE custom_domains
        SET full_domain = ?, registered_at = ?, expires_at = ?, remark = ?, updated_at = ?
        WHERE id = ?
      `)
      .bind(fullDomain, registeredAt || null, expiresAt, remark || null, now, id)
      .run();
    return true;
  }

  /** 删除一条手动域名 */
  async deleteCustomDomain(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM custom_domains WHERE id = ?").bind(id).run();
  }

  /** 跨分组列出所有自定义域名（含分组/账号信息，供到期提醒用） */
  async listAllCustomDomains(): Promise<
    Array<{ id: number; group_id: number; account_id: number | null; full_domain: string; registered_at: string | null; expires_at: string; remark: string | null; account_name: string | null; group_alias: string }>
  > {
    const { results } = await this.db
      .prepare(`
        SELECT d.id, d.group_id, d.account_id, d.full_domain, d.registered_at, d.expires_at, d.remark,
               ca.name as account_name, a.alias as group_alias
        FROM custom_domains d
        LEFT JOIN custom_accounts ca ON d.account_id = ca.id
        LEFT JOIN accounts a ON d.group_id = a.id
        ORDER BY d.expires_at ASC
      `)
      .all<{ id: number; group_id: number; account_id: number | null; full_domain: string; registered_at: string | null; expires_at: string; remark: string | null; account_name: string | null; group_alias: string }>();
    return results || [];
  }

  // ===== 域名日期手动覆盖（CF zone 注册/到期时间 + 来源，随账号存后端） =====

  /** 读取全部手动覆盖行（前端在进入 Cloudflare 页时合并进本地日期缓存） */
  async getDateOverrides(): Promise<
    Array<{ account_id: number; full_domain: string; registered_at: string | null; expires_at: string | null; source: string | null }>
  > {
    const { results } = await this.db
      .prepare(
        "SELECT account_id, full_domain, registered_at, expires_at, source FROM domain_date_overrides ORDER BY full_domain ASC"
      )
      .all<{ account_id: number; full_domain: string; registered_at: string | null; expires_at: string | null; source: string | null }>();
    return results || [];
  }

  /**
   * 批量读取指定 CF 账号下域名的手动日期覆盖（key = 小写 full_domain）
   *
   * NOTE: 定时任务里为 CF 域名做到期提醒时用 —— 手动覆盖是**零子请求**的数据源，
   * 优先级高于 RDAP 自动查询（用户录入的就是权威值，RDAP 对子域 zone 本来也查不到）。
   * 只取有 expires_at 的行：注册时间对「是否即将到期」没有意义，少传一列少占内存。
   */
  async getDateOverridesByAccountIds(
    accountIds: number[]
  ): Promise<Map<number, Map<string, string>>> {
    const out = new Map<number, Map<string, string>>();
    const valid = accountIds.filter((id) => Number.isSafeInteger(id) && id > 0);
    if (valid.length === 0) return out;

    // ⚠️ D1 硬上限：每条查询最多 100 个绑定参数。账号数远小于该量级，
    // 但仍按 90 分块，避免下游调用方传入超长列表时静默失败。
    const CHUNK = 90;
    for (let i = 0; i < valid.length; i += CHUNK) {
      const list = valid.slice(i, i + CHUNK).join(",");
      const { results } = await this.db
        .prepare(
          `SELECT account_id, full_domain, expires_at FROM domain_date_overrides
           WHERE account_id IN (${list}) AND expires_at IS NOT NULL AND expires_at != ''`
        )
        .all<{ account_id: number; full_domain: string; expires_at: string }>();
      for (const row of results || []) {
        const host = String(row.full_domain || "").trim().toLowerCase();
        if (!host) continue;
        let bucket = out.get(row.account_id);
        if (!bucket) {
          bucket = new Map<string, string>();
          out.set(row.account_id, bucket);
        }
        bucket.set(host, String(row.expires_at));
      }
    }
    return out;
  }

  /**
   * 批量读取 RDAP 到期时间缓存（key = 小写域名，value = expires_at）
   *
   * WHY 需要这个：CF zone 对象里**没有到期字段**（有效期登记在注册商处），
   * 上游结构性不提供 —— 所以给 CF 域名做到期提醒必须另找数据源。RDAP 结果由
   * 前端 /api/expiry 查询后写入 cache 表（键 rdap:4:<domain>，7 天 TTL），
   * 定时任务**只读这份缓存、不主动回源**，保证 cron 的额外子请求恒为 0。
   *
   * NOTE 两种「无结果」都必须如实返回缺失，不能当成「不过期」：
   *   - found=false（含 RDAP 404 的子域 zone）→ 没有到期信息，跳过提醒；
   *   - 带 error 的失败结论本来就不落缓存（见 index.ts 的 /api/expiry），此处自然读不到。
   * NOTE 与其他批量读缓存的方法一致：key 内联为字面量（D1 每条 SQL 最多 100 个绑定
   * 参数，不是 SQLite 的 999），绑定参数一个都不留。
   */
  async getRdapExpiryCacheBatch(domains: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const valid = Array.from(
      new Set(domains.map((d) => String(d || "").trim().toLowerCase()).filter(Boolean))
    );
    if (valid.length === 0) return out;

    const STMT_CHUNK = 400;
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < valid.length; i += STMT_CHUNK) {
      const list = valid
        .slice(i, i + STMT_CHUNK)
        .map((d) => `'${RDAP_CACHE_PREFIX}${d.replace(/'/g, "''")}'`)
        .join(",");
      const { results } = await this.db
        .prepare(
          `SELECT key, value FROM cache WHERE key IN (${list}) AND expires_at > ?`
        )
        .bind(now)
        .all<{ key: string; value: string }>();
      for (const row of results || []) {
        const host = String(row.key).slice(RDAP_CACHE_PREFIX.length);
        if (!host) continue;
        try {
          const parsed = JSON.parse(String(row.value)) as {
            found?: boolean;
            expires_at?: string;
          };
          if (parsed && parsed.found && parsed.expires_at) {
            out.set(host, String(parsed.expires_at));
          }
        } catch {
          // 缓存脏了（非 JSON / 结构不符）按未命中处理
        }
      }
    }
    return out;
  }

  /** 写入/更新单条手动覆盖（空串视为清除对应字段） */
  async upsertDateOverride(
    accountId: number,
    fullDomain: string,
    fields: { registered_at?: string | null; expires_at?: string | null; source?: string | null }
  ): Promise<void> {
    await this.db
      .prepare(`
        INSERT INTO domain_date_overrides (account_id, full_domain, registered_at, expires_at, source, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(account_id, full_domain) DO UPDATE SET
          registered_at = excluded.registered_at,
          expires_at = excluded.expires_at,
          source = excluded.source,
          updated_at = CURRENT_TIMESTAMP
      `)
      .bind(
        accountId,
        fullDomain,
        fields.registered_at || null,
        fields.expires_at || null,
        fields.source || null
      )
      .run();
  }

  /** 删除单条手动覆盖（恢复自动查询） */
  async deleteDateOverride(accountId: number, fullDomain: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM domain_date_overrides WHERE account_id = ? AND full_domain = ?")
      .bind(accountId, fullDomain)
      .run();
  }

  // ===== 数据导入 / 导出（备份与迁移） =====

  /**
   * 导出全部**业务数据**为可移植快照
   *
   * 范围刻意限定在 5 张业务表：accounts / domains_cache / custom_accounts /
   * custom_domains / domain_date_overrides。三张表**故意不导出**：
   *   - settings：内含 2FA 密钥、密码哈希、sess_ 会话行。导出它等于把「导出一份备份」
   *     变成「导出一份可登录的凭据」，与「导出需 2FA」的初衷直接冲突；
   *   - logs：纯运行历史，体积大且无恢复价值（恢复日志反而会污染新环境的排障线索）；
   *   - cache：上游响应的临时缓存，过期即失效，恢复它没有意义。
   *
   * NOTE: accounts 里的 api_key / api_secret 是**加密后的密文**（AES-GCM，密钥来自
   * AES_KEY 环境变量），导出的是密文本身。这意味着：跨环境导入时目标环境必须使用
   * **同一个 AES_KEY**，否则解密失败、账号凭据不可用。这是刻意的设计 —— 密文脱离
   * 密钥无法还原，比解密后明文导出安全得多。
   */
  async exportAllData(): Promise<{
    version: number;
    exported_at: string;
    counts: Record<string, number>;
    data: Record<string, unknown[]>;
  }> {
    const TABLES = [
      "accounts",
      "domains_cache",
      "custom_accounts",
      "custom_domains",
      "domain_date_overrides",
    ] as const;

    const data: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};

    for (const table of TABLES) {
      // 表名来自上面的白名单常量，不是用户输入，无注入风险
      const { results } = await this.db
        .prepare(`SELECT * FROM ${table}`)
        .all<Record<string, unknown>>();
      data[table] = results || [];
      counts[table] = (results || []).length;
    }

    return {
      version: DATA_EXPORT_VERSION,
      exported_at: new Date().toISOString(),
      counts,
      data,
    };
  }

  /**
   * 导入业务数据快照（**合并 upsert 语义**：同主键覆盖、不存在则新增，绝不删除现有行）
   *
   * WHY 不做「完全替换」：导入是恢复/迁移手段，用备份覆盖现场会顺手抹掉备份之后新增的
   * 数据，且误操作不可逆。合并语义下反复导入是幂等的，代价只是「备份里没有的行不会被清掉」
   * —— 对迁移场景足够，且失败可以重试。
   *
   * NOTE 写入顺序必须遵循外键依赖：accounts → custom_accounts → custom_domains /
   * domains_cache / domain_date_overrides。custom_accounts 依赖 accounts(group_id)，
   * custom_domains 同时依赖 accounts(group_id) 与 custom_accounts(account_id)，
   * domains_cache 与 domain_date_overrides 依赖 accounts。顺序错了会直接撞外键约束。
   *
   * NOTE 整批走 db.batch()：D1 的 batch 是原子的，任何一条失败整批回滚，
   * 不会留下「导了一半」的中间态。
   *
   * ⚠️ 已知限制：导入**不校验** domains_cache.account_id 指向的账号是否存在。
   * 若备份里的 domains_cache 引用了 accounts 里没有的 account_id（例如导出后被删的
   * 账号），外键约束会让**整批**导入失败。这是刻意的 fail-closed —— 宁可整体拒绝，
   * 也不要静默写入一批悬空的孤儿域名行（那会让面板出现点不开的域名卡片）。
   */
  async importAllData(snapshot: {
    version?: number;
    data?: Record<string, unknown[]>;
  }): Promise<{ imported: Record<string, number> }> {
    const version = Number(snapshot?.version);
    if (!Number.isFinite(version) || version !== DATA_EXPORT_VERSION) {
      throw new Error(
        `备份文件版本不支持（期望 ${DATA_EXPORT_VERSION}，实际 ${snapshot?.version ?? "缺失"}）`
      );
    }
    const src = snapshot?.data;
    if (!src || typeof src !== "object") {
      throw new Error("备份文件缺少 data 字段");
    }

    const imported: Record<string, number> = {};

    // 各表的列白名单与 upsert 语句：列名硬编码，避免备份文件里夹带列名做 SQL 注入
    const PLAN: Array<{ table: string; columns: string[]; conflict: string[] }> = [
      {
        table: "accounts",
        columns: ["id", "alias", "api_key", "api_secret", "provider", "website", "created_at"],
        conflict: ["id"],
      },
      {
        table: "custom_accounts",
        columns: ["id", "group_id", "name", "updated_at"],
        conflict: ["id"],
      },
      {
        table: "custom_domains",
        columns: [
          "id", "group_id", "account_id", "full_domain",
          "registered_at", "expires_at", "remark", "updated_at",
        ],
        conflict: ["id"],
      },
      {
        table: "domains_cache",
        columns: [
          "id", "account_id", "subdomain", "rootdomain", "full_domain", "status",
          "created_at", "expires_at", "last_renewed_at", "has_dns", "dns_provider",
          "provider_account_id", "remote_id", "updated_at",
        ],
        conflict: ["id"],
      },
      {
        table: "domain_date_overrides",
        columns: ["id", "account_id", "full_domain", "registered_at", "expires_at", "source", "updated_at"],
        conflict: ["id"],
      },
    ];

    const statements: Array<ReturnType<D1Database["prepare"]>> = [];
    const planned: Array<{ table: string; count: number }> = [];

    for (const step of PLAN) {
      const rows = Array.isArray(src[step.table]) ? (src[step.table] as unknown[]) : [];
      if (rows.length === 0) {
        imported[step.table] = 0;
        continue;
      }
      const colList = step.columns.join(", ");
      const placeholders = step.columns.map(() => "?").join(", ");
      const updates = step.columns
        .filter((c) => !step.conflict.includes(c))
        .map((c) => `${c} = excluded.${c}`)
        .join(", ");
      const sql = `INSERT INTO ${step.table} (${colList}) VALUES (${placeholders})
        ON CONFLICT(${step.conflict.join(", ")}) DO UPDATE SET ${updates}`;

      for (const raw of rows) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        const binds = step.columns.map((c) => {
          const v = row[c];
          // D1 只接受 string / number / null / ArrayBuffer，undefined 会报错
          if (v === undefined || v === null) return null;
          if (typeof v === "number" || typeof v === "string") return v;
          if (typeof v === "boolean") return v ? 1 : 0;
          return String(v);
        });
        statements.push(this.db.prepare(sql).bind(...binds));
        planned.push({ table: step.table, count: 1 });
      }
      imported[step.table] = rows.length;
    }

    if (statements.length > 0) {
      // ⚠️ D1 的 batch 上限（单次调用语句数）远小于这里可能出现的行数，
      // 且 batch 是原子的 —— 分块会破坏「全成功或全回滚」语义。
      // 因此这里限制单次导入的语句总数，超限直接拒绝并提示分批。
      const MAX_STATEMENTS = 500;
      if (statements.length > MAX_STATEMENTS) {
        throw new Error(
          `本次导入需要写入 ${statements.length} 行，超过单次上限 ${MAX_STATEMENTS} 行。请分批导出/导入。`
        );
      }
      await this.db.batch(statements);
    }

    return { imported };
  }
}
