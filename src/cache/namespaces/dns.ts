import { CACHE_KEYS, CACHE_POLICY } from "../index";
export const DNS_CACHE = {
  records: CACHE_KEYS.dnsRecord,
  ttl: CACHE_POLICY.durable,
};
