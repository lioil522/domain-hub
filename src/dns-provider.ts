export type DnsProvider =
  | "system"
  | "Cloudflare"
  | "DNSPod"
  | "Vercel"
  | "vps8"
  | "DigitalPlat"
  | "Aliyun"
  | "HuaweiCloud"
  | "external";

function normalizeNameserver(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * 根据域名当前委派的 NS 地址识别 DNS 托管商。
 *
 * NOTE: vps8 使用的是自有 NS 域名，优先于通用服务商规则匹配。
 *
 * ⚠️ 前端 App.tsx 里有一份**功能等价的复制实现**（detectDnsProvider，返回中文字符串
 * 如「外部 DNS」）。新增识别规则时两边必须同步修改 —— 后端这份决定入库的 dns_provider
 * 与三态，前端那份决定列表徽章与筛选，改漏一边会表现为「库里认得出、界面显示外部 DNS」。
 */
export function detectDnsProvider(nameservers: string[]): DnsProvider {
  const hosts = nameservers.map(normalizeNameserver).filter(Boolean);

  if (hosts.length === 0 || hosts.every((host) => matchesDomain(host, "dnshe.com"))) {
    return "system";
  }

  if (hosts.some((host) => matchesDomain(host, "vps8.zz.cd"))) {
    return "vps8";
  }

  // NOTE: DigitalPlat Hosted DNS 的权威 NS 是 dns1/dns2.digitalplat.org，
  // 供 DigitalPlat 域名行的托管商识别（mapDomainToUpstream 消费）。
  if (hosts.some((host) => matchesDomain(host, "digitalplat.org"))) {
    return "DigitalPlat";
  }

  if (hosts.some((host) => matchesDomain(host, "ns.cloudflare.com"))) {
    return "Cloudflare";
  }

  // NOTE: 阿里云云解析的权威 NS 是 vip*.alidns.com / ns*.alidns.com（* 是 1~3 位数字）。
  // 用 matchesDomain 匹配 "alidns.com" 即可覆盖全部形态，无需枚举序号。
  if (hosts.some((host) => matchesDomain(host, "alidns.com"))) {
    return "Aliyun";
  }

  // NOTE: 华为云云解析的权威 NS 形如 ns1.huaweicloud-dns.com / ns1.huaweicloud-dns.cn /
  // ns1.huaweicloud-dns.net（三个顶级域并存），以及部分区域的 ns1.hwclouds-dns.com。
  if (hosts.some((host) =>
    matchesDomain(host, "huaweicloud-dns.com") ||
    matchesDomain(host, "huaweicloud-dns.cn") ||
    matchesDomain(host, "huaweicloud-dns.net") ||
    matchesDomain(host, "hwclouds-dns.com")
  )) {
    return "HuaweiCloud";
  }

  if (hosts.some((host) =>
    matchesDomain(host, "dnspod.net") ||
    matchesDomain(host, "dnspod.com") ||
    matchesDomain(host, "dnsv.com") ||
    /(^|\.)dnsv[1-5]\.com$/.test(host)
  )) {
    return "DNSPod";
  }

  if (hosts.some((host) => matchesDomain(host, "vercel-dns.com"))) {
    return "Vercel";
  }

  return "external";
}

/**
 * 由域名区域内的解析记录推导出缓存所需的三态与托管商信息。
 *
 * NOTE: 域名三态（已委派 / 已解析 / 未解析）只能由真实解析记录推导出来，
 * 上游 subdomains/list 接口返回的 status 只有 active 之类的注册态。
 * 所有写入 domains_cache 的调用方都必须经过这里，dns_state_known 是
 * 「本次确实拿到了解析记录」的凭证 —— 缺少它时 syncAccountDomains
 * 会保留数据库里已有的三态，避免把「已委派」误刷成「已解析」。
 */
export interface DnsState {
  status: "已委派" | "已解析" | "未解析";
  has_dns: number;
  dns_provider: DnsProvider;
  dns_state_known: true;
}

export function computeDnsState(records: Array<{ type?: string; content?: unknown }>): DnsState {
  const dnsProvider = detectDnsProvider(
    records.filter((record) => record.type === "NS").map((record) => String(record.content || ""))
  );

  if (dnsProvider !== "system") {
    return { status: "已委派", has_dns: 0, dns_provider: dnsProvider, dns_state_known: true };
  }
  if (records.length > 0) {
    return { status: "已解析", has_dns: 1, dns_provider: dnsProvider, dns_state_known: true };
  }
  return { status: "未解析", has_dns: 1, dns_provider: dnsProvider, dns_state_known: true };
}
