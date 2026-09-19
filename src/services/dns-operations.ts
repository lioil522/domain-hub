import { DatabaseManager, DBDomain, UpstreamClient } from "../db";
import { DNSHEClient } from "../dnshe";
import { CloudflareClient } from "../cloudflare";
import { DigitalPlatClient } from "../digitalplat";
import { DnspodClient } from "../dnspod";
import { AlidnsClient } from "../alidns";
import { HuaweiCloudClient } from "../huaweicloud";
import { VercelClient } from "../vercel";
import { computeDnsState } from "../dns-provider";
import { toASCII } from "../punycode";

export function resolveDnsRemoteId(client: UpstreamClient, domainInfo: DBDomain): string | number {
    if (client instanceof CloudflareClient) {
      return String(domainInfo.remote_id || "");
    }
    if (client instanceof HuaweiCloudClient) {
      return String(domainInfo.remote_id || "");
    }
    if (
      client instanceof DigitalPlatClient ||
      client instanceof DnspodClient ||
      client instanceof AlidnsClient ||
      client instanceof VercelClient
    ) {
      return String(domainInfo.remote_id || domainInfo.full_domain);
    }
    return domainInfo.id;
  }

  /**
   * 该域名行是否属于「非 DNSHE」托管商（三态语义不适用，改由各自标签页渲染状态）
   *
   * NOTE: 用于 syncDomainStatusAfterDnsChange —— CF / 华为云恒为「已解析」，其余
   * 非 DNSHE 托管商保持注册态/上游态不变（只回填记录缓存）。
   */
export function isNonDnsheProvider(client: UpstreamClient): boolean {
    return !(client instanceof DNSHEClient);
  }


export function normalizeDnsRecordName(rawName: string, fullDomain: string): string {
    const trimmed = String(rawName || "").trim().replace(/\.+$/, "");
    if (!trimmed || trimmed === "@") {
      return "@";
    }

    const name = toASCII(trimmed).toLowerCase();
    const base = toASCII(String(fullDomain || "").trim()).toLowerCase().replace(/\.+$/, "");
    if (!base) {
      return name;
    }
    if (name === base) {
      return "@";
    }
    if (name.endsWith(`.${base}`)) {
      return name.slice(0, -(base.length + 1)) || "@";
    }
    return name;
  }

  /**
   * DNS 写操作错误翻译
   *
   * NOTE: DNSHE 上游 API 在 disable_ns_management 开关禁用时，会直接拒绝 NS 类型
   * 记录的写入并返回 403，此处翻译为更友好的中文提示。创建 / 修改 / 批量创建共用。
   */
export function translateDnsWriteError(raw: string, type?: unknown): { message: string; errorCode: string } {
    const isNsType = String(type || "").toUpperCase() === "NS";
    const is403 = raw.includes("403") || raw.includes("Forbidden");
    if (isNsType && is403) {
      return {
        message: "DNSHE 上游平台已禁用 NS 管理功能 (disable_ns_management)，无法通过 API 修改 NS 记录。请前往 DNSHE 官网后台手动设置。",
        errorCode: "ns_management_disabled",
      };
    }
    return { message: raw, errorCode: "internal_error" };
  }

  // 辅助函数：DNS 记录变更后，自动重新计算并同步更新域名的三态 (已委派 / 已解析 / 未解析)
export async function syncDomainStatusAfterDnsChange(dbManager: DatabaseManager, client: UpstreamClient, domainInfo: DBDomain) {
    try {
      const remoteId = resolveDnsRemoteId(client, domainInfo);
      const dnsRes = await client.listDnsRecords(remoteId);
      const records = (dnsRes && dnsRes.success && Array.isArray(dnsRes.records)) ? dnsRes.records : [];

      // 写操作回源后，将最新记录回填到缓存，后续读操作直接命中
      await dbManager.setCache(`api_cache:dns:${domainInfo.id}`, JSON.stringify(records));

      if (client instanceof CloudflareClient) {
        // Cloudflare 托管的 zone：apex NS 记录必然指向 *.ns.cloudflare.com，computeDnsState
        // 会把它误判成「已委派」。这些行由绑定的 CF 账号直接管理，固定写「已解析」。
        await dbManager.updateDomainStatusAndDns(domainInfo.id, "已解析", 1, "Cloudflare");
      } else if (client instanceof HuaweiCloudClient) {
        // 华为云同理：zone 的 NS 必然指向华为云自己的 NS，固定写「已解析 + HuaweiCloud」
        await dbManager.updateDomainStatusAndDns(domainInfo.id, "已解析", 1, "HuaweiCloud");
      } else if (isNonDnsheProvider(client)) {
        // DigitalPlat / DNSPod / 阿里云 / Vercel 行的 status 是上游侧的状态字（注册态或
        // 服务状态），不由解析记录推导三态；记录缓存已在上面回填，状态保持不变。
      } else {
        const { status, has_dns, dns_provider } = computeDnsState(records);
        await dbManager.updateDomainStatusAndDns(domainInfo.id, status, has_dns, dns_provider);
      }
    } catch (e) {
      console.error(`域名状态实时更新异常 [domain_id: ${domainInfo.id}]:`, e);
    }
  }

