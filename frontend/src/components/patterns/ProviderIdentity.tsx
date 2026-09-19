import type { Account } from "../../types/account";
import { ProviderBadge } from "./ProviderBadge";

export function ProviderIdentity({ account, domainCount, compact = true }: { account: Account; domainCount?: number; compact?: boolean }) {
  const provider = account.provider ?? "dnshe";
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderBadge provider={provider} compact={compact} />
        <span className="truncate font-semibold text-content-primary" title={account.alias}>{account.alias}</span>
      </div>
      {domainCount !== undefined && (
        <div className="mt-0.5 text-[11px] text-content-muted">{domainCount} 个域名</div>
      )}
    </div>
  );
}
