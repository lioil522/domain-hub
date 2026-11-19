import { CATALOG_PROVIDERS } from "./domain-catalog";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function isCatalogPageResponse(value: unknown): boolean {
  return record(value) && value.success === true &&
    Array.isArray(value.domains) && Array.isArray(value.custom_domains) &&
    value.domains.length + value.custom_domains.length <= 100 &&
    value.domains.every(row => record(row) && count(row.id) && count(row.account_id) && typeof row.full_domain === "string" && typeof row.expires_at === "string") &&
    value.custom_domains.every(row => record(row) && count(row.id) && count(row.group_id) && typeof row.full_domain === "string" && typeof row.expires_at === "string") &&
    count(value.total) && (value.next_cursor === null || typeof value.next_cursor === "string") &&
    record(value.account_counts) && record(value.hints);
}
export function isCatalogSummaryResponse(value: unknown): boolean {
  if (!record(value) || value.success !== true || !record(value.summary)) return false;
  const summary = value.summary, stats = summary.stats, providers = summary.provider_counts;
  return record(stats) && count(stats.total) && count(stats.active) && count(stats.expired) && count(stats.accounts) &&
    Array.isArray(stats.recent) && stats.recent.length <= 6 && stats.recent.every(row => record(row) && typeof row.full_domain === "string" && typeof row.source === "string") &&
    Array.isArray(stats.expiring) && stats.expiring.length <= 8 && stats.expiring.every(row => record(row) && typeof row.full_domain === "string" && typeof row.source === "string" && typeof row.daysLeft === "number") &&
    record(stats.timeline) && Array.isArray(stats.timeline.buckets) && stats.timeline.buckets.length === 12 &&
    stats.timeline.buckets.every(bucket => record(bucket) && count(bucket.count) && Array.isArray(bucket.items) && bucket.items.length <= 20 &&
      bucket.items.every(row => record(row) && typeof row.full_domain === "string" && typeof row.source === "string" && typeof row.daysLeft === "number")) &&
    count(stats.timeline.scheduledTotal) && count(stats.timeline.permanentCount) && count(stats.timeline.overdueCount) &&
    record(providers) && CATALOG_PROVIDERS.every(provider => count(providers[provider])) &&
    record(summary.account_counts) && Array.isArray(summary.root_domains);
}
export function isCatalogSearchResponse(value: unknown): boolean {
  if (!record(value) || value.success !== true || !record(value.result) || !record(value.result.groups)) return false;
  const groups = value.result.groups;
  return typeof value.result.query === "string" && CATALOG_PROVIDERS.every(provider => {
    const group = groups[provider];
    return record(group) && count(group.total) && Array.isArray(group.items) && group.items.length <= 8 &&
      group.items.every(row => record(row) && count(row.id) && typeof row.full_domain === "string");
  });
}
