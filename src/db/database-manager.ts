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
import * as syncDao from "./dao/sync-dao";
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
import { databaseBudget } from "./budget-d1";
import { SYNC_TASK_SCHEMA } from "./sync-task-schema";
import { AUTOMATION_SCHEMA } from "./automation-schema";
import { LEGACY_TABLE_SCHEMA } from "./legacy-schema";

export class DatabaseManager {
  private db: D1Database;
  private aesKey?: string;

  constructor(d1Database: D1Database, aesKey?: string) {
    this.db = d1Database;
    this.aesKey = aesKey;
  }

  get invocationBudget() { return databaseBudget(this.db); }
  /** Internal DAO composition; retains the invocation's counted connection. */
  get connection() { return this.db; }

  // ===== Schema 自举 =====

  /**
   * 自动确保所需的 D1 数据库表结构存在
   */
  async ensureTables(): Promise<boolean> {
    try {
      // One read transaction: no business rows or persistent "ready" marker.
      // Missing tables have empty PRAGMA results; their CREATE includes all columns.
      const snapshots = await this.db.batch<{ name: string; type?: string }>([
        this.db.prepare(`SELECT lower(name) AS name, type FROM sqlite_master WHERE lower(name) IN (${LEGACY_TABLE_SCHEMA.map(() => "?").join(",")})`)
          .bind(...LEGACY_TABLE_SCHEMA.map(table => table.name)),
        this.db.prepare("PRAGMA table_info(domains_cache)"),
        this.db.prepare("PRAGMA table_info(accounts)"),
        this.db.prepare("PRAGMA table_info(custom_domains)"),
      ]);
      if (snapshots.length !== 4 || snapshots.some(result => !result.success || !Array.isArray(result.results))) {
        throw new Error("Schema inspection did not complete");
      }
      const tables = new Set<string>();
      for (const row of snapshots[0].results) {
        if (row.type !== "table" || !LEGACY_TABLE_SCHEMA.some(table => table.name === row.name)
          || tables.has(row.name)) throw new Error("Invalid legacy schema object");
        tables.add(row.name);
      }
      const columnNames = (table: string, index: number) => {
        const names = snapshots[index].results.map(column => column.name);
        if (names.some(name => typeof name !== "string" || !name) || new Set(names).size !== names.length
          || tables.has(table) !== (names.length > 0)) throw new Error("Invalid schema column inspection");
        return new Set(names.map(name => name.toLowerCase()));
      };
      const existingColumns = columnNames("domains_cache", 1);
      const accountColumnNames = columnNames("accounts", 2);
      const customDomainColumnNames = columnNames("custom_domains", 3);

      // 兼容已部署的旧数据库：仅在缺少字段时执行一次轻量迁移
      const migrations: string[] = LEGACY_TABLE_SCHEMA.filter(table => !tables.has(table.name)).map(table => table.sql);
      if (tables.has("domains_cache") && !existingColumns.has("dns_provider")) {
        migrations.push("ALTER TABLE domains_cache ADD COLUMN dns_provider TEXT");
      }
      if (tables.has("domains_cache") && !existingColumns.has("provider_account_id")) {
        migrations.push("ALTER TABLE domains_cache ADD COLUMN provider_account_id TEXT");
      }
      if (tables.has("domains_cache") && !existingColumns.has("remote_id")) {
        migrations.push("ALTER TABLE domains_cache ADD COLUMN remote_id TEXT");
      }
      if (tables.has("accounts") && !accountColumnNames.has("provider")) {
        migrations.push("ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'dnshe'");
      }
      if (tables.has("accounts") && !accountColumnNames.has("website")) {
        migrations.push("ALTER TABLE accounts ADD COLUMN website TEXT");
      }
      if (tables.has("custom_domains") && !customDomainColumnNames.has("registered_at")) {
        migrations.push("ALTER TABLE custom_domains ADD COLUMN registered_at TEXT");
      }
      // Retain EVERY additive definition and clock initializer. All writes,
      // including legacy ALTERs, now roll back together if any statement fails.
      migrations.push(...SYNC_TASK_SCHEMA, ...AUTOMATION_SCHEMA);
      const results = await this.db.batch(migrations.map(sql => this.db.prepare(sql)));
      if (results.length !== migrations.length || results.some(result => !result.success || !Array.isArray(result.results))) {
        throw new Error("Schema migration did not complete");
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
    if (!result.success || !Array.isArray(result.results)) throw new Error("数据库查询未完成");
    return result.results;
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
  async getAuthoritativeAppSettings(): Promise<Record<string, string>> {
    return settingsDao.getAllAppSettings(this.db, this.aesKey, true);
  }
  async initializePassword(username: string, password: string): Promise<boolean> {
    return authDao.initializePassword(this.db, username, password);
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
  async getLogs(limit = 100, categories?: string[], afterId?: number): Promise<DBLog[]> {
    return logDao.getLogs(this.db, limit, categories, afterId);
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

  /** Complete records and invalidation marker commit together; never clear dirty on a failed write. */
  async replaceDnsRecordsCache(domainId: number, records: unknown[]): Promise<void> {
    await this.db.batch([
      this.db.prepare(`INSERT INTO cache(key,value,expires_at) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`)
        .bind(`api_cache:dns:${domainId}`, JSON.stringify(records), Math.floor(Date.now() / 1000) + 366 * 24 * 3600),
      this.db.prepare("DELETE FROM cache WHERE key = ?").bind(`dns_dirty:${domainId}`),
      this.db.prepare("UPDATE domains_cache SET updated_at=updated_at WHERE id=?").bind(domainId),
    ]);
  }

  async acquireSyncLease(key: string, token: string): Promise<boolean> {
    return syncDao.acquireSyncLease(this.db, key, token);
  }
  async commitSyncPage(accountId: number, domains: UpstreamSubdomain[], leaseKey: string, token: string,
    cursorKey: string, value: string, ttl: number, deletions: syncDao.SyncCandidate[] = []): Promise<void> {
    return syncDao.commitSyncPage(this.db, accountId, domains, leaseKey, token, cursorKey, value, ttl, deletions);
  }

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
  async importAllData(snapshot: unknown, sourceAesKey?: string, dryRun = false) {
    return backupDao.importAllData(this.db, snapshot, this.aesKey, sourceAesKey, dryRun);
  }
}
