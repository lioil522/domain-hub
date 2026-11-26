// In-memory experiment only. No durable journal, schema change or production writer.
import { createCatalogDateParser, type SummaryExpiry } from "../../shared/dashboard-stats";
import { domainKeyCandidates, normalizeDomainKey } from "../../shared/domain-keys";
import { FoldedContributions } from "./folded-contributions";

const sources = ["DNSHE", "Cloudflare", "DigitalPlat", "自定义", "DNSPod", "阿里云 DNS", "华为云 DNS", "Vercel"] as const;
export type CatalogOwner = typeof sources[number];
export interface FixtureRow {
  id: number; source: CatalogOwner; full_domain: string; account_alias: string;
  expires_at: string; created_at?: string; status?: string;
}
export type RowChange = { row: FixtureRow } | { table: "managed" | "custom"; id: number };
export interface MetadataChange { name: string; value: SummaryExpiry | null }
type SourceOrder = readonly [source: number, id: number];
type IndexedRow = Readonly<FixtureRow> & { rank: number; keys: string[] };
const identity = (table: string, id: number) => `${table}:${id}`;
const rowIdentity = (row: FixtureRow) => identity(row.source === "自定义" ? "custom" : "managed", row.id);
const orderOf = (row: IndexedRow): SourceOrder => [row.rank, row.id];
const compare = (a: IndexedRow, b: IndexedRow) => a.rank - b.rank || a.id - b.id;
const validId = (id: number) => Number.isSafeInteger(id) && id >= 0;
const finite = (n: number) => Number.isFinite(n) ? n : null;
const permanent = (value: string) => !value || value.startsWith("0000");
const MAX_AFFECTED = 1024, MAX_VISITS = 8192;
const MAX_PATCH = 256;

function index(row: FixtureRow): IndexedRow {
  const rank = sources.indexOf(row.source);
  if (!validId(row.id) || rank < 0 || typeof row.full_domain !== "string" || typeof row.expires_at !== "string" ||
    typeof row.account_alias !== "string" || (row.created_at != null && typeof row.created_at !== "string") ||
    (row.status != null && typeof row.status !== "string")) throw new Error("Invalid fixture inventory row");
  return { ...row, rank, keys: domainKeyCandidates(row.full_domain) };
}

function fold(key: string, rows: IndexedRow[], expiryAt: (key: string) => SummaryExpiry | undefined,
  validatedAt: number, parse: (s: string) => number) {
  const fold = new FoldedContributions(validatedAt);
  rows.sort(compare);
  for (const [ordinal, row] of rows.entries()) {
    let date = row.expires_at;
    for (const candidate of row.keys) {
      const entry = expiryAt(candidate);
      const resolved = entry?.manual ? entry.expires_at || "0000-00-00" : entry?.expires_at;
      if (resolved) { date = resolved; break; }
    }
    const created = row.source === "自定义" ? "" : row.created_at || "";
    fold.add({
      canonical: key, ordinal, full_domain: row.full_domain, source: row.source, alias: row.account_alias,
      raw_status_expired: row.source !== "Cloudflare" && row.source !== "自定义" && row.status === "已过期" ? 1 : 0,
      raw_time: row.source === "Cloudflare" || permanent(row.expires_at) ? null : finite(parse(row.expires_at)),
      resolved_time: permanent(date) ? null : finite(parse(date)), permanent: Number(permanent(date)),
      created_at: created, created_time: created ? finite(parse(created)) : null,
    });
  }
  const item = fold.rows().next().value;
  if (!item) return undefined;
  const { ordinal: _, first_finite, registration, ...data } = item;
  const firstExpiry = first_finite === null ? null : orderOf(rows[first_finite]);
  // Local positions can change when another source is deleted. Global ties
  // need a stable (source rank, inventory ID) pair, not a renumbered ordinal.
  if (!registration) return { ...data, firstExpiry, registration: null };
  const { pos, ...display } = registration;
  return { ...data, firstExpiry, registration: { ...display, order: orderOf(rows[pos]) } };
}
type Result = NonNullable<ReturnType<typeof fold>>;

function addTo(map: Map<string, Set<string>>, key: string, id: string) {
  let entries = map.get(key);
  if (!entries) map.set(key, entries = new Set());
  entries.add(id);
}
function removeFrom(map: Map<string, Set<string>>, key: string, id: string) {
  const entries = map.get(key);
  if (entries?.delete(id) && entries.size === 0) map.delete(key);
}

export class AffectedCatalog {
  private readonly rows = new Map<string, IndexedRow>();
  private readonly canonical = new Map<string, Set<string>>();
  private readonly dependents = new Map<string, Set<string>>();
  private readonly metadata = new Map<string, SummaryExpiry>();
  private readonly results = new Map<string, Result>();
  private sequence = 0;

  constructor(rows: readonly FixtureRow[], metadata: readonly MetadataChange[], private readonly validatedAt: number,
    private readonly offset: number) {
    for (const { name, value } of metadata) if (value) this.metadata.set(normalizeDomainKey(name), { ...value });
    for (const raw of rows) {
      const row = index(raw), id = rowIdentity(row);
      if (this.rows.has(id)) throw new Error("Duplicate fixture inventory identity");
      this.link(id, row);
    }
    const parse = createCatalogDateParser(offset);
    for (const [key, ids] of this.canonical) {
      this.results.set(key, fold(key, Array.from(ids, id => this.rows.get(id)!), k => this.metadata.get(k), validatedAt, parse)!);
    }
  }

  private link(id: string, row: IndexedRow) {
    this.rows.set(id, row);
    if (!row.keys[0]) return;
    addTo(this.canonical, row.keys[0], id);
    for (const candidate of row.keys) addTo(this.dependents, candidate, id);
  }
  private unlink(id: string, row: IndexedRow) {
    this.rows.delete(id);
    if (!row.keys[0]) return;
    removeFrom(this.canonical, row.keys[0], id);
    for (const candidate of row.keys) removeFrom(this.dependents, candidate, id);
  }
  snapshot() {
    return structuredClone([...this.results].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }
  contribution(key: string) { return structuredClone(this.results.get(normalizeDomainKey(key))); }

  apply(expectedSequence: number, inventory: readonly RowChange[], dates: readonly MetadataChange[] = []) {
    if (expectedSequence !== this.sequence) throw new Error("Stale fixture sequence");
    if (inventory.length + dates.length > MAX_PATCH) throw new Error("Fixture change batch too large");
    const next = new Map<string, IndexedRow | null>();
    const newMembers = new Map<string, Set<string>>();
    const overrides = new Map<string, SummaryExpiry | null>();
    const affected = new Set<string>();
    let dependencyVisits = 0, sourceVisits = 0;
    const mark = (key?: string) => {
      if (key) affected.add(key);
      if (affected.size > MAX_AFFECTED) throw new Error("Fixture affected-key budget exceeded");
    };
    const countVisit = () => {
      if (dependencyVisits + sourceVisits > MAX_VISITS) throw new Error("Fixture contribution visit budget exceeded");
    };
    for (const change of inventory) {
      const row = "row" in change ? index(change.row) : null;
      if (!("row" in change) && (!validId(change.id) || !["managed", "custom"].includes(change.table)))
        throw new Error("Invalid fixture inventory deletion");
      const id = "row" in change ? rowIdentity(change.row) : identity(change.table, change.id);
      if (next.has(id)) throw new Error("Duplicate fixture row change");
      next.set(id, row);
      mark(this.rows.get(id)?.keys[0]); mark(row?.keys[0]);
      if (row?.keys[0]) addTo(newMembers, row.keys[0], id);
    }
    for (const { name, value } of dates) {
      const key = normalizeDomainKey(name);
      if (overrides.has(key)) throw new Error("Duplicate fixture metadata change");
      overrides.set(key, value && { ...value });
      for (const id of this.dependents.get(key) ?? []) {
        dependencyVisits++; countVisit();
        mark(this.rows.get(id)?.keys[0]);
      }
    }
    const parse = createCatalogDateParser(this.offset);
    const recomputed = new Map<string, Result | undefined>();
    for (const key of affected) {
      const members: IndexedRow[] = [];
      for (const id of this.canonical.get(key) ?? []) {
        sourceVisits++; countVisit();
        if (!next.has(id)) members.push(this.rows.get(id)!);
      }
      for (const id of newMembers.get(key) ?? []) {
        sourceVisits++; countVisit();
        members.push(next.get(id)!);
      }
      recomputed.set(key, fold(key, members, k => overrides.has(k) ? overrides.get(k) ?? undefined : this.metadata.get(k),
        this.validatedAt, parse));
    }
    // No shared state changed before this point. This is a synchronous
    // in-memory commit; it does not model crash durability or SQL races.
    for (const [id, row] of next) {
      const old = this.rows.get(id);
      if (old) this.unlink(id, old);
      if (row) this.link(id, row);
    }
    for (const [key, value] of overrides) {
      if (value) this.metadata.set(key, value);
      else this.metadata.delete(key);
    }
    for (const [key, value] of recomputed) {
      if (value) this.results.set(key, value);
      else this.results.delete(key);
    }
    return { sequence: ++this.sequence, affectedKeys: affected.size, dependencyVisits, sourceVisits };
  }
}
