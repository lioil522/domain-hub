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
      priority: input.priority,
    });
    return { success: Boolean(res?.success), message: res?.message, record: res?.record };
  }

  async batchCreateRecords({ domain, client }: DnsProviderContext, inputs: DnsRecordInput[]) {
    const dpClient = client as DigitalPlatClient;
    const items = inputs.map((input) => ({
      type: input.type,
      name: normalizeDnsRecordName(String(input.name || ""), domain.full_domain),
      content: input.content,
      ttl: input.ttl,
      priority: input.priority,
    }));
    return dpClient.batchCreateDnsRecords({
      domain: String(domain.remote_id || domain.full_domain),
      items,
    });
  }

  async updateRecord({ domain, client }: DnsProviderContext, recordId: string, input: DnsRecordInput) {
    const dpClient = client as DigitalPlatClient;
    const name = normalizeDnsRecordName(String(input.name || ""), domain.full_domain);
    const res = await dpClient.updateDnsRecord({
      domain: String(domain.remote_id || domain.full_domain),
      record_id: recordId,
      type: input.type,
      name,
      content: input.content,
      originContent: (input as any).origin_content,
      ttl: input.ttl,
      priority: input.priority,
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
