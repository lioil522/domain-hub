/**
 * DNSHE DNS Provider 适配器
 */

import type { DNSHEClient, CreateDnsRecordParams, UpdateDnsRecordParams } from "../../dnshe";
import type { DnsRecordInput } from "../../types/dns";
import { normalizeDnsRecordName } from "../../services/dns-operations";
import { requireCompleteDnsRecords } from "../../services/dns-snapshot";
import type { DnsProviderAdapter, DnsProviderContext } from "./types";

export class DnsheDnsAdapter implements DnsProviderAdapter {
  async listRecords({ domain, client }: DnsProviderContext) {
    const dnsheClient = client as DNSHEClient;
    const res = await dnsheClient.listDnsRecords(domain.id);
    return { success: true, records: requireCompleteDnsRecords(res), message: res.message };
  }

  async createRecord({ domain, client }: DnsProviderContext, input: DnsRecordInput) {
    const dnsheClient = client as DNSHEClient;
    const name = normalizeDnsRecordName(String(input.name || ""), domain.full_domain);
    const res = await dnsheClient.createDnsRecord({
      ...input,
      subdomain_id: domain.id,
      name,
    } as CreateDnsRecordParams);
    return { success: Boolean(res?.success), message: res?.message, record: res?.record };
  }

  async updateRecord({ domain, client }: DnsProviderContext, recordId: string, input: DnsRecordInput) {
    const dnsheClient = client as DNSHEClient;
    const name = normalizeDnsRecordName(String(input.name || ""), domain.full_domain);
    const res = await dnsheClient.updateDnsRecord({
      ...input,
      subdomain_id: domain.id,
      record_id: recordId,
      name,
    } as UpdateDnsRecordParams);
    return { success: Boolean(res?.success), message: res?.message };
  }

  async deleteRecord({ domain, client }: DnsProviderContext, recordId: string) {
    const dnsheClient = client as DNSHEClient;
    const res = await dnsheClient.deleteDnsRecord(domain.id, recordId);
    return { success: Boolean(res?.success), message: res?.message };
  }
}
