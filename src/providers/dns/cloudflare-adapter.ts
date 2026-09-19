/**
 * Cloudflare DNS Provider 适配器
 */

import type { CloudflareClient } from "../../cloudflare";
import type { DnsRecordInput } from "../../types/dns";
import { normalizeDnsRecordName } from "../../services/dns-operations";
import type { DnsProviderAdapter, DnsProviderContext } from "./types";

export class CloudflareDnsAdapter implements DnsProviderAdapter {
  async listRecords({ domain, client }: DnsProviderContext) {
    const cfClient = client as CloudflareClient;
    const zoneId = String(domain.remote_id || "");
    const res = await cfClient.listDnsRecords(zoneId);
    return { success: Boolean(res?.success), records: res?.records || [], message: res?.message };
  }

  async createRecord({ domain, client }: DnsProviderContext, input: DnsRecordInput) {
    const cfClient = client as CloudflareClient;
    const name = normalizeDnsRecordName(String(input.name || ""), domain.full_domain);
    const res = await cfClient.createDnsRecord({
      zone_id: String(domain.remote_id || ""),
      zone_name: domain.full_domain,
      type: input.type,
      name,
      content: input.content,
      ttl: input.ttl,
      priority: input.priority,
      proxied: Boolean(input.proxied),
    });
    return { success: Boolean(res?.success), message: res?.message, record: res?.record };
  }

  async updateRecord({ domain, client }: DnsProviderContext, recordId: string, input: DnsRecordInput) {
    const cfClient = client as CloudflareClient;
    const name = normalizeDnsRecordName(String(input.name || ""), domain.full_domain);
    const res = await cfClient.updateDnsRecord({
      zone_id: String(domain.remote_id || ""),
      zone_name: domain.full_domain,
      record_id: recordId,
      type: input.type,
      name,
      content: input.content,
      ttl: input.ttl,
      priority: input.priority,
      proxied: Boolean(input.proxied),
    });
    return { success: Boolean(res?.success), message: res?.message };
  }

  async deleteRecord({ domain, client }: DnsProviderContext, recordId: string) {
    const cfClient = client as CloudflareClient;
    const zoneId = String(domain.remote_id || "");
    const res = await cfClient.deleteDnsRecord(zoneId, recordId);
    return { success: Boolean(res?.success), message: res?.message };
  }
}
