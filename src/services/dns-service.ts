import type { DatabaseManager, DBDomain } from "../db";
import { CacheService } from "../cache/cache";
import { CACHE_KEYS, CACHE_POLICY } from "../cache";
import { createDnsProviderAdapter } from "../providers/adapters";
import type { DnsRecordInput } from "../types/dns";
import { syncDomainStatusAfterDnsChange } from "./dns-operations";

export class DnsService {
  constructor(private readonly db: DatabaseManager) {}

  async list(domain: DBDomain, forceRefresh = false) {
    const cache = new CacheService(this.db);
    const key = CACHE_KEYS.dnsRecord(domain.id);
    if (!forceRefresh) {
      const cached = await cache.get(key);
      if (cached) return { success: true, records: JSON.parse(cached) as unknown[], cached: true };
    }
    const { client, provider } = await this.db.getClientForAccount(domain.account_id);
    const result = await createDnsProviderAdapter(provider, client).listRecords({ domain, client });
    if (!result.success) throw new Error(result.message || "获取 DNS 记录失败");
    await cache.set(key, JSON.stringify(result.records), CACHE_POLICY.durable);
    return { success: true, records: result.records, cached: false };
  }

  async create(domain: DBDomain, input: DnsRecordInput) {
    const { client, provider } = await this.db.getClientForAccount(domain.account_id);
    const result = await createDnsProviderAdapter(provider, client).createRecord({ domain, client }, input);
    if (!result.success) throw new Error(result.message || "创建 DNS 记录失败");
    await this.invalidate(domain.id);
    return result;
  }

  async batchCreate(
    domain: DBDomain,
    inputs: DnsRecordInput[],
    options?: {
      fallbackItemHandler?: (input: DnsRecordInput) => Promise<void>;
      sleep?: (ms: number) => Promise<void>;
    }
  ) {
    const { client, provider } = await this.db.getClientForAccount(domain.account_id);
    const adapter = createDnsProviderAdapter(provider, client);

    let batchResult: {
      results: Array<{ label: string; success: boolean; message: string }>;
      successCount: number;
      failCount: number;
    };

    if (typeof adapter.batchCreateRecords === "function") {
      batchResult = await adapter.batchCreateRecords({ domain, client }, inputs);
    } else {
      const results: Array<{ label: string; success: boolean; message: string }> = [];
      let successCount = 0;
      let failCount = 0;
      for (const input of inputs) {
        const label = `${input.type || "?"} ${input.name} → ${input.content || "(空)"}`;
        if (!input.type || !input.content) {
          failCount++;
          results.push({ label, success: false, message: "记录类型与记录值均不能为空" });
          continue;
        }
        try {
          if (options?.fallbackItemHandler) {
            await options.fallbackItemHandler(input);
          } else {
            const res = await adapter.createRecord({ domain, client }, input);
            if (!res.success) throw new Error(res.message || "创建失败");
          }
          successCount++;
          results.push({ label, success: true, message: "创建成功" });
        } catch (e: unknown) {
          failCount++;
          results.push({ label, success: false, message: e instanceof Error ? e.message : "未知错误" });
        }
        if (options?.sleep) {
          await options.sleep(300);
        }
      }
      batchResult = { results, successCount, failCount };
    }

    if (batchResult.successCount > 0) {
      await this.invalidate(domain.id);
    }
    return batchResult;
  }

  async update(domain: DBDomain, recordId: string, input: DnsRecordInput) {
    const { client, provider } = await this.db.getClientForAccount(domain.account_id);
    const result = await createDnsProviderAdapter(provider, client).updateRecord({ domain, client }, recordId, input);
    if (!result.success) throw new Error(result.message || "更新 DNS 记录失败");
    await this.invalidate(domain.id);
    return result;
  }

  async remove(domain: DBDomain, recordId: string) {
    const { client, provider } = await this.db.getClientForAccount(domain.account_id);
    const result = await createDnsProviderAdapter(provider, client).deleteRecord({ domain, client }, recordId);
    if (!result.success) throw new Error(result.message || "删除 DNS 记录失败");
    await this.invalidate(domain.id);
    return result;
  }

  async invalidate(domainId: number) {
    return new CacheService(this.db).delete(CACHE_KEYS.dnsRecord(domainId));
  }

  async refreshStatus(domain: DBDomain) {
    const { client } = await this.db.getClientForAccount(domain.account_id);
    await syncDomainStatusAfterDnsChange(this.db, client, domain);
  }
}

export function dnsService(db: DatabaseManager) { return new DnsService(db); }
