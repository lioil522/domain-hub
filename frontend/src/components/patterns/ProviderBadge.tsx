import { BrandLogo } from "../BrandLogo";
import type { AccountProvider } from "../../types/account";

const LABELS: Record<AccountProvider, string> = {
  dnshe: "DNSHE",
  cloudflare: "Cloudflare",
  digitalplat: "DigitalPlat",
  dnspod: "DNSPod",
  alidns: "阿里云 DNS",
  huaweicloud: "华为云 DNS",
  vercel: "Vercel",
  custom: "自定义",
};

const SOURCE_FG: Record<AccountProvider, string> = {
  dnshe: "text-source-dnshe-fg",
  cloudflare: "text-source-cf-fg",
  digitalplat: "text-source-dp-fg",
  dnspod: "text-source-dnspod-fg",
  alidns: "text-source-alidns-fg",
  huaweicloud: "text-source-huawei-fg",
  vercel: "text-source-vercel-fg",
  custom: "text-source-custom-fg",
};

export function ProviderBadge({ provider, compact = false }: { provider: AccountProvider; compact?: boolean }) {
  const fgColor = SOURCE_FG[provider] || "text-content-secondary";
  return (
    <span className={compact ? `inline-flex items-center gap-1 text-[11px] font-medium ${fgColor}` : `inline-flex items-center gap-1.5 rounded-full border border-border-base bg-elevated px-2 py-1 text-xs font-medium ${fgColor}`}>
      <BrandLogo brand={provider} size={compact ? 12 : 14} className="shrink-0" />
      <span>{LABELS[provider]}</span>
    </span>
  );
}
