import type { DBDomain, UpstreamClient } from "../../db";
import type { DnsRecordInput } from "../../types/dns";

export interface DnsProviderContext {
  domain: DBDomain;
  client: UpstreamClient;
}

export interface DnsProviderAdapter {
  listRecords(context: DnsProviderContext): Promise<{ success: boolean; records: unknown[]; message?: string }>;
  createRecord(context: DnsProviderContext, input: DnsRecordInput): Promise<{ success: boolean; message?: string; record?: unknown }>;
  updateRecord(context: DnsProviderContext, recordId: string, input: DnsRecordInput): Promise<{ success: boolean; message?: string; record?: unknown }>;
  deleteRecord(context: DnsProviderContext, recordId: string): Promise<{ success: boolean; message?: string }>;
}
