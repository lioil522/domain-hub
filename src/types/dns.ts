export type DnsState = "unknown" | "known" | "empty" | "syncing" | "failed";

export interface DnsRecordModel {
  id: string;
  type?: string;
  name?: string;
  content?: string;
  ttl?: number;
  priority?: number;
  line?: string;
  proxied?: boolean;
  [key: string]: unknown;
}

export interface DnsRecordInput {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  line?: string;
  proxied?: boolean;
  [key: string]: unknown;
}

export interface DnsSyncSnapshot {
  state: DnsState;
  records: DnsRecordModel[];
  complete: boolean;
  fetchedAt: string;
}
