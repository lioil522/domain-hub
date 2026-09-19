import { DatabaseManager } from "../db";
import type { DBDomain, UpstreamSubdomain, AccountProvider } from "../db";

/** Data-access boundary for cached domains. */
export class DomainRepository {
  constructor(private readonly db: DatabaseManager) {}

  list(search?: string, status?: string, accountId?: number, provider?: AccountProvider): Promise<DBDomain[]> {
    return this.db.getDomains(search, status, accountId, provider);
  }

  getById(id: number): Promise<DBDomain | null> {
    return this.db.getDomainById(id);
  }

  upsert(accountId: number, domain: UpstreamSubdomain): Promise<void> {
    return this.db.upsertDomain(accountId, domain);
  }

  syncAccount(accountId: number, domains: UpstreamSubdomain[]): Promise<void> {
    return this.db.syncAccountDomains(accountId, domains);
  }

  upsertAccount(accountId: number, domains: UpstreamSubdomain[]): Promise<void> {
    return this.db.upsertAccountDomains(accountId, domains);
  }

  markRenewed(id: number, expiresAt: string): Promise<void> {
    return this.db.markDomainRenewed(id, expiresAt);
  }

  removeFromCache(id: number): Promise<void> {
    return this.db.deleteDomainFromCache(id);
  }
}
