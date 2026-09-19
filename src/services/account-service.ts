import type { AccountProvider, DBAccount } from "../db";
import { AccountRepository } from "../repositories/account-repository";

/** Account use-cases. Request validation/provider-specific checks remain outside this service. */
export class AccountService {
  constructor(private readonly repository: AccountRepository) {}

  list(provider?: AccountProvider): Promise<DBAccount[]> {
    return this.repository.list(provider);
  }

  create(alias: string, apiKey: string, apiSecret: string, provider: AccountProvider = "dnshe", website?: string | null) {
    return this.repository.create(alias, apiKey, apiSecret, provider, website);
  }

  update(id: number, alias: string, apiKey?: string, apiSecret?: string) {
    return this.repository.update(id, alias, apiKey, apiSecret);
  }

  remove(id: number) {
    return this.repository.remove(id);
  }
}
