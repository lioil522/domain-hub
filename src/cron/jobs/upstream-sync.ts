/**
 * 上游域名拉取与分页辅助函数
 */

import type { UpstreamSubdomain, UpstreamClient, AccountProvider } from "../../db";
import type { SubdomainInfo, OffsetPagination } from "../../dnshe";
import { incompleteResponse } from "../../errors/provider-api-error";
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
    pagination?: OffsetPagination;
  }>;
}

/**
 * 分页拉取某个账号下的全部子域名 (DNSHE)
 */
export async function fetchAllSubdomainsFromClient(client: SubdomainClient): Promise<SubdomainInfo[]> {
  const allSubdomains: SubdomainInfo[] = [];
  const perPage = 500;
  let page = 1;
  const ids = new Set<number>();

  for (let guard = 0; guard < 50; guard++) {
    const res = await client.listSubdomains(page, perPage);
    if (!res || !res.success || !Array.isArray(res.subdomains)) {
      throw new Error(res?.message || "响应数据格式错误");
    }

    for (const sub of res.subdomains) {
      if (!Number.isSafeInteger(sub.id) || !sub.full_domain || ids.has(sub.id)) throw incompleteResponse("dnshe");
      ids.add(sub.id);
      allSubdomains.push(sub);
    }
    const p = res.pagination;
    if (p && (typeof p.has_more !== "boolean" || (p.page !== undefined && p.page !== page))) throw incompleteResponse("dnshe");
    const total = p?.total ?? res.total;
    if ((total !== undefined && (!Number.isSafeInteger(total) || total < 0)) ||
      (p?.total !== undefined && res.total !== undefined && p.total !== res.total)) throw incompleteResponse("dnshe");
    const finished = p ? !p.has_more : total !== undefined ? allSubdomains.length >= total : res.subdomains.length < perPage;
    if (finished) {
      if (total !== undefined && allSubdomains.length !== total) throw incompleteResponse("dnshe");
      return allSubdomains;
    }
    const next = p?.next_page ?? page + 1;
    if (!res.subdomains.length || !Number.isSafeInteger(next) || next !== page + 1) throw incompleteResponse("dnshe");
    page = next;
  }

  throw incompleteResponse("dnshe", "DNSHE 域名分页达到安全上限，同步未执行删除");
}
