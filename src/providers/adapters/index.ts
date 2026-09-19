import type { AccountProvider, UpstreamClient } from "../../db";
import {
  CloudflareDnsAdapter,
  DigitalPlatDnsAdapter,
  DnspodDnsAdapter,
  AlidnsDnsAdapter,
  HuaweiCloudDnsAdapter,
  VercelDnsAdapter,
  DnsheDnsAdapter,
  CustomDnsAdapter,
  type DnsProviderAdapter,
} from "../dns";
import { LegacyDomainProviderAdapter } from "../domain/legacy-client-adapter";

const DNS_ADAPTERS: Record<AccountProvider, DnsProviderAdapter> = {
  cloudflare: new CloudflareDnsAdapter(),
  digitalplat: new DigitalPlatDnsAdapter(),
  dnspod: new DnspodDnsAdapter(),
  alidns: new AlidnsDnsAdapter(),
  huaweicloud: new HuaweiCloudDnsAdapter(),
  vercel: new VercelDnsAdapter(),
  dnshe: new DnsheDnsAdapter(),
  custom: new CustomDnsAdapter(),
};

export function createDnsProviderAdapter(provider: AccountProvider, _client?: UpstreamClient): DnsProviderAdapter {
  const adapter = DNS_ADAPTERS[provider];
  if (!adapter) {
    throw new Error(`不支持的 DNS 提供商: ${provider}`);
  }
  return adapter;
}

export function createDomainProviderAdapter(provider: AccountProvider, client: UpstreamClient) {
  return new LegacyDomainProviderAdapter(provider, client);
}
