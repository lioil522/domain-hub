/**
 * 上游域名拉取与分页辅助函数
 */

import type { UpstreamSubdomain, UpstreamClient, AccountProvider } from "../../db";
import type { SubdomainInfo } from "../../dnshe";
import { DnspodClient, mapDnspodDomainToUpstream } from "../../dnspod";
import { AlidnsClient, mapAlidnsDomainToUpstream } from "../../alidns";
import { HuaweiCloudClient, mapHuaweiZoneToUpstream } from "../../huaweicloud";
import { VercelClient, mapVercelDomainToUpstream } from "../../vercel";

/** 无需续期与到期提醒的 provider —— 它们只托管解析，域名注册有效期不在其 API 范围内 */
export const PARSE_ONLY_PROVIDERS: readonly AccountProvider[] = [
  "dnspod",
  "alidns",
  "huaweicloud",
  "vercel",
];

/**
 * 拉取「只托管解析」类托管商的域名列表并归一化为上游行
 */
export async function listUpstreamDomains(client: UpstreamClient): Promise<UpstreamSubdomain[]> {
  if (client instanceof DnspodClient) {
    return (await client.listDomains()).map(mapDnspodDomainToUpstream);
  }
  if (client instanceof AlidnsClient) {
    return (await client.listDomains()).map(mapAlidnsDomainToUpstream);
  }
  if (client instanceof HuaweiCloudClient) {
    return (await client.listDomains()).map(mapHuaweiZoneToUpstream);
  }
  if (client instanceof VercelClient) {
    return (await client.listDomains()).map(mapVercelDomainToUpstream);
  }
  throw new Error("该账号提供商不支持 listUpstreamDomains");
}

export interface SubdomainClient {
  listSubdomains(
    page: number,
    perPage: number
  ): Promise<{
    success?: boolean;
    subdomains?: SubdomainInfo[];
    total?: number;
    message?: string;
  }>;
}

/**
 * 分页拉取某个账号下的全部子域名 (DNSHE)
 */
export async function fetchAllSubdomainsFromClient(client: SubdomainClient): Promise<SubdomainInfo[]> {
  const allSubdomains: SubdomainInfo[] = [];
  const perPage = 500;
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const res = await client.listSubdomains(page, perPage);
    if (!res || !res.success || !Array.isArray(res.subdomains)) {
      throw new Error(res?.message || "响应数据格式错误");
    }

    allSubdomains.push(...res.subdomains);

    if (res.subdomains.length < perPage) {
      hasMore = false;
    } else if (res.total !== undefined && allSubdomains.length >= res.total) {
      hasMore = false;
    } else {
      page++;
    }

    if (page > 50) {
      console.error("Pagination safety limit reached (50 pages), stopping.");
      break;
    }
  }

  return allSubdomains;
}
