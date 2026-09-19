import type { AccountProvider, DatabaseManager } from "../db";
import { getProviderDefinition, PROVIDER_REGISTRY } from "../providers/registry";

export class ProviderService {
  constructor(private readonly db: DatabaseManager) {}

  list() { return PROVIDER_REGISTRY; }
  get(provider: AccountProvider) { return getProviderDefinition(provider); }
  async listAccounts(provider?: AccountProvider) { return this.db.getAccounts(provider); }
}
