import type { ProviderId } from "./provider";

export type DomainStatus = "active" | "suspended" | "expired" | "已委派" | "已解析" | "未解析" | string;

export interface DomainModel {
  id: string;
  name: string;
  provider: ProviderId;
  accountId: string;
  status: DomainStatus;
  createdAt?: string;
  expiresAt?: string;
  nameservers?: string[];
  remoteId?: string | null;
  hasDns?: boolean;
  dnsProvider?: string | null;
}
