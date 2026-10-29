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
    count?: number;
    pagination?: { has_more?: boolean; next_page?: number | null; total?: number };
    total?: number;
    message?: string;
  }>;
}

/**
 * 分页拉取某个账号下的全部子域名 (DNSHE)
 *
 * NOTE: 实测响应顶层**没有** `total`，总页信息在 `pagination`：
 *   { mode:"offset", page, per_page, has_more, total }
 * 早期实现读 `res.total` 判断是否到底，那个分支永远不生效，全靠
 * `subdomains.length < perPage` 兜底 —— 一旦某账号域名数恰为 per_page 的整数倍，
 * 会多打一次空页请求（多消耗一次本就紧张的限流额度）。
 *
 * 现在优先信 `pagination.has_more`，其次 `pagination.total`，最后才用长度兜底。
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

    const pagination = res.pagination;
    if (pagination && typeof pagination.has_more === "boolean") {
      // 权威信号：服务端明确告知是否还有下一页
      hasMore = pagination.has_more;
      if (hasMore) page = Number(pagination.next_page) || page + 1;
    } else if (typeof pagination?.total === "number" || typeof res.total === "number") {
      // 兼容老版本：按总数判断
      const total = Number(pagination?.total ?? res.total);
      hasMore = allSubdomains.length < total;
      if (hasMore) page++;
    } else {
      // 最后兜底：返回不足一页即认为到底
      hasMore = res.subdomains.length >= perPage;
      if (hasMore) page++;
    }

    // 安全保护：最多拉取 50 页（25000 条），防止无限循环
    if (page > 50) {
      console.error("Pagination safety limit reached (50 pages), stopping.");
      break;
    }
  }

  return allSubdomains;
}
