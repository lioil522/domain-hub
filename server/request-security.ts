import { BlockList, isIP } from "node:net";
import { normalizeIp, parseOrigin, type RequestSecurity } from "../src/middleware/request-security";

export interface NodeNetworkPolicy { trusted: BlockList; publicOrigin?: string; }
export function nodeNetworkPolicy(trustedProxies?: string, publicOrigin?: string): NodeNetworkPolicy {
  const trusted = new BlockList();
  const entries = (trustedProxies || "").split(",").map(value => value.trim()).filter(Boolean);
  if ((trustedProxies || "").length > 16384 || entries.length > 64) throw new Error("TRUSTED_PROXIES 超过配置长度上限");
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split("/");
    const version = isIP(address), type = version === 4 ? "ipv4" : "ipv6";
    if (!version || extra !== undefined || (prefix !== undefined &&
      (!/^\d{1,3}$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)))) {
      throw new Error("TRUSTED_PROXIES 只支持明确的 IP 或 CIDR，不能使用通配符或主机名");
    }
    if (prefix === undefined) trusted.addAddress(address, type);
    else trusted.addSubnet(address, Number(prefix), type);
  }
  const origin = publicOrigin ? parseOrigin(publicOrigin) : undefined;
  if (publicOrigin && !origin) throw new Error("PUBLIC_ORIGIN 必须是明确的 HTTP(S) 来源，不能包含路径");
  return { trusted, publicOrigin: origin || undefined };
}

export function nodeRequestSecurity(request: Request, remoteAddress: string | undefined, policy: NodeNetworkPolicy): RequestSecurity {
  const peer = normalizeIp(remoteAddress);
  const isTrusted = (ip: string) => policy.trusted.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
  let clientIp = peer || "unknown";
  const header = request.headers.get("X-Forwarded-For");
  if (peer && isTrusted(peer) && header && header.length <= 4096) {
    const hops = header.split(",").map(normalizeIp);
    if (hops.length <= 32 && hops.every((hop): hop is string => hop !== null)) {
      // Walk from the connected peer toward the client; stop at the first
      // untrusted hop. Never blindly take a spoofable leftmost value.
      for (let i = hops.length - 1; i >= 0 && isTrusted(clientIp); i--) clientIp = hops[i];
    }
  }
  // Do not infer an HTTPS public origin from Forwarded/X-Forwarded-* headers.
  return { clientIp, origin: policy.publicOrigin || new URL(request.url).origin };
}
