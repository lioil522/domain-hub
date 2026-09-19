import type { AccountProvider } from "../db";
import type { ProviderDefinition } from "./types";

export const PROVIDER_REGISTRY: readonly ProviderDefinition[] = [
  { id: "dnshe", label: "DNSHE", hasQuota: true, hasDomainApi: true, hasDnsApi: true, credentialMode: "dual" },
  { id: "cloudflare", label: "Cloudflare", hasQuota: false, hasDomainApi: true, hasDnsApi: true, credentialMode: "single" },
  { id: "digitalplat", label: "DigitalPlat", hasQuota: false, hasDomainApi: true, hasDnsApi: true, credentialMode: "single" },
  { id: "dnspod", label: "DNSPod", hasQuota: false, hasDomainApi: true, hasDnsApi: true, credentialMode: "dual" },
  { id: "alidns", label: "阿里云 DNS", hasQuota: false, hasDomainApi: true, hasDnsApi: true, credentialMode: "dual" },
  { id: "huaweicloud", label: "华为云 DNS", hasQuota: false, hasDomainApi: true, hasDnsApi: true, credentialMode: "dual" },
  { id: "vercel", label: "Vercel", hasQuota: false, hasDomainApi: true, hasDnsApi: true, credentialMode: "single" },
  { id: "custom", label: "自定义", hasQuota: false, hasDomainApi: false, hasDnsApi: false, credentialMode: "none" },
] as const;

export const PROVIDER_IDS = PROVIDER_REGISTRY.map((item) => item.id) as readonly AccountProvider[];
export const PROVIDER_LABELS = Object.fromEntries(PROVIDER_REGISTRY.map((item) => [item.id, item.label])) as Record<AccountProvider, string>;

export function getProviderDefinition(id: AccountProvider): ProviderDefinition {
  const definition = PROVIDER_REGISTRY.find((item) => item.id === id);
  if (!definition) throw new Error(`Unsupported provider: ${id}`);
  return definition;
}

export function normalizeProvider(value: unknown, fallback: AccountProvider = "dnshe"): AccountProvider {
  const normalized = String(value || "").trim().toLowerCase();
  return PROVIDER_IDS.includes(normalized as AccountProvider) ? normalized as AccountProvider : fallback;
}
