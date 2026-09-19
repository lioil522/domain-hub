/**
 * DigitalPlat DNS Provider 适配器
 */

import type { DigitalPlatClient } from "../../digitalplat";
import type { DnsRecordInput } from "../../types/dns";
import { normalizeDnsRecordName } from "../../services/dns-operations";
import type { DnsProviderAdapter, DnsProviderContext } from "./types";

export class DigitalPlatDnsAdapter implements DnsProviderAdapter {
  async listRecords({ domain, client }: DnsProviderContext) {
    const dpClient = client as DigitalPlatClient;
    const remoteId = String(domain.remote_id || domain.full_domain);
    const res = await dpClient.listDnsRecords(remoteId);
    return { success: Boolean(res?.success), records: res?.records || [], message: res?.message };
  }

  async createRecord({ domain, client }: DnsProviderContext, input: DnsRecordInput) {
    const dpClient = client as DigitalPlatClient;
    const name = normalizeDnsRecordName(String(input.name || ""), domain.full_domain);
    const res = await dpClient.createDnsRecord({
      domain: String(domain.remote_id || domain.full_domain),
      type: input.type,
      name,
      content: input.content,
      ttl: input.ttl || 300,
    });
    return { success: Boolean(res?.success), message: res?.message, record: res?.record };
  }

  async updateRecord({ domain, client }: DnsProviderContext, recordId: string, input: DnsRecordInput) {
    const dpClient = client as DigitalPlatClient;
    const res = await dpClient.updateDnsRecord({
      domain: String(domain.remote_id || domain.full_domain),
      record_id: recordId,
      content: input.content,
      ttl: input.ttl,
    });
    return { success: Boolean(res?.success), message: res?.message };
  }

  async deleteRecord({ domain, client }: DnsProviderContext, recordId: string) {
    const dpClient = client as DigitalPlatClient;
    const remoteId = String(domain.remote_id || domain.full_domain);
    const res = await dpClient.deleteDnsRecord(remoteId, recordId);
    return { success: Boolean(res?.success), message: res?.message };
  }
}
