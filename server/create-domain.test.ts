import assert from "node:assert/strict";
import { DnspodClient, mapDnspodDomainToUpstream } from "../src/dnspod";
import { CloudflareClient, mapZoneToUpstream } from "../src/cloudflare";
import { AlidnsClient, mapAlidnsDomainToUpstream } from "../src/alidns";
import { HuaweiCloudClient, mapHuaweiZoneToUpstream } from "../src/huaweicloud";
import { VercelClient, mapVercelDomainToUpstream } from "../src/vercel";
import { LegacyDomainProviderAdapter } from "../src/providers/domain/legacy-client-adapter";

console.log("多服务商添加域名 (CreateDomain) 单元测试开始...");

// 1. DNSPod
{
  const client = new DnspodClient("AKIDtest", "testkey");
  let capturedAction = "";
  let capturedBody: any = null;

  (client as any).request = async (action: string, params: any) => {
    capturedAction = action;
    capturedBody = params;
    if (action === "CreateDomain") {
      return {
        DomainInfo: {
          DomainId: 888899,
          Domain: params.Domain,
          Grade: "DPG_FREE",
        },
      };
    }
    if (action === "DescribeDomain") {
      return {
        DomainInfo: {
          DomainId: 888899,
          Name: params.Domain,
          NameServers: ["a.dnspod.com", "b.dnspod.com"],
        },
      };
    }
    throw new Error(`Unexpected action: ${action}`);
  };

  const adapter = new LegacyDomainProviderAdapter("dnspod", client);
  const res = await adapter.createDomain("sub.example.com");
  assert.equal(res.success, true);
  assert.equal(res.data?.domain.full_domain, "sub.example.com");
  assert.equal(res.data?.domain.rootdomain, "sub.example.com");
  assert.deepEqual(res.data?.nameservers, ["a.dnspod.com", "b.dnspod.com"]);
  assert.equal(capturedBody.Domain, "sub.example.com");
  console.log("  ✓ DNSPod createDomain 支持添加子域，且成功解析并映射 NS");
}

// 1.1 DNSPod 子域遇 TXT 校验场景
{
  const client = new DnspodClient("AKIDtest", "testkey");
  (client as any).request = async (action: string) => {
    if (action === "CreateDomain") {
      throw new Error("InvalidParameter.QuhuiTxtRecordWait: TXT record not set or haven't taken effect. Retry later..");
    }
    if (action === "CreateSubdomainValidateTXTValue") {
      return {
        Value: "7bdae520773783feb0c9e352846ff33b",
      };
    }
    throw new Error(`Unexpected action: ${action}`);
  };

  const adapter = new LegacyDomainProviderAdapter("dnspod", client);
  const res = await adapter.createDomain("lvl.cn.mt");
  assert.equal(res.success, false);
  assert.equal(res.need_txt_verify, true);
  assert.equal(res.verify_info?.host, "_dnspodcheck");
  assert.equal(res.verify_info?.type, "TXT");
  assert.equal(res.verify_info?.parent_domain, "cn.mt");
  assert.equal(res.verify_info?.value, "7bdae520773783feb0c9e352846ff33b");
  console.log("  ✓ DNSPod 子域名遇 QuhuiTxtRecordWait 时正确提取 TXT 专属授权校验结构");
}

// 2. Cloudflare
{
  const client = new CloudflareClient("cftoken123");
  let capturedPath = "";
  let capturedBody: any = null;

  (client as any).request = async (method: string, path: string, query: any, body: any) => {
    capturedPath = path;
    capturedBody = body;
    if (path === "/accounts") {
      return [{ id: "acc_cf_1", name: "My Account" }];
    }
    if (path === "/zones" && method === "POST") {
      return {
        id: "zone_cf_123",
        name: body.name,
        status: "pending",
        name_servers: ["amy.ns.cloudflare.com", "bob.ns.cloudflare.com"],
      };
    }
    throw new Error(`Unexpected path: ${path}`);
  };

  const adapter = new LegacyDomainProviderAdapter("cloudflare", client);
  const res = await adapter.createDomain("example.org");
  assert.equal(res.success, true);
  assert.equal(res.data?.domain.full_domain, "example.org");
  assert.equal(res.data?.domain.remote_id, "zone_cf_123");
  assert.deepEqual(res.data?.nameservers, ["amy.ns.cloudflare.com", "bob.ns.cloudflare.com"]);
  assert.equal(capturedBody.account.id, "acc_cf_1");
  console.log("  ✓ Cloudflare createZone 自动关联可用账号并返回待激活 NS");
}

// 3. 阿里云 DNS
{
  const client = new AlidnsClient("LTAItest", "aliyunsecret");
  let capturedAction = "";
  let capturedParams: any = null;

  (client as any).requestXml = async (action: string, params: any) => {
    capturedAction = action;
    capturedParams = params;
    if (action === "AddDomain") {
      return `<AddDomainResponse>
        <DomainId>ali_dom_001</DomainId>
        <DomainName>${params.DomainName}</DomainName>
        <DnsServers>
          <DnsServer>dns1.hichina.com</DnsServer>
          <DnsServer>dns2.hichina.com</DnsServer>
        </DnsServers>
      </AddDomainResponse>`;
    }
    throw new Error(`Unexpected action: ${action}`);
  };

  const adapter = new LegacyDomainProviderAdapter("alidns", client);
  const res = await adapter.createDomain("corp.myaliyun.com");
  assert.equal(res.success, true);
  assert.equal(res.data?.domain.full_domain, "corp.myaliyun.com");
  assert.deepEqual(res.data?.nameservers, ["dns1.hichina.com", "dns2.hichina.com"]);
  assert.equal(capturedParams.DomainName, "corp.myaliyun.com");
  console.log("  ✓ 阿里云 DNS AddDomain 正确提取 XML 中的 DnsServers");
}

// 4. 华为云 DNS
{
  const client = new HuaweiCloudClient("hw_ak", "hw_sk");
  let capturedPath = "";
  let capturedBody: any = null;

  (client as any).request = async (method: string, path: string, options: any) => {
    capturedPath = path;
    capturedBody = options?.body;
    if (path === "/v2/zones" && method === "POST") {
      return {
        id: "hw_zone_abc",
        name: capturedBody.name,
        zone_type: "public",
        status: "ACTIVE",
        nameservers: ["ns1.hwclouds-dns.com", "ns1.hwclouds-dns.net"],
      };
    }
    throw new Error(`Unexpected path: ${path}`);
  };

  const adapter = new LegacyDomainProviderAdapter("huaweicloud", client);
  const res = await adapter.createDomain("dev.huawei.net");
  assert.equal(res.success, true);
  assert.equal(res.data?.domain.full_domain, "dev.huawei.net");
  assert.equal(capturedBody.name, "dev.huawei.net."); // 必须自动补齐尾点
  assert.equal(capturedBody.zone_type, "public");
  assert.deepEqual(res.data?.nameservers, ["ns1.hwclouds-dns.com", "ns1.hwclouds-dns.net"]);
  console.log("  ✓ 华为云 createZone 自动追加尾点 . 并返回公共 Zone");
}

// 5. Vercel
{
  const client = new VercelClient("vercel_token_xyz");
  let capturedBody: any = null;

  (client as any).request = async (method: string, path: string, options: any) => {
    capturedBody = options?.body;
    if (path === "/v5/domains" && method === "POST") {
      return {
        domain: {
          name: capturedBody.name,
          serviceType: "external",
        },
      };
    }
    throw new Error(`Unexpected path: ${path}`);
  };

  const adapter = new LegacyDomainProviderAdapter("vercel", client);
  const res = await adapter.createDomain("blog.vercel-app.site");
  assert.equal(res.success, true);
  assert.equal(res.data?.domain.full_domain, "blog.vercel-app.site");
  assert.equal(capturedBody.name, "blog.vercel-app.site");
  console.log("  ✓ Vercel createDomain 正常添加域名");
}

console.log("\n全部多服务商添加域名测试通过！");
