/**
 * 华为云 DNS Provider 适配器
 */

import type { HuaweiCloudClient } from "../../huaweicloud";
import type { DnsRecordInput } from "../../types/dns";
import { normalizeDnsRecordName } from "../../services/dns-operations";
import type { DnsProviderAdapter, DnsProviderContext } from "./types";

export class HuaweiCloudDnsAdapter implements DnsProviderAdapter {
  async listRecords({ domain, client }: DnsProviderContext) {
    const hwClient = client as HuaweiCloudClient;
    const remoteId = String(domain.remote_id || "");
    const res = await hwClient.listDnsRecords(remoteId);
    return { success: Boolean(res?.success), records: res?.records || [], message: res?.message };
  }

  async createRecord({ domain, client }: DnsProviderContext, input: DnsRecordInput) {
    const hwClient = client as HuaweiCloudClient;
    const name = normalizeDnsRecordName(String(input.name || ""), domain.full_domain);
    const res = await hwClient.createDnsRecord({
      zoneId: String(domain.remote_id || ""),
      zoneName: domain.full_domain,
      type: input.type,
      name,
      content: input.content,
      ttl: input.ttl,
      priority: input.priority,
      line: input.line,
    });
    return { success: Boolean(res?.success), message: res?.message, record: res?.record };
  }

  async updateRecord({ domain, client }: DnsProviderContext, recordId: string, input: DnsRecordInput) {
    const hwClient = client as HuaweiCloudClient;
    const name = normalizeDnsRecordName(String(input.name || ""), domain.full_domain);
    const res = await hwClient.updateDnsRecord({
      zoneId: String(domain.remote_id || ""),
      zoneName: domain.full_domain,
      record_id: recordId,
      type: input.type,
      name,
      content: input.content,
      ttl: input.ttl,
      priority: input.priority,
      line: input.line,
    });
    return { success: Boolean(res?.success), message: res?.message };
  }

  async deleteRecord({ domain, client }: DnsProviderContext, recordId: string) {
    const hwClient = client as HuaweiCloudClient;
    const remoteId = String(domain.remote_id || "");
    const res = await hwClient.deleteDnsRecord(remoteId, recordId);
    return { success: Boolean(res?.success), message: res?.message };
  }
}
