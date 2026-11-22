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
import * as cloudflareSyncDao from "./dao/cloudflare-sync-dao";
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
import { ensureDatabaseSchema } from "./schema-migrations";
import { StagedRestore } from "./dao/restore-dao";
import { SyncWorkQueue } from "./dao/sync-work-dao";
import { NotificationOutbox } from "./dao/notification-dao";
import { sha256Hex } from "./crypto";
import { ConflictError } from "../errors";
import { versionedCatalogDatabase } from "./catalog-version";

export class DatabaseManager {
  private db: D1Database;
  private aesKey?: string;

  constructor(d1Database: D1Database, aesKey?: string) {
    this.db = versionedCatalogDatabase(d1Database);
    this.aesKey = aesKey;
  }

  // ===== Schema 自举 =====

  /**
   * 自动确保所需的 D1 数据库表结构存在
   */
  async ensureTables(): Promise<boolean> {
    try {
      await ensureDatabaseSchema(this.db);
      return true;
    } catch (e) {
      console.error("Auto ensureTables error:", e);
      return false;
    }
  }

  // ===== 原始查询出口（供 Repository 层使用） =====
  catalogCacheBinding(): object { return this.db; }

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
  notificationOutbox() { return new NotificationOutbox(this.db, this.aesKey); }
  async initializePassword(username: string, password: string): Promise<boolean> {
    return authDao.initializePassword(this.db, username, password);
  }
  async verifyPassword(password: string): Promise<boolean> {
    return authDao.verifyPassword(this.db, this.aesKey, password);
  }
  async setTwoFaSecret(secretBase32: string): Promise<void> {
    return authDao.setTwoFaSecret(this.db, this.aesKey, secretBase32);
  }
  async getPendingTwoFa() {
    return authDao.getPendingTwoFa(this.db, this.aesKey);
  }
  async setTwoFaEnabled(enabled: boolean, expected: string): Promise<void> {
    return authDao.setTwoFaEnabled(this.db, enabled, expected);
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
  private async checkCloudflareFingerprint(accountId: number, expected: string) {
    const row = await this.db.prepare("SELECT provider,api_key,api_secret FROM accounts WHERE id=?").bind(accountId)
      .first<{ provider: string; api_key: string; api_secret: string }>();
    if (!row || await sha256Hex(JSON.stringify([row.provider, row.api_key, row.api_secret])) !== expected) {
      throw new ConflictError("Cloudflare 凭据已改变，旧同步不可继续提交", "sync_credentials_changed");
    }
  }
  async claimCloudflareSync(accountId: number, fingerprint?: string) {
    if (fingerprint) await this.checkCloudflareFingerprint(accountId, fingerprint);
    return cloudflareSyncDao.claimCloudflareSync(this.db, accountId, fingerprint);
  }
  async commitCloudflareSyncPage(accountId: number, lease: cloudflareSyncDao.CloudflareSyncLease, domains: UpstreamSubdomain[], page: { hasMore: boolean; nextPage: number }, guard?: { sql: string; bindings: unknown[] }): Promise<void> {
    if (lease.fingerprint) await this.checkCloudflareFingerprint(accountId, lease.fingerprint);
    return cloudflareSyncDao.commitCloudflareSyncPage(this.db, accountId, lease, domains, page, guard);
  }
  async releaseCloudflareSync(accountId: number, lease: cloudflareSyncDao.CloudflareSyncLease): Promise<void> {
    return cloudflareSyncDao.releaseCloudflareSync(this.db, accountId, lease);
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
  async listCustomDomainArchives(cursor?: string) {
    return customDao.listCustomDomainArchives(this.db, cursor);
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
    return backupDao.exportAllData(this.db, this.aesKey);
  }
  async importAllData(snapshot: unknown) {
    return backupDao.importAllData(this.db, snapshot, this.aesKey);
  }
  async previewDataImport(snapshot: unknown) {
    return backupDao.previewAllData(this.db, snapshot, this.aesKey);
  }
  stagedRestore() { return new StagedRestore(this.db, this.aesKey); }
  syncQueue() { return new SyncWorkQueue(this.db); }
}
