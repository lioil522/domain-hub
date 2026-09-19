import type { DatabaseManager } from "../db";
import { DNSHEClient } from "../dnshe";
import { NON_QUOTA_PROVIDERS } from "../db";
import { AccountRepository } from "../repositories/account-repository";
import { AccountService } from "./account-service";

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
    return client.whois(domain);
  }
}
