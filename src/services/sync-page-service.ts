import type { UpstreamClient, UpstreamSubdomain } from "../db";
import { DNSHEClient } from "../dnshe";
import { CloudflareClient, mapZoneToUpstream } from "../cloudflare";
import { DigitalPlatClient, mapDomainToUpstream } from "../digitalplat";
import { DnspodClient, mapDnspodDomainToUpstream } from "../dnspod";
import { AlidnsClient, mapAlidnsDomainToUpstream } from "../alidns";
import { HuaweiCloudClient, mapHuaweiZoneToUpstream } from "../huaweicloud";
import { VercelClient, mapVercelDomainToUpstream } from "../vercel";
import { incompleteResponse } from "../errors/provider-api-error";
import { pageTotal, type ProviderPage } from "../providers/sync-page";

export async function readDomainPage(client: UpstreamClient, cursor: number | string | undefined, count: number, expected?: number): Promise<ProviderPage<UpstreamSubdomain>> {
  if (client instanceof DNSHEClient) {
    const page = Number(cursor ?? 1);
    const res = await client.listSubdomains(page, 100);
    if (!res.success || !Array.isArray(res.subdomains) || res.subdomains.length > 100) throw incompleteResponse("dnshe");
    const p = res.pagination;
    if (p && (typeof p.has_more !== "boolean" || p.page !== undefined && p.page !== page || p.per_page !== undefined && p.per_page !== 100)) throw incompleteResponse("dnshe");
    if (p?.total !== undefined && res.total !== undefined && p.total !== res.total) throw incompleteResponse("dnshe");
    const raw = p?.total ?? res.total;
    const total = raw === undefined ? undefined : pageTotal("dnshe", raw, count, res.subdomains.length, expected);
    if (expected !== undefined && total === undefined) throw incompleteResponse("dnshe");
    const ended = p ? !p.has_more : total !== undefined ? count + res.subdomains.length === total : res.subdomains.length < 100;
    if (ended && total !== undefined && count + res.subdomains.length !== total || !ended && (!res.subdomains.length || res.subdomains.length !== 100) || p?.next_page !== undefined && !ended && p.next_page !== page + 1) throw incompleteResponse("dnshe");
    return { items: res.subdomains, total, next: ended ? null : page + 1 };
  }
  if (client instanceof CloudflareClient) {
    const page = Number(cursor ?? 1);
    const result = await client.listZones({ startPage: page, maxPages: 1, expectedTotal: expected });
    if (result.total !== undefined && !result.hasMore && count + result.zones.length !== result.total || result.hasMore && result.zones.length !== 50) throw incompleteResponse("cloudflare");
    return { items: result.zones.map(mapZoneToUpstream), total: result.total, next: result.hasMore ? page + 1 : null };
  }
  if (client instanceof DigitalPlatClient) return { items: (await client.listDomains()).map(mapDomainToUpstream), next: null };
  if (client instanceof DnspodClient) { const p = await client.listDomainsPage(Number(cursor ?? 0), expected); return { ...p, items: p.items.map(mapDnspodDomainToUpstream) }; }
  if (client instanceof AlidnsClient) { const p = await client.listDomainsPage(Number(cursor ?? 1), expected); return { ...p, items: p.items.map(mapAlidnsDomainToUpstream) }; }
  if (client instanceof HuaweiCloudClient) { const p = await client.listDomainsPage(Number(cursor ?? 0), expected); return { ...p, items: p.items.map(mapHuaweiZoneToUpstream) }; }
  if (client instanceof VercelClient) { const p = await client.listDomainsPage(cursor === undefined ? undefined : Number(cursor)); return { ...p, items: p.items.map(mapVercelDomainToUpstream) }; }
  throw new Error("不支持的同步服务商");
}
