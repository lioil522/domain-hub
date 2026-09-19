/**
 * 域名的 NS / DNS 托管状态判定（Phase 4-B 从 App.tsx 抽出）
 *
 * WHY 单独成文件：这三个纯函数既被域名列表卡片（三态徽章、托管商标签）使用，
 * 也被 NS 设置弹窗使用。抽组件后若继续留在 App.tsx，会形成 `组件 ← App` 的
 * 反向依赖；它们本身不依赖任何组件状态，因此挪到中立模块，双方共同引用。
 *
 * 本文件只做「判定 + 展示标签」，不发起任何请求、不修改数据。
 */

import type { Domain } from "../types/domain";
import type { DnsRecord } from "../types/dns";

/**
 * 判断域名是否使用默认 NS（ns1.dnshe.com / ns2.dnshe.com）并允许在线 DNS 管理
 */
export const checkHasDns = (dom: Domain) => {
  if (dom.disable_ns_management) return false;
  if (dom.ns1 || dom.ns2) {
    const ns1 = (dom.ns1 || "").toLowerCase();
    const ns2 = (dom.ns2 || "").toLowerCase();
    if (!ns1.includes("dnshe.com") && !ns2.includes("dnshe.com")) return false;
  }
  if (dom.has_dns !== undefined && dom.has_dns !== null) {
    return Number(dom.has_dns) !== 0;
  }
  return true;
};

/*
 * 根据 NS 记录识别 DNS 托管商（返回可展示的字符串）
 *
 * ⚠️ 这是后端 src/dns-provider.ts 的**功能等价复制实现** —— 两份必须同步维护。
 * 后端那份决定入库的 dns_provider 与三态，这份决定列表徽章与筛选，改漏一边会
 * 表现为「库里认得出、界面显示外部 DNS」。新增托管商识别规则时两边一起改。
 */
export const detectDnsProvider = (nameservers: string[]): string => {
  const hosts = nameservers
    .map((value) => value.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  const matchesDomain = (host: string, domain: string) =>
    host === domain || host.endsWith(`.${domain}`);

  if (hosts.some((host) => matchesDomain(host, "vps8.zz.cd"))) return "vps8";
  if (hosts.some((host) => matchesDomain(host, "ns.cloudflare.com"))) return "Cloudflare";
  // 阿里云云解析：vip*.alidns.com / ns*.alidns.com
  if (hosts.some((host) => matchesDomain(host, "alidns.com"))) return "阿里云 DNS";
  // 华为云云解析：ns*.huaweicloud-dns.{com,cn,net} / ns*.hwclouds-dns.com
  if (hosts.some((host) =>
    matchesDomain(host, "huaweicloud-dns.com") ||
    matchesDomain(host, "huaweicloud-dns.cn") ||
    matchesDomain(host, "huaweicloud-dns.net") ||
    matchesDomain(host, "hwclouds-dns.com")
  )) return "华为云 DNS";
  if (hosts.some((host) =>
    matchesDomain(host, "dnspod.net") ||
    matchesDomain(host, "dnspod.com") ||
    matchesDomain(host, "dnsv.com") ||
    /(^|\.)dnsv[1-5]\.com$/.test(host)
  )) return "DNSPod";
  if (hosts.some((host) => matchesDomain(host, "vercel-dns.com"))) return "Vercel";
  return "外部 DNS";
};

export const getDnsProviderLabel = (dom: Domain, records?: DnsRecord[]): string => {
  if (checkHasDns(dom)) return "系统默认";
  if (records) {
    return detectDnsProvider(
      records.filter((record) => record.type === "NS").map((record) => String(record.content || ""))
    );
  }
  return dom.dns_provider && dom.dns_provider !== "external"
    ? dom.dns_provider
    : "外部 DNS";
};
