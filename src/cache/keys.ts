export const CACHE_KEYS = {
  dnsRecord: (id: number | string) => `api_cache:dns:${id}`,
  rdap: (domain: string) => `rdap:4:${domain}`,
  cfZoneCursor: (accountId: number) => `sync:cf_zones:${accountId}`,
  whoisPool: (domain: string) => `whois_pool:${domain}`,
} as const;
