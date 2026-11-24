// An isolated fixed-input/fixed-offset projection experiment, NOT a production
// incremental producer, task executor, lease protocol or cache API.
import { normalizeDomainKey, domainKeyCandidates } from "../../shared/domain-keys";
import { createCatalogDateParser, type DashboardStats, type DashboardStatsOptions, type SummaryDomain } from "../../shared/dashboard-stats";
import { CATALOG_REVISION_KEY } from "../../src/db/catalog-version";
import { SUMMARY_CACHE_MS } from "../../src/services/catalog-summary-cache";
import { PROJECTION_CTE, PROJECTION_AUDIT_SQL, PROJECTION_AGGREGATE_SQL, PROJECTION_LEGACY_RECENT_SQL } from "./catalog-projection-sql";

const PREFIX = "catalog_prototype:1:";
const MAX_VALUE_BYTES = 524288;
const MAX_GENERATION_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
interface Manifest {
  format: 1; generation: string; status: "building" | "ready" | "failed";
  revision: string | null; offset: number; validated_at: number; valid_until: number;
  rows: number; pages: number; accounts: number; encoded_bytes: number;
}
interface StageOptions {
  validatedAt: number; offset: number; sourceValidUntil?: number; revision?: string | null;
  rowsPerPage?: number; bytesPerPage?: number;
  generationBytes?: number;
}
interface Metrics {
  calls: number; statements: number; returnedRows: number; returnedBytes: number;
  reportedRowsRead: number; reportedRowsWritten: number; reportedDurationMs: number;
}
interface Audit {
  pages: number; encoded_bytes: number; invalid_pages: number; rows: number; ordinals: number;
  first_ordinal: number | null; last_ordinal: number | null; invalid_rows: number;
}
interface Aggregation {
  total: number; expired: number; permanent: number; expiring_total: number; invalid_recent: number;
  warnings: string; bucket_counts: string; bucket_items: string; recent: string;
}
interface Warning { full_domain: string; time: number; source: string; alias: string; }
interface BucketItem extends Warning { slot: number; day: number; }
type Recent = DashboardStats["recent"][number];
const finite = (time: number) => Number.isFinite(time) ? time : null;
function validTime(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) throw new Error("Invalid prototype time");
}
function validOffset(value: number) {
  if (!Number.isInteger(value) || value < -840 || value > 840) throw new Error("Invalid prototype offset");
}
function id(value: unknown, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid projection inventory identity");
  return value;
}
function unicode(value: string) {
  if (!/[\uD800-\uDFFF]/.test(value)) return;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("Unsupported projection UTF-16 field");
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("Unsupported projection UTF-16 field");
  }
}
function prefix(generation: string) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(generation)) throw new Error("Invalid prototype generation");
  return `${PREFIX}${generation}:`;
}
function months(now: number, offset: number) {
  const local = new Date(now - offset * 60000);
  return Array.from({ length: 12 }, (_, slot) => {
    const time = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + slot, 1));
    const start = time.getTime() + offset * 60000;
    const end = Date.UTC(time.getUTCFullYear(), time.getUTCMonth() + 1, 1) + offset * 60000;
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("Prototype calendar range unsupported");
    return { slot, start, end, key: `${time.getUTCFullYear()}-${String(time.getUTCMonth() + 1).padStart(2, "0")}`,
      label: `${time.getUTCMonth() + 1}月`, year: time.getUTCFullYear(), month: time.getUTCMonth() + 1, isCurrent: slot === 0 };
  });
}

export class CatalogProjectionPrototype {
  readonly metrics: Metrics = { calls: 0, statements: 0, returnedRows: 0, returnedBytes: 0,
    reportedRowsRead: 0, reportedRowsWritten: 0, reportedDurationMs: 0 };
  constructor(private readonly db: D1Database) {}
  private record<T>(result: D1Result<T>) {
    if (!result.success || !Array.isArray(result.results)) throw new Error("Prototype database result failed");
    this.metrics.returnedRows += result.results.length;
    this.metrics.returnedBytes += encoder.encode(JSON.stringify(result.results)).byteLength;
    this.metrics.reportedRowsRead += Number(result.meta?.rows_read || 0);
    this.metrics.reportedRowsWritten += Number(result.meta?.rows_written || 0);
    this.metrics.reportedDurationMs += Number(result.meta?.duration || 0);
  }
  private async all<T>(sql: string, values: unknown[] = []) {
    this.metrics.calls++; this.metrics.statements++;
    const result = await this.db.prepare(sql).bind(...values).all<T>();
    this.record(result); return result.results;
  }
  private async one<T>(sql: string, values: unknown[] = []) {
    const result = await this.all<T>(sql, values);
    if (result.length > 1) throw new Error("Unexpected prototype result cardinality");
    return result[0] ?? null;
  }
  private async revision() {
    return (await this.one<{ value: string }>("SELECT value FROM settings WHERE key=?", [CATALOG_REVISION_KEY]))?.value ?? null;
  }
  private async writeManifest(manifest: Manifest) {
    const value = JSON.stringify(manifest);
    if (encoder.encode(value).byteLength > MAX_VALUE_BYTES) throw new Error("Prototype manifest exceeds encoded budget");
    const result = await this.all(`INSERT INTO cache(key,value,expires_at)
      SELECT ?,?,? WHERE (SELECT value FROM settings WHERE key=?) IS ?
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at RETURNING key`,
      [`${prefix(manifest.generation)}manifest`, value, manifest.valid_until / 1000, CATALOG_REVISION_KEY, manifest.revision]);
    if (result.length !== 1) throw new Error("Projection source revision changed");
  }

  async stage(input: DashboardStatsOptions, options: StageOptions): Promise<Manifest> {
    validTime(options.validatedAt); validOffset(options.offset);
    const rowsPerPage = options.rowsPerPage ?? 250, bytesPerPage = options.bytesPerPage ?? 131072;
    const generationBytes = options.generationBytes ?? MAX_GENERATION_BYTES;
    if (!Number.isInteger(rowsPerPage) || rowsPerPage < 1 || rowsPerPage > 250 ||
        !Number.isInteger(bytesPerPage) || bytesPerPage < 128 || bytesPerPage > MAX_VALUE_BYTES ||
        !Number.isInteger(generationBytes) || generationBytes < 128 || generationBytes > MAX_GENERATION_BYTES)
      throw new Error("Invalid projection page budget");
    const current = await this.revision(), revision = options.revision === undefined ? current : options.revision;
    if (revision !== current) throw new Error("Projection source revision changed");
    const validUntil = Math.floor(Math.min(options.sourceValidUntil ?? options.validatedAt + SUMMARY_CACHE_MS,
      options.validatedAt + SUMMARY_CACHE_MS) / 1000) * 1000;
    if (validUntil <= options.validatedAt) throw new Error("Projection source validity expired");
    const manifest: Manifest = { format: 1, generation: crypto.randomUUID(), status: "building", revision,
      offset: options.offset, validated_at: options.validatedAt, valid_until: validUntil, rows: 0, pages: 0,
      encoded_bytes: 0, accounts: input.dnsheAccounts.length + input.cfAccountList.length + input.dpAccountList.length +
        input.customGroupList.length + Object.values(input.multiProviderAccounts).reduce((sum, rows) => sum + rows.length, 0) };
    await this.writeManifest(manifest);
    const parse = createCatalogDateParser(options.offset), names = new Map(input.customGroupList.map(group => [group.id, group.alias]));
    let parts: string[] = [], bytes = 2, pending: D1PreparedStatement[] = [];
    const flushWrites = async () => {
      if (!pending.length) return;
      this.metrics.calls++; this.metrics.statements += pending.length;
      const results = await this.db.batch(pending);
      if (results.length !== pending.length) throw new Error("Projection batch cardinality failed");
      for (const result of results) {
        this.record(result);
        if (result.meta?.changes !== 1) throw new Error("Projection source revision changed or page write failed");
      }
      pending = [];
    };
    const flushPage = async () => {
      if (!parts.length) return;
      if (manifest.encoded_bytes + bytes > generationBytes) throw new Error("Prototype generation storage budget exceeded");
      const value = `[${parts.join(",")}]`;
      const key = `${prefix(manifest.generation)}rows:${String(manifest.pages).padStart(8, "0")}`;
      pending.push(this.db.prepare(`INSERT INTO cache(key,value,expires_at)
        SELECT ?,?,? WHERE (SELECT value FROM settings WHERE key=?) IS ?`).bind(key, value, validUntil / 1000, CATALOG_REVISION_KEY, revision));
      manifest.pages++; manifest.encoded_bytes += bytes;
      parts = []; bytes = 2;
      if (pending.length === 40) await flushWrites();
    };
    const append = async (domain: SummaryDomain, source: string, rank: number, alias: string,
      inventoryId: number, accountId: number | null, groupId: number | null = null) => {
      if (typeof domain.full_domain !== "string" || typeof domain.expires_at !== "string" || typeof alias !== "string")
        throw new Error("Invalid projection business field");
      if (rank !== 3 && domain.created_at != null && typeof domain.created_at !== "string") throw new Error("Invalid projection registration field");
      if (manifest.rows >= 100000) throw new Error("Prototype inventory admission budget exceeded");
      const candidates = domainKeyCandidates(domain.full_domain), canonical = candidates[0];
      let resolved = domain.expires_at;
      for (const candidate of candidates) {
        const entry = input.cfExpiryMap[candidate];
        const raw = entry?.manual ? (entry.expires_at || "0000-00-00") : entry?.expires_at;
        if (raw) { resolved = raw; break; }
      }
      if (typeof resolved !== "string") throw new Error("Unsupported projection expiry metadata");
      const permanent = !resolved || resolved.startsWith("0000"), created = rank !== 3 ? domain.created_at || "" : "";
      const status = rank === 3 ? "" : domain.status || "";
      if (typeof status !== "string") throw new Error("Invalid projection status field");
      for (const value of [domain.full_domain, domain.expires_at, alias, resolved, created, status]) unicode(value);
      const rawTime = rank === 1 || !domain.expires_at || domain.expires_at.startsWith("0000") ? null : finite(parse(domain.expires_at));
      const value = JSON.stringify({ table: rank === 3 ? "custom" : "managed", inventory_id: inventoryId,
        account_id: accountId, group_id: groupId, ordinal: manifest.rows, source_rank: rank, source, canonical, candidate_keys: candidates,
        full_domain: domain.full_domain, alias, raw_expiry: domain.expires_at, raw_status: status, resolved_expiry: resolved,
        raw_time: rawTime, raw_status_expired: rank !== 1 && rank !== 3 && domain.status === "已过期" ? 1 : 0,
        resolved_time: permanent ? null : finite(parse(resolved)), permanent: permanent ? 1 : 0,
        created_at: created, created_present: created ? 1 : 0, created_time: created ? finite(parse(created)) : null });
      const size = encoder.encode(value).byteLength;
      if (size + 2 > bytesPerPage) throw new Error("Projection row exceeds encoded page budget; no truncation permitted");
      if (parts.length >= rowsPerPage || bytes + size + (parts.length ? 1 : 0) > bytesPerPage) await flushPage();
      bytes += size + (parts.length ? 1 : 0); parts.push(value); manifest.rows++;
    };
    try {
      const sources = [
        [input.domains, "DNSHE", 0], [input.cfZones, "Cloudflare", 1], [input.dpDomains, "DigitalPlat", 2],
      ] as const;
      const managed = async (rows: SummaryDomain[], source: string, rank: number) => {
        for (const [index, domain] of rows.entries()) {
          const identity = domain as SummaryDomain & { id?: unknown; account_id?: unknown };
          await append(domain, source, rank, domain.account_alias, id(identity.id, index + 1),
            identity.account_id === undefined ? null : id(identity.account_id, 0));
        }
      };
      for (const [rows, source, rank] of sources) await managed(rows, source, rank);
      for (const [index, domain] of input.customDomains.entries()) {
        const identity = domain as typeof domain & { id?: unknown; account_id?: unknown };
        await append({ ...domain, account_alias: names.get(domain.group_id) || "" }, "自定义", 3,
          names.get(domain.group_id) || "", id(identity.id, index + 1),
          identity.account_id == null ? null : id(identity.account_id, 0), id(domain.group_id, 0));
      }
      for (const [index, provider] of (["dnspod", "alidns", "huaweicloud", "vercel"] as const).entries()) {
        await managed(input.multiProviderDomains[provider], ["DNSPod", "阿里云 DNS", "华为云 DNS", "Vercel"][index], index + 4);
      }
      await flushPage(); await flushWrites();
      manifest.status = "ready"; await this.writeManifest(manifest);
      return { ...manifest };
    } catch (error) {
      manifest.status = "failed";
      await this.writeManifest(manifest).catch(() => {});
      throw error;
    }
  }

  queryScope(generation: string, now: number) {
    validTime(now);
    const base = `${prefix(generation)}rows:`, context = JSON.stringify({ now, seconds: Math.floor(now / 1000) });
    return [context, context, base, `${base}\uffff`];
  }
  async read(generation: string, now: number, offset: number) {
    validTime(now); validOffset(offset);
    const row = await this.one<{ value: string }>("SELECT value FROM cache WHERE key=? AND length(CAST(value AS BLOB))<=524288", [`${prefix(generation)}manifest`]);
    if (!row) throw new Error("Projection manifest unavailable");
    const value: unknown = JSON.parse(row.value);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid projection manifest");
    const raw = value as Record<string, unknown>;
    if (raw.format !== 1 || raw.generation !== generation || raw.status !== "ready" || raw.offset !== offset ||
      !(raw.revision === null || typeof raw.revision === "string") ||
      !["validated_at", "valid_until", "rows", "pages", "accounts", "encoded_bytes"].every(key =>
        typeof raw[key] === "number" && Number.isSafeInteger(raw[key]) && (raw[key] as number) >= 0))
      throw new Error("Projection manifest not ready or scope mismatch");
    const manifest: Manifest = { format: 1, generation, status: "ready", revision: raw.revision as string | null, offset,
      validated_at: raw.validated_at as number, valid_until: raw.valid_until as number,
      rows: raw.rows as number, pages: raw.pages as number, accounts: raw.accounts as number, encoded_bytes: raw.encoded_bytes as number };
    if (manifest.validated_at > now || manifest.valid_until <= now ||
        manifest.valid_until - manifest.validated_at > SUMMARY_CACHE_MS) throw new Error("Projection source validity expired");
    if (manifest.encoded_bytes > MAX_GENERATION_BYTES || manifest.rows > 100000 || manifest.pages > 100000)
      throw new Error("Projection manifest exceeds admitted storage scope");
    if (await this.revision() !== manifest.revision) throw new Error("Projection source revision changed");
    const scope = this.queryScope(generation, now), audit = await this.one<Audit>(PROJECTION_AUDIT_SQL, scope);
    if (!audit || audit.pages !== manifest.pages || audit.encoded_bytes !== manifest.encoded_bytes ||
      audit.invalid_pages || audit.invalid_rows || audit.rows !== manifest.rows ||
      audit.ordinals !== manifest.rows || (manifest.rows && (audit.first_ordinal !== 0 || audit.last_ordinal !== manifest.rows - 1)))
      throw new Error("Projection pages incomplete or malformed");
    const buckets = months(now, offset);
    const data = await this.one<Aggregation>(PROJECTION_AGGREGATE_SQL, [...scope, JSON.stringify(buckets)]);
    if (!data) throw new Error("Projection aggregation unavailable");
    let recent = JSON.parse(data.recent) as Recent[];
    if (data.invalid_recent) {
      recent = await this.all<Recent>(PROJECTION_LEGACY_RECENT_SQL, scope);
      const parse = createCatalogDateParser(offset);
      recent = recent.map(row => ({ full_domain: row.full_domain, created_at: row.created_at, source: row.source, alias: row.alias }))
        .sort((a, b) => parse(b.created_at!) - parse(a.created_at!)).slice(0, 6);
    }
    const counts = JSON.parse(data.bucket_counts) as Array<{ slot: number; count: number }>;
    const items = JSON.parse(data.bucket_items) as BucketItem[];
    const timelineBuckets = buckets.map(bucket => ({
      key: bucket.key, label: bucket.label, year: bucket.year, month: bucket.month, isCurrent: bucket.isCurrent,
      items: items.filter(item => item.slot === bucket.slot).map(item => ({ full_domain: item.full_domain, source: item.source,
        alias: item.alias, daysLeft: (item.time - now) / 86400000, day: item.day })),
      count: counts.find(item => item.slot === bucket.slot)?.count || 0,
    }));
    const stats: DashboardStats = { total: data.total, active: Math.max(0, data.total - data.expired), expired: data.expired,
      accounts: manifest.accounts, recent,
      expiring: (JSON.parse(data.warnings) as Warning[]).map(item => ({ full_domain: item.full_domain,
        daysLeft: (item.time - now) / 86400000, expired: item.time < now, source: item.source, alias: item.alias, time: item.time })),
      expiringTotal: data.expiring_total, timeline: { buckets: timelineBuckets,
        maxCount: Math.max(1, ...timelineBuckets.map(bucket => bucket.count)),
        scheduledTotal: timelineBuckets.reduce((sum, bucket) => sum + bucket.count, 0),
        permanentCount: data.permanent, overdueCount: data.expired } };
    if (encoder.encode(JSON.stringify(stats)).byteLength > MAX_VALUE_BYTES) throw new Error("Prototype result exceeds encoded summary budget");
    if (await this.revision() !== manifest.revision) throw new Error("Projection source revision changed");
    return { stats, recentMode: data.invalid_recent ? "legacy-full-sort" as const : "sql-top-six" as const,
      manifest: { ...manifest }, metrics: { ...this.metrics } };
  }
}

export { PROJECTION_CTE, PROJECTION_AGGREGATE_SQL };
