/**
 * 阿里 DNS (Alidns) Provider 适配器
 */

import type { AlidnsClient } from "../../alidns";
import type { DnsRecordInput } from "../../types/dns";
import { normalizeDnsRecordName } from "../../services/dns-operations";
import type { DnsProviderAdapter, DnsProviderContext } from "./types";

export class AlidnsDnsAdapter implements DnsProviderAdapter {
  async listRecords({ domain, client }: DnsProviderContext) {
    const alidnsClient = client as AlidnsClient;
    const remoteId = String(domain.remote_id || domain.full_domain);
    const res = await alidnsClient.listDnsRecords(remoteId);
    return { success: Boolean(res?.success), records: res?.records || [], message: res?.message };
  }

  async createRecord({ domain, client }: DnsProviderContext, input: DnsRecordInput) {
    const alidnsClient = client as AlidnsClient;
    const name = normalizeDnsRecordName(String(input.name || ""), domain.full_domain);
    const res = await alidnsClient.createDnsRecord({
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
    const alidnsClient = client as AlidnsClient;
    const name = normalizeDnsRecordName(String(input.name || ""), domain.full_domain);
    const res = await alidnsClient.updateDnsRecord({
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
    const alidnsClient = client as AlidnsClient;
    const remoteId = String(domain.remote_id || domain.full_domain);
    const res = await alidnsClient.deleteDnsRecord(remoteId, recordId);
    return { success: Boolean(res?.success), message: res?.message };
  }
}
