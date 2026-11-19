import type { CatalogSummary } from "../../shared/domain-catalog";
import { isCatalogSummaryResponse } from "../../shared/catalog-response";
import { parseCatalogDate } from "../../shared/dashboard-stats";
import type { DomainCatalogRepository } from "../repositories/domain-catalog-repository";

export const SUMMARY_CACHE_MS = 5 * 60_000;
const MAX_CACHE_BYTES = 524_288;
interface Envelope {
  format: 1;
  revision: string | null;
  offset: number;
  generated_at: number;
  valid_until: number;
  summary: CatalogSummary;
}
type Status = "hit" | "miss" | "bypass" | "joined";
interface CachedResult { envelope: Envelope; status: Status; }
// Only active work, scoped by binding/offset; no completed response stays in globals.
const active = new WeakMap<object, Map<number, { promise: Promise<CachedResult>; force: boolean }>>();

function decode(raw: string | null, now: number, offset: number): Envelope | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (row.format !== 1 || row.offset !== offset || !("revision" in row) ||
      !(row.revision === null || typeof row.revision === "string") ||
      typeof row.generated_at !== "number" || !Number.isFinite(row.generated_at) || row.generated_at < 0 || row.generated_at > now ||
      typeof row.valid_until !== "number" || !Number.isFinite(row.valid_until) || row.valid_until <= now ||
      row.valid_until <= row.generated_at || row.valid_until - row.generated_at > SUMMARY_CACHE_MS ||
      !isCatalogSummaryResponse({ success: true, summary: row.summary })) return null;
    return { format: 1, revision: row.revision, offset, generated_at: row.generated_at,
      valid_until: row.valid_until, summary: row.summary as CatalogSummary };
  } catch { return null; }
}

function age(value: Envelope, now: number): CatalogSummary {
  const elapsed = Math.max(0, now - value.generated_at) / 86400000;
  const data = value.summary;
  return {
    ...data, snapshot_at: value.generated_at, valid_until: value.valid_until,
    stats: { ...data.stats,
      expiring: data.stats.expiring.map(item => ({ ...item, daysLeft: item.daysLeft - elapsed })),
      timeline: { ...data.stats.timeline,
        buckets: data.stats.timeline.buckets.map(bucket => ({ ...bucket,
          items: bucket.items.map(item => ({ ...item, daysLeft: item.daysLeft - elapsed })),
        })),
      },
    },
  };
}

export function initialSummaryDeadline(now: number, offset: number) {
  const local = new Date(now - offset * 60_000);
  const nextMonth = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) + offset * 60_000;
  return Math.min(now + SUMMARY_CACHE_MS, nextMonth);
}
export function capSummaryDeadline(deadline: number, raw: unknown, now: number, offset: number) {
  if (typeof raw !== "string" || !raw || raw.startsWith("0000")) return deadline;
  const time = parseCatalogDate(raw, offset);
  // Expired uses strict time < now; invalidate one millisecond after the exact instant.
  for (const boundary of [time + 1, time - 90 * 86400000]) {
    if (Number.isFinite(boundary) && boundary > now) deadline = Math.min(deadline, boundary);
  }
  return deadline;
}

export async function cachedCatalogSummary(
  repo: DomainCatalogRepository, now: number, offset: number, force: boolean,
  build: () => Promise<{ summary: CatalogSummary; validUntil: number }>,
): Promise<{ summary: CatalogSummary; cache: Status }> {
  const binding = repo.cacheBinding();
  let slots = active.get(binding);
  if (!slots) { slots = new Map(); active.set(binding, slots); }
  const old = slots.get(offset);
  if (old && (!force || old.force)) {
    const result = await old.promise;
    if (result.envelope.generated_at <= now && result.envelope.valid_until > now) {
      return { summary: age(result.envelope, now), cache: "joined" };
    }
  } else if (old) {
    // An operator bypass must not join a non-forced cached response.
    await old.promise.catch(() => {});
  }
  const readOrBuild = async (): Promise<CachedResult> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!force) {
        const raw = await repo.cachedSummary(offset, now).catch(() => null);
        const value = decode(raw, now, offset);
        if (value) return { envelope: value, status: "hit" };
      }
      const revision = await repo.revision();
      const snapshot = await build();
      const envelope: Envelope = { format: 1, revision, offset, generated_at: now,
        valid_until: snapshot.validUntil, summary: snapshot.summary };
      const serialized = JSON.stringify(envelope);
      let consistent: boolean;
      if (new TextEncoder().encode(serialized).byteLength > MAX_CACHE_BYTES) {
        consistent = (await repo.revision()) === revision;
      } else {
        try { consistent = await repo.storeSummary(offset, serialized, revision, snapshot.validUntil); }
        catch { consistent = (await repo.revision()) === revision; } // Derived storage is optional; version is not.
      }
      if (consistent) return { envelope, status: force ? "bypass" : "miss" };
    }
    throw new Error("Inventory changed repeatedly while building its summary; retry later");
  };
  const entry = { promise: readOrBuild(), force };
  slots.set(offset, entry);
  try {
    const result = await entry.promise;
    return { summary: age(result.envelope, now), cache: result.status };
  } finally {
    if (slots.get(offset) === entry) slots.delete(offset);
  }
}
