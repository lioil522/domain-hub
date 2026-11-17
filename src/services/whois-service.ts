import type { DatabaseManager } from "../db";
import { DNSHEClient } from "../dnshe";
import { NON_QUOTA_PROVIDERS } from "../db";
import { AccountRepository } from "../repositories/account-repository";
import { AccountService } from "./account-service";
import { UpstreamError } from "../errors";

export class WhoisService {
  constructor(private readonly db: DatabaseManager) {}

  async getClient(accountId?: number) {
    if (accountId) {
      const auth = await this.db.getClientForAccount(accountId);
      if (!(auth.client instanceof DNSHEClient)) throw new Error("仅 DNSHE 账号支持 WHOIS 查重");
      return auth.client;
    }
    const accounts = await new AccountService(new AccountRepository(this.db)).list();
    const dnsheAccount = accounts.find((acc) => !NON_QUOTA_PROVIDERS.includes(acc.provider));
    if (dnsheAccount) {
      const auth = await this.db.getClientForAccount(dnsheAccount.id);
      if (auth.client instanceof DNSHEClient) return auth.client;
    }
    return new DNSHEClient("public", "public");
  }

  async query(domain: string, accountId?: number) {
    const client = await this.getClient(accountId);
    const result = await client.whois(domain);
    if (!result || result.success !== true || typeof result.registered !== "boolean") {
      throw new UpstreamError(result?.message || "WHOIS 上游未返回明确的注册状态");
    }
    return result;
  }
}
