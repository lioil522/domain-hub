import type { DBDomain, UpstreamClient, UpstreamSubdomain } from "../../db";
import { CloudflareClient } from "../../cloudflare";
import { DigitalPlatClient } from "../../digitalplat";
import { DNSHEClient } from "../../dnshe";
import { DnspodClient, mapDnspodDomainToUpstream } from "../../dnspod";
import { AlidnsClient, mapAlidnsDomainToUpstream } from "../../alidns";
import { HuaweiCloudClient, mapHuaweiZoneToUpstream } from "../../huaweicloud";
import { VercelClient, mapVercelDomainToUpstream } from "../../vercel";
import { getProviderDefinition } from "../registry";
import type { AccountProvider } from "../../db";
import type { DomainProviderAdapter, DomainOperationResult } from "./types";

export class LegacyDomainProviderAdapter implements DomainProviderAdapter {
  constructor(private readonly provider: AccountProvider, private readonly client: UpstreamClient) {}

  get id() { return this.provider; }
  get label() { return getProviderDefinition(this.provider).label; }

  async listDomains(client: UpstreamClient): Promise<UpstreamSubdomain[]> {
    if (client instanceof DnspodClient) return (await client.listDomains()).map(mapDnspodDomainToUpstream);
    if (client instanceof AlidnsClient) return (await client.listDomains()).map(mapAlidnsDomainToUpstream);
    if (client instanceof HuaweiCloudClient) return (await client.listDomains()).map(mapHuaweiZoneToUpstream);
    if (client instanceof VercelClient) return (await client.listDomains()).map(mapVercelDomainToUpstream);
    throw new Error("该账号提供商不支持统一域名列表适配器");
  }

  async renew(domain: DBDomain): Promise<DomainOperationResult<{ newExpiresAt?: string }>> {
    if (!(this.client instanceof DNSHEClient)) {
      return { success: false, message: `${this.label} 域名不通过本面板续期，请前往 ${this.label} 平台管理有效期` };
    }
    const response = await this.client.renewSubdomain(domain.id);
    if (!response?.success) return { success: false, message: response?.message || "续期请求失败" };
    return { success: true, data: { newExpiresAt: response.new_expires_at || "" } };
  }

  async delete(domain: DBDomain): Promise<DomainOperationResult<{ pendingDelete?: boolean }>> {
    if (this.client instanceof CloudflareClient) {
      return { success: false, message: "Cloudflare 域名不支持在本面板删除，请前往 Cloudflare 控制台操作" };
    }
    if (this.client instanceof DigitalPlatClient) {
      await this.client.deleteDomain(domain.full_domain);
      return { success: true, data: { pendingDelete: true }, message: "域名已提交删除，进入 pendingdelete 状态（DNS 已停用，7 天后正式释放）" };
    }
    if (this.client instanceof DnspodClient || this.client instanceof AlidnsClient || this.client instanceof HuaweiCloudClient || this.client instanceof VercelClient) {
      return { success: false, message: `${this.label} 在本面板仅托管解析记录，不支持删除域名（该操作需在域名注册商或 ${this.label} 控制台完成）` };
    }
    if (this.client instanceof DNSHEClient) {
      const response = await this.client.deleteSubdomain(domain.id);
      if (response?.success) return { success: true, data: { pendingDelete: false } };
      return { success: false, message: response?.message || "域名删除失败" };
    }
    return { success: false, message: "该服务商不支持删除域名" };
  }

  async listDnsRecords(domain: DBDomain): Promise<DomainOperationResult<{ records: unknown[] }>> {
    if (this.client instanceof DNSHEClient || this.client instanceof CloudflareClient || this.client instanceof DigitalPlatClient || this.client instanceof DnspodClient || this.client instanceof AlidnsClient || this.client instanceof HuaweiCloudClient || this.client instanceof VercelClient) {
      const response = await this.client.listDnsRecords(domain.remote_id || domain.id);
      return { success: Boolean(response?.success), message: response?.message, data: { records: response?.records || [] } };
    }
    return { success: false, message: "该服务商不支持 DNS 查询", data: { records: [] } };
  }

  async getNameservers(domain: DBDomain): Promise<DomainOperationResult<{ nameservers: string[] }>> {
    if (!(this.client instanceof DigitalPlatClient)) {
      return { success: false, message: "仅 DigitalPlat 域名支持在此查询 NS，请前往对应平台管理" };
    }
    const nameservers = await this.client.getDomainNameservers(String(domain.remote_id || domain.full_domain));
    return { success: true, data: { nameservers } };
  }

  async updateNameservers(domain: DBDomain, nameservers: string[]): Promise<DomainOperationResult<{ nameservers: string[] }>> {
    if (!(this.client instanceof DigitalPlatClient)) {
      return { success: false, message: "仅 DigitalPlat 域名支持在此修改 NS，请前往对应平台管理" };
    }
    await this.client.updateNameservers(String(domain.remote_id || domain.full_domain), nameservers);
    return { success: true, data: { nameservers } };
  }
  async registerSubdomain(subdomain: string, rootdomain: string): Promise<DomainOperationResult<{ full_domain: string; subdomain_id: number }>> {
    if (!(this.client instanceof DNSHEClient)) return { success: false, message: "仅 DNSHE 账号支持在线注册子域名" };
    const result = await this.client.registerSubdomain(subdomain, rootdomain);
    if (!result?.success || !result?.subdomain_id) return { success: false, message: result?.message || "注册子域名失败" };
    return { success: true, message: result.message, data: { full_domain: result.full_domain || `${subdomain}.${rootdomain}`, subdomain_id: result.subdomain_id } };
  }

}
