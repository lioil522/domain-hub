import type { DBDomain, UpstreamClient, UpstreamSubdomain } from "../../db";
import type { ProviderId } from "../../types/provider";

export interface DomainOperationResult<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
}

export interface NameserverResult {
  nameservers: string[];
}

export interface DomainProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;
  listDomains(client: UpstreamClient): Promise<UpstreamSubdomain[]>;
  renew(domain: DBDomain): Promise<DomainOperationResult<{ newExpiresAt?: string }>>;
  delete(domain: DBDomain): Promise<DomainOperationResult<{ pendingDelete?: boolean }>>;
  listDnsRecords(domain: DBDomain): Promise<DomainOperationResult<{ records: unknown[] }>>;
  getNameservers(domain: DBDomain): Promise<DomainOperationResult<NameserverResult>>;
  updateNameservers(domain: DBDomain, nameservers: string[]): Promise<DomainOperationResult<NameserverResult>>;
  registerSubdomain(subdomain: string, rootdomain: string): Promise<DomainOperationResult<{ full_domain: string; subdomain_id: number }>>;
}
