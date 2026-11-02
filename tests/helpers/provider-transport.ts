// Offline wire fixtures shared by Node and the test-only workerd entry point.
import { DNSHEClient } from "../../src/dnshe";
import { CloudflareClient } from "../../src/cloudflare";
import { DnspodClient } from "../../src/dnspod";
import { AlidnsClient } from "../../src/alidns";
import { HuaweiCloudClient } from "../../src/huaweicloud";
import { VercelClient } from "../../src/vercel";
import { DigitalPlatClient } from "../../src/digitalplat";
import type { ProviderRequestLimits } from "../../src/providers/provider-request";

export const transportProviders = ["dnshe", "cloudflare", "dnspod", "alidns", "huaweicloud", "vercel", "digitalplat"] as const;
export type TransportProvider = typeof transportProviders[number];
export const businessRateLimits = [
  { provider: "dnshe", code: "rate_limit_exceeded" },
  { provider: "dnspod", code: "RequestLimitExceeded" },
  { provider: "dnspod", code: "RequestLimitExceeded.GlobalRegionUinLimitExceeded" },
  { provider: "dnspod", code: "RequestLimitExceeded.IPLimitExceeded" },
  { provider: "dnspod", code: "RequestLimitExceeded.UinLimitExceeded" },
  { provider: "dnspod", code: "RequestLimitExceeded.BatchTaskLimit" },
  { provider: "dnspod", code: "RequestLimitExceeded.CreateDomainLimit" },
  { provider: "dnspod", code: "RequestLimitExceeded.RequestLimitExceeded" },
  { provider: "alidns", code: "Throttling" },
  { provider: "alidns", code: "Throttling.User" },
  { provider: "huaweicloud", code: "APIGW.0308" },
  { provider: "vercel", code: "rate_limited" },
] as const;
export const transportDomain = "fixture.example";
export const dpExisting = { id: "rr-1", name: "www", type: "A", value: "192.0.2.1", ttl: 300, etag: "version-1", protected: false };

export function transportFixture(provider: TransportProvider, limits: ProviderRequestLimits = {}) {
  const params = { domain: transportDomain, type: "A", name: "www", content: "192.0.2.2", ttl: 300 };
  switch (provider) {
    case "dnshe": {
      const client = new DNSHEClient("fixture-key", "fixture-secret", undefined, limits);
      return { client, read: () => client.listSubdomains(), write: () => client.createDnsRecord({ ...params, subdomain_id: 101 }) };
    }
    case "cloudflare": {
      const client = new CloudflareClient("fixture-token", limits);
      return { client, read: () => client.listZones({ maxPages: 1 }), write: () => client.createDnsRecord({ ...params, zone_id: "zone-1" }) };
    }
    case "dnspod": {
      const client = new DnspodClient("fixture-key", "fixture-secret", limits);
      return { client, read: () => client.listDomains(), write: () => client.createDnsRecord(params) };
    }
    case "alidns": {
      const client = new AlidnsClient("fixture-key", "fixture-secret", limits);
      return { client, read: () => client.listDomains(), write: () => client.createDnsRecord(params) };
    }
    case "huaweicloud": {
      // Automatic candidates deliberately remain enabled to detect accidental
      // write retries; pinning a host would conceal that regression.
      const client = new HuaweiCloudClient("fixture-key", "fixture-secret", undefined, limits);
      return { client, read: () => client.listDomains(), write: () => client.createDnsRecord({ ...params, zoneId: "zone-1", zoneName: transportDomain }) };
    }
    case "vercel": {
      const client = new VercelClient("fixture-token", "fixture-team", limits);
      return { client, read: () => client.listDomains(), write: () => client.createDnsRecord(params) };
    }
    case "digitalplat": {
      const client = new DigitalPlatClient("fixture-token", limits);
      return { client, read: () => client.listDomains(), write: () => client.createDnsRecord(params) };
    }
  }
}

export function transportErrorBody(provider: TransportProvider, code = "fixture_denied", message = "fixture failure") {
  switch (provider) {
    case "dnshe": return { success: false, error_code: code, message };
    case "cloudflare": return { success: false, errors: [{ code, message }] };
    case "dnspod": return { Response: { Error: { Code: code, Message: message } } };
    case "alidns": return { Code: code, Message: message };
    case "huaweicloud": return { error_code: code, error_msg: message };
    case "vercel": case "digitalplat": return { success: false, error: { code, message } };
  }
}

export function transportEmptyDomains(provider: TransportProvider) {
  switch (provider) {
    case "dnshe": return { success: true, subdomains: [], pagination: { total: 0, total_pages: 1, current_page: 1, per_page: 100 } };
    case "cloudflare": return { success: true, result: [], result_info: { page: 1, per_page: 50, count: 0, total_count: 0, total_pages: 0 } };
    case "dnspod": return { Response: { DomainList: [], DomainCountInfo: { AllTotal: 0 } } };
    case "alidns": return { Domains: { Domain: [] }, TotalCount: 0, PageNumber: 1, PageSize: 100 };
    case "huaweicloud": return { zones: [], metadata: { total_count: 0 } };
    case "vercel": return { domains: [], pagination: { count: 0, next: null } };
    case "digitalplat": return { success: true, data: [] };
  }
}

export function transportEmptyDns(provider: TransportProvider) {
  switch (provider) {
    case "dnshe": return { success: true, records: [], pagination: { has_more: false } };
    case "cloudflare": return { success: true, result: [], result_info: { page: 1, per_page: 100, count: 0, total_count: 0, total_pages: 0 } };
    case "dnspod": return { Response: { RecordList: [], RecordCountInfo: { TotalCount: 0, ListCount: 0 } } };
    case "alidns": return { DomainRecords: { Record: [] }, TotalCount: 0, PageNumber: 1, PageSize: 100 };
    case "huaweicloud": return { recordsets: [], metadata: { total_count: 0 } };
    case "vercel": return { records: [], pagination: { count: 0, next: null } };
    case "digitalplat": return { success: true, data: [] };
  }
}
