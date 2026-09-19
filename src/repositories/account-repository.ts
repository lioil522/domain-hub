import { DatabaseManager } from "../db";
import type { AccountProvider, DBAccount } from "../db";

/** Data-access boundary for accounts. Business rules stay in services/routes. */
export class AccountRepository {
  constructor(private readonly db: DatabaseManager) {}

  list(provider?: AccountProvider): Promise<DBAccount[]> {
    return this.db.getAccounts(provider);
  }

  create(alias: string, apiKey: string, apiSecret: string, provider: AccountProvider = "dnshe", website?: string | null): Promise<DBAccount> {
    return this.db.addAccount(alias, apiKey, apiSecret, provider, website);
  }

  update(id: number, alias: string, apiKey?: string, apiSecret?: string): Promise<DBAccount> {
    return this.db.updateAccount(id, alias, apiKey, apiSecret);
  }

  remove(id: number): Promise<unknown> {
    return this.db.deleteAccount(id);
  }
}
