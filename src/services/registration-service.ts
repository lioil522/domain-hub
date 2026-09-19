import type { DatabaseManager } from "../db";
import { createDomainProviderAdapter } from "../providers/adapters";
import { AccountRepository } from "../repositories/account-repository";
import { AccountService } from "./account-service";
import { toASCII } from "../punycode";

export interface RegistrationResult {
  full_domain: string;
  subdomain_id: number;
}

export class RegistrationService {
  constructor(private readonly db: DatabaseManager) {}

  async register(accountId: number, subdomain: string, rootdomain: string): Promise<RegistrationResult> {
    const { client, provider } = await this.db.getClientForAccount(accountId);
    if (provider !== "dnshe") throw new Error("仅 DNSHE 账号支持在线注册子域名");

    const adapter = createDomainProviderAdapter(provider, client);
    const registration = await adapter.registerSubdomain(toASCII(String(subdomain).trim()), toASCII(String(rootdomain).trim()));
    if (!registration.success || !registration.data) throw new Error(registration.message || "注册子域名失败");
    return registration.data;
  }
}
