import { incompleteResponse } from "../errors/provider-api-error";
import type { ListDnsRecordsResponse, DnsRecordInfo } from "../dnshe";

/** Unknown and partial are never authoritative empty snapshots. */
export function requireCompleteDnsRecords(response: ListDnsRecordsResponse): DnsRecordInfo[] {
  if (!response?.success || !Array.isArray(response.records) || response.complete === false || response.pagination?.has_more === true) {
    throw incompleteResponse("dns", response?.message || "DNS 读取未完成，已保留最后成功缓存");
  }
  return response.records;
}
