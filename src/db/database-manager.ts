/**
 * DatabaseManager — 精简核心类，保持完全的公开 API 兼容性
 *
 * NOTE: 所有业务逻辑已拆分到 dao/ 目录下的独立模块。本类仅负责：
 * 1. 持有 D1Database 连接和 AES 密钥
 * 2. Schema 自举（ensureTables）
 * 3. 原始查询出口（executeRaw / firstRaw / allRaw）
 * 4. 将所有公开方法委托到对应的 DAO 函数
 * 5. 跨 DAO 编排（refreshAccountQuotaCache）
 */

import { DNSHEClient } from "../dnshe";
import { getBeijingNow, toBeijingString } from "./time-utils";
import * as settingsDao from "./dao/settings-dao";
import * as cacheDao from "./dao/cache-dao";
import * as logDao from "./dao/log-dao";
import * as authDao from "./dao/auth-dao";
import * as accountDao from "./dao/account-dao";
import * as domainDao from "./dao/domain-dao";
import * as customDao from "./dao/custom-dao";
import * as backupDao from "./dao/backup-dao";
import type {
  AccountProvider,
  AuthConfig,
  DBAccount,
  DBDomain,
  DBLog,
  QuotaEntry,
  UpstreamClient,
  UpstreamSubdomain,
} from "./types";
import { NON_QUOTA_PROVIDERS } from "./types";

export class DatabaseManager {
  private db: D1Database;
  private aesKey?: string;

  constructor(d1Database: D1Database, aesKey?: string) {
    this.db = d1Database;
    this.aesKey = aesKey;
  }

  // ===== Schema 自举 =====

  /**
   * 自动确保所需的 D1 数据库表结构存在
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

      // 兼容已部署的旧数据库：仅在缺少字段时执行一次轻量迁移
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

  // ===== 原始查询出口（供 Repository 层使用） =====

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

  // ===== 时间工具（保持兼容，内部委托） =====

  private getBeijingNow(): string {
    return getBeijingNow();
  }

  private toBeijingString(date: Date): string {
    return toBeijingString(date);
  }

  // ===== 静态常量 =====

  static readonly SESSION_TTL_SECONDS = authDao.SESSION_TTL_SECONDS;
  static readonly SESSION_PREFIX = authDao.SESSION_PREFIX;

  // ===== Settings DAO 委托 =====

  async getSetting(key: string): Promise<string | null> {
    return settingsDao.getSetting(this.db, key);
  }
  async setSetting(key: string, value: string): Promise<void> {
    return settingsDao.setSetting(this.db, key, value);
  }
  async deleteSetting(key: string): Promise<void> {
    return settingsDao.deleteSetting(this.db, key);
  }
  async getAllAppSettings(): Promise<Record<string, string>> {
    return settingsDao.getAllAppSettings(this.db, this.aesKey);
  }
  async setAppSetting(shortKey: string, value: string): Promise<void> {
    return settingsDao.setAppSetting(this.db, this.aesKey, shortKey, value);
  }

  // ===== Cache DAO 委托 =====

  async getCache(key: string): Promise<string | null> {
    return cacheDao.getCache(this.db, key);
  }
  async setCache(key: string, value: string, ttlSeconds?: number): Promise<void> {
    return cacheDao.setCache(this.db, key, value, ttlSeconds);
  }
  async deleteCache(key: string): Promise<void> {
    return cacheDao.deleteCache(this.db, key);
  }
  async purgeExpiredCache(): Promise<number> {
    return cacheDao.purgeExpiredCache(this.db);
  }
  async getWhoisPool(domains: string[]): Promise<string[]> {
    return cacheDao.getWhoisPool(this.db, domains);
  }
  async addToWhoisPool(domain: string, ttlSeconds = 7 * 24 * 3600): Promise<void> {
    return cacheDao.addToWhoisPool(this.db, domain, ttlSeconds);
  }
  async getDnsRecordsCacheBatch(ids: number[]): Promise<Map<number, unknown[]>> {
    return cacheDao.getDnsRecordsCacheBatch(this.db, ids);
  }
  async getRdapExpiryCacheBatch(domains: string[]): Promise<Map<string, string>> {
    return cacheDao.getRdapExpiryCacheBatch(this.db, domains);
  }
  async removeAccountFromQuotaCache(accountId: number): Promise<void> {
    return cacheDao.removeAccountFromQuotaCache(this.db, accountId);
  }
  async renameAccountInQuotaCache(accountId: number, alias: string): Promise<void> {
    return cacheDao.renameAccountInQuotaCache(this.db, accountId, alias);
  }

  /**
   * 新绑定 / 换 Key：拉一次该账号的配额写回缓存
   *
   * NOTE: 此方法跨 cache-dao 和 account-dao，因此保留在 DatabaseManager 层编排。
   */
  async refreshAccountQuotaCache(accountId: number, alias: string, provider: AccountProvider = "dnshe"): Promise<void> {
    const cached = await cacheDao.readQuotaCache(this.db);
    if (cached === null) return;

    if (NON_QUOTA_PROVIDERS.includes(provider)) {
      await cacheDao.writeQuotaCache(this.db, cached.filter((q) => Number(q.account_id) !== accountId));
      return;
    }

    let entry: QuotaEntry;
    try {
      const { client } = await accountDao.getClientForAccount(this.db, this.aesKey, accountId);
      if (!(client instanceof DNSHEClient)) {
        await cacheDao.writeQuotaCache(this.db, cached.filter((q) => Number(q.account_id) !== accountId));
        return;
      }
      const qRes = await client.getQuota();
      entry = qRes && qRes.success
        ? { account_id: accountId, alias, ...qRes.quota }
        : { account_id: accountId, alias, error: qRes?.message || "获取额度失败" };
    } catch (e: unknown) {
      entry = { account_id: accountId, alias, error: e instanceof Error ? e.message : "获取额度失败" };
    }

    await cacheDao.writeQuotaCache(this.db, [...cached.filter((q) => Number(q.account_id) !== accountId), entry]);
  }

  // ===== Auth DAO 委托 =====

  async getAuthConfig(): Promise<AuthConfig> {
    return authDao.getAuthConfig(this.db, this.aesKey);
  }
  async setPassword(username: string, password: string): Promise<void> {
    return authDao.setPassword(this.db, username, password);
  }
  async verifyPassword(password: string): Promise<boolean> {
    return authDao.verifyPassword(this.db, this.aesKey, password);
  }
  async setTwoFaSecret(secretBase32: string): Promise<void> {
    return authDao.setTwoFaSecret(this.db, this.aesKey, secretBase32);
  }
  async setTwoFaEnabled(enabled: boolean): Promise<void> {
    return authDao.setTwoFaEnabled(this.db, enabled);
  }
  async createSession(ttlSeconds = authDao.SESSION_TTL_SECONDS): Promise<string> {
    return authDao.createSession(this.db, ttlSeconds);
  }
  async validateSession(token: string): Promise<boolean> {
    return authDao.validateSession(this.db, token);
  }
  async revokeSession(token: string): Promise<void> {
    return authDao.revokeSession(this.db, token);
  }
  async purgeExpiredSessions(ttlSeconds = authDao.SESSION_TTL_SECONDS): Promise<number> {
    return authDao.purgeExpiredSessions(this.db, ttlSeconds);
  }
  async countLoginFailures(scope: string): Promise<number> {
    return authDao.countLoginFailures(this.db, scope);
  }
  async recordLoginFailure(scope: string, windowSeconds = 15 * 60): Promise<number> {
    return authDao.recordLoginFailure(this.db, scope, windowSeconds);
  }
  async clearLoginFailures(scope: string): Promise<void> {
    return authDao.clearLoginFailures(this.db, scope);
  }

  // ===== Log DAO 委托 =====

  async writeLog(
    type: "info" | "success" | "warning" | "error",
    category: "sync" | "renew" | "system" | "auth" | "api" | "operation",
    message: string,
    details?: unknown
  ): Promise<void> {
    return logDao.writeLog(this.db, type, category, message, details);
  }
  async getLogs(limit = 100, categories?: string[]): Promise<DBLog[]> {
    return logDao.getLogs(this.db, limit, categories);
  }
  async clearLogs(): Promise<void> {
    return logDao.clearLogs(this.db);
  }
  async pruneExpiredLogs(): Promise<void> {
    return logDao.pruneExpiredLogs(this.db);
  }

  // ===== Account DAO 委托 =====

  async resolveAliasFromKey(client: DNSHEClient, apiKey: string): Promise<string | null> {
    return accountDao.resolveAliasFromKey(client, apiKey);
  }
  async addAccount(alias: string, apiKey: string, apiSecret: string, provider: AccountProvider = "dnshe", website?: string | null): Promise<DBAccount> {
    return accountDao.addAccount(this.db, this.aesKey, alias, apiKey, apiSecret, provider, website);
  }
  async getAccounts(provider?: AccountProvider): Promise<DBAccount[]> {
    return accountDao.getAccounts(this.db, provider);
  }
  async updateAccount(id: number, alias: string, apiKey?: string, apiSecret?: string): Promise<DBAccount> {
    return accountDao.updateAccount(this.db, this.aesKey, id, alias, apiKey, apiSecret);
  }
  async deleteAccount(id: number): Promise<void> {
    return accountDao.deleteAccount(this.db, id);
  }
  async getClientForAccount(id: number): Promise<{ client: UpstreamClient; alias: string; provider: AccountProvider }> {
    return accountDao.getClientForAccount(this.db, this.aesKey, id);
  }

  // ===== Domain DAO 委托 =====

  async getDomains(search = "", status = "", accountId?: number, provider?: AccountProvider): Promise<DBDomain[]> {
    return domainDao.getDomains(this.db, search, status, accountId, provider);
  }
  async getDomainById(id: number): Promise<DBDomain | null> {
    return domainDao.getDomainById(this.db, id);
  }
  async upsertDomain(accountId: number, sub: UpstreamSubdomain): Promise<void> {
    return domainDao.upsertDomain(this.db, accountId, sub);
  }
  async syncAccountDomains(accountId: number, subdomains: UpstreamSubdomain[]): Promise<void> {
    return domainDao.syncAccountDomains(this.db, accountId, subdomains);
  }
  async upsertAccountDomains(accountId: number, subdomains: UpstreamSubdomain[]): Promise<void> {
    return domainDao.upsertAccountDomains(this.db, accountId, subdomains);
  }
  async markDomainRenewed(id: number, newExpiresAt: string): Promise<void> {
    return domainDao.markDomainRenewed(this.db, id, newExpiresAt);
  }
  async deleteDomainFromCache(id: number): Promise<void> {
    return domainDao.deleteDomainFromCache(this.db, id);
  }
  async updateDomainStatusAndDns(domainId: number, status: string, hasDns: number, dnsProvider?: string): Promise<void> {
    return domainDao.updateDomainStatusAndDns(this.db, domainId, status, hasDns, dnsProvider);
  }

  // ===== Custom DAO 委托 =====

  async listCustomAccounts(groupId: number) {
    return customDao.listCustomAccounts(this.db, groupId);
  }
  async listAllCustomAccounts() {
    return customDao.listAllCustomAccounts(this.db);
  }
  async upsertCustomAccount(groupId: number, name: string): Promise<number> {
    return customDao.upsertCustomAccount(this.db, groupId, name);
  }
  async deleteCustomAccount(id: number): Promise<void> {
    return customDao.deleteCustomAccount(this.db, id);
  }
  async upsertCustomDomain(groupId: number, accountId: number | null, fullDomain: string, expiresAt: string, remark: string, registeredAt?: string | null): Promise<void> {
    return customDao.upsertCustomDomain(this.db, groupId, accountId, fullDomain, expiresAt, remark, registeredAt);
  }
  async updateCustomDomainById(id: number, groupId: number, fullDomain: string, expiresAt: string, remark: string, registeredAt?: string | null): Promise<boolean> {
    return customDao.updateCustomDomainById(this.db, id, groupId, fullDomain, expiresAt, remark, registeredAt);
  }
  async deleteCustomDomain(id: number): Promise<void> {
    return customDao.deleteCustomDomain(this.db, id);
  }
  async listAllCustomDomains() {
    return customDao.listAllCustomDomains(this.db);
  }
  async getDateOverrides() {
    return customDao.getDateOverrides(this.db);
  }
  async getDateOverridesByAccountIds(accountIds: number[]) {
    return customDao.getDateOverridesByAccountIds(this.db, accountIds);
  }
  async upsertDateOverride(accountId: number, fullDomain: string, fields: { registered_at?: string | null; expires_at?: string | null; source?: string | null }): Promise<void> {
    return customDao.upsertDateOverride(this.db, accountId, fullDomain, fields);
  }
  async deleteDateOverride(accountId: number, fullDomain: string): Promise<void> {
    return customDao.deleteDateOverride(this.db, accountId, fullDomain);
  }

  // ===== Backup DAO 委托 =====

  async exportAllData() {
    return backupDao.exportAllData(this.db);
  }
  async importAllData(snapshot: { version?: number; data?: Record<string, unknown[]> }) {
    return backupDao.importAllData(this.db, snapshot);
  }
}
