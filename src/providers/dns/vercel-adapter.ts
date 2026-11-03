/**
 * Vercel DNS Provider 适配器
 */

import type { VercelClient } from "../../vercel";
import type { DnsRecordInput } from "../../types/dns";
import { normalizeDnsRecordName } from "../../services/dns-operations";
import type { DnsProviderAdapter, DnsProviderContext } from "./types";

export class VercelDnsAdapter implements DnsProviderAdapter {
  async listRecords({ domain, client }: DnsProviderContext) {
    const vercelClient = client as VercelClient;
    const remoteId = String(domain.remote_id || domain.full_domain);
    const res = await vercelClient.listDnsRecords(remoteId);
    return { success: Boolean(res?.success), records: res?.records || [], message: res?.message };
  }

  async createRecord({ domain, client }: DnsProviderContext, input: DnsRecordInput) {
    const vercelClient = client as VercelClient;
    const name = normalizeDnsRecordName(String(input.name || ""), domain.full_domain);
    const res = await vercelClient.createDnsRecord({
      domain: String(domain.remote_id || domain.full_domain),
      type: input.type,
      name,
      content: input.content,
      ttl: input.ttl,
      priority: input.priority,
    });
    return { success: Boolean(res?.success), message: res?.message, record: res?.record };
  }

  async updateRecord({ domain, client }: DnsProviderContext, recordId: string, input: DnsRecordInput) {
    const vercelClient = client as VercelClient;
    const name = normalizeDnsRecordName(String(input.name || ""), domain.full_domain);
    const res = await vercelClient.updateDnsRecord({
      domain: String(domain.remote_id || domain.full_domain),
      record_id: recordId,
      type: input.type,
      name,
      content: input.content,
      ttl: input.ttl,
      priority: input.priority,
    });
    return { success: Boolean(res?.success), message: res?.message };
  }

  async deleteRecord({ domain, client }: DnsProviderContext, recordId: string) {
    const vercelClient = client as VercelClient;
    const remoteId = String(domain.remote_id || domain.full_domain);
    const res = await vercelClient.deleteDnsRecord(remoteId, recordId);
    return { success: Boolean(res?.success), message: res?.message };
  }
}
