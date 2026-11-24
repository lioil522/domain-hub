// Read-only, full capture for the isolated prototype. This is not an
// incremental change journal and does not make capture CPU/heap bounded.
import { normalizeDomainKey } from "../../shared/domain-keys";
import type { DashboardStatsOptions, SummaryExpiry } from "../../shared/dashboard-stats";
import type { CatalogProvider } from "../../shared/domain-catalog";
import { DomainCatalogRepository } from "../../src/repositories/domain-catalog-repository";
import { SUMMARY_CACHE_MS } from "../../src/services/catalog-summary-cache";
import type { DatabaseManager } from "../../src/db";

export async function captureProjectionInput(db: DatabaseManager, now: number) {
  const repo = new DomainCatalogRepository(db);
  const revision = await repo.revision();
  const [rows, custom, accounts, dates] = await Promise.all([
    repo.projection(),
    db.allRaw<{ id: number; group_id: number; account_id: number | null; full_domain: string; expires_at: string }>(
      "SELECT id,group_id,account_id,full_domain,expires_at FROM custom_domains ORDER BY id"),
    repo.accounts(), repo.expiryMetadata(now),
  ]);
  let sourceValidUntil = now + SUMMARY_CACHE_MS;
  const expiry: Record<string, SummaryExpiry> = Object.create(null) as Record<string, SummaryExpiry>;
  for (const row of dates) {
    if (row.cache_expires_at !== null) sourceValidUntil = Math.min(sourceValidUntil, row.cache_expires_at * 1000);
    const key = normalizeDomainKey(row.full_domain);
    if (row.kind === "manual") expiry[key] = { found: false, manual: true, expires_at: row.expires_at || undefined };
    else {
      let parsed: unknown;
      try { parsed = JSON.parse(row.value || ""); } catch { continue; }
      const entry = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      // Non-string truthy expiry values are outside this prototype's admitted
      // metadata format. Reject, never silently coerce or discard original data.
      if (entry.expires_at && typeof entry.expires_at !== "string") throw new Error("Unsupported projection expiry metadata");
      expiry[key] = { found: Boolean(entry.found), manual: Boolean(entry.manual),
        expires_at: typeof entry.expires_at === "string" ? entry.expires_at : undefined };
    }
  }
  const managed = (provider: CatalogProvider) => rows.filter(row => row.provider === provider);
  const owners = (provider: CatalogProvider) => accounts.filter(row => row.provider === provider);
  const input: DashboardStatsOptions = {
    domains: managed("dnshe"), cfZones: managed("cloudflare"), dpDomains: managed("digitalplat"), customDomains: custom,
    multiProviderDomains: { dnspod: managed("dnspod"), alidns: managed("alidns"), huaweicloud: managed("huaweicloud"), vercel: managed("vercel") },
    dnsheAccounts: owners("dnshe"), cfAccountList: owners("cloudflare"), dpAccountList: owners("digitalplat"), customGroupList: owners("custom"),
    multiProviderAccounts: { dnspod: owners("dnspod"), alidns: owners("alidns"), huaweicloud: owners("huaweicloud"), vercel: owners("vercel") },
    cfExpiryMap: expiry,
  };
  if (await repo.revision() !== revision) throw new Error("Projection source changed during full capture");
  return { input, revision, sourceValidUntil, capture: { queryCalls: 6,
    inventoryRows: rows.length + custom.length, metadataRows: accounts.length + dates.length } };
}
