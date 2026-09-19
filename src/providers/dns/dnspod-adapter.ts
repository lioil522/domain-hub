/**
 * DNSPod DNS Provider 适配器
 */

import type { DnspodClient } from "../../dnspod";
import type { DnsRecordInput } from "../../types/dns";
import { normalizeDnsRecordName } from "../../services/dns-operations";
import type { DnsProviderAdapter, DnsProviderContext } from "./types";

export class DnspodDnsAdapter implements DnsProviderAdapter {
  async listRecords({ domain, client }: DnsProviderContext) {
    const dnspodClient = client as DnspodClient;
    const remoteId = String(domain.remote_id || domain.full_domain);
    const res = await dnspodClient.listDnsRecords(remoteId);
    return { success: Boolean(res?.success), records: res?.records || [], message: res?.message };
  }

  async createRecord({ domain, client }: DnsProviderContext, input: DnsRecordInput) {
    const dnspodClient = client as DnspodClient;
    const name = normalizeDnsRecordName(String(input.name || ""), domain.full_domain);
    const res = await dnspodClient.createDnsRecord({
      domain: String(domain.remote_id || domain.full_domain),
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
    const dnspodClient = client as DnspodClient;
    const name = normalizeDnsRecordName(String(input.name || ""), domain.full_domain);
    const res = await dnspodClient.updateDnsRecord({
      domain: String(domain.remote_id || domain.full_domain),
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
    const dnspodClient = client as DnspodClient;
    const remoteId = String(domain.remote_id || domain.full_domain);
    const res = await dnspodClient.deleteDnsRecord(remoteId, recordId);
    return { success: Boolean(res?.success), message: res?.message };
  }
}
