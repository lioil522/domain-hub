import type { AccountProvider } from "../db";

export type ProviderId = AccountProvider;

export interface ProviderCapabilities {
  domainApi: boolean;
  dnsApi: boolean;
  quota: boolean;
  renewal: boolean;
}

export interface ProviderDefinitionV2 {
  id: ProviderId;
  label: string;
  capabilities: ProviderCapabilities;
}
