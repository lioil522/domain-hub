import { DomainRepository } from "../repositories/domain-repository";
import type { AccountProvider } from "../db";

/** Domain use-cases over the cache repository. Provider/network orchestration stays elsewhere. */
export class DomainService {
  constructor(private readonly repository: DomainRepository) {}

  list(search?: string, status?: string, accountId?: number, provider?: AccountProvider) {
    return this.repository.list(search, status, accountId, provider);
  }

  get(id: number) {
    return this.repository.getById(id);
  }

  markRenewed(id: number, expiresAt: string) {
    return this.repository.markRenewed(id, expiresAt);
  }

  remove(id: number) {
    return this.repository.removeFromCache(id);
  }
}
