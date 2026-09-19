import type { DatabaseManager, AccountProvider } from "../db";
import { NON_QUOTA_PROVIDERS } from "../db";
import { DNSHEClient } from "../dnshe";
import { AccountRepository } from "../repositories/account-repository";
import { AccountService } from "./account-service";
export async function fetchAllQuotas(dbManager: DatabaseManager): Promise<{ accounts: Array<{ id: number; alias: string }>; quotas: unknown[] }> {
  const allAccounts = await new AccountService(new AccountRepository(dbManager)).list();
  // 非 DNSHE 托管商账号没有 DNSHE 式配额概念，自定义服务商分组无上游 API，
  // 均跳过查询避免无意义的上游报错（NON_QUOTA_PROVIDERS 是与 db.refreshAccountQuotaCache
  // 共用的同一份清单，避免两处各自维护导致漏改）
  const accounts = allAccounts.filter((acc) => !NON_QUOTA_PROVIDERS.includes(acc.provider as AccountProvider));

  // 并发发起所有账号的配额查询请求
  const quotaPromises = accounts.map(async (acc) => {
    const { client } = await dbManager.getClientForAccount(acc.id);
    if (!(client instanceof DNSHEClient)) {
      throw new Error("该账号不支持配额查询");
    }
    const qRes = await client.getQuota();
    if (qRes && qRes.success) {
      return {
        account_id: acc.id,
        alias: acc.alias,
        ...qRes.quota
      };
    }
    throw new Error(qRes.message || "获取额度失败");
  });

  const results = await Promise.allSettled(quotaPromises);

  const quotas = results.map((result, idx) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return {
      account_id: accounts[idx].id,
      alias: accounts[idx].alias,
      error: result.reason?.message || "获取额度失败"
    };
  });

  return { accounts, quotas };
}

