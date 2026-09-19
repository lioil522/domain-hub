import type { AccountProvider } from "../db";

export interface ProviderDefinition {
  id: AccountProvider;
  label: string;
  hasQuota: boolean;
  hasDomainApi: boolean;
  hasDnsApi: boolean;
  credentialMode: "none" | "single" | "dual";
}
