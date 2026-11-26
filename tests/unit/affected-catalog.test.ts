import assert from "node:assert/strict";
import { test } from "node:test";
import { AffectedCatalog, type FixtureRow, type MetadataChange, type RowChange } from "../prototypes/affected-catalog";
import { computeDashboardStats } from "../../shared/dashboard-stats";

const NOW = Date.parse("2026-11-24T00:00:00Z");
const row = (id: number, full_domain: string, extra: Partial<FixtureRow> = {}): FixtureRow =>
  ({ id, full_domain, source: "DNSHE", account_alias: `owner-${id}`, expires_at: "2027-01-05", ...extra });
const manual = (name: string, expires_at: string): MetadataChange =>
  ({ name, value: { found: false, manual: true, expires_at } });

test("rename invalidates both key groups; deleting winners exposes the remaining original source and order", () => {
  const a = row(20, "same.example", { created_at: "invalid", expires_at: "2026-12-01" });
  const b = row(1, "SAME.example.", { source: "Cloudflare", created_at: "2026-01-01", expires_at: "2026-12-05" });
  const c = row(1, "other.example", { source: "自定义", expires_at: "2026-12-03" });
  const catalog = new AffectedCatalog([c, b, a], [], NOW, 0);
  assert.equal(catalog.contribution("same.example")?.registration?.created_at, "invalid");
  assert.deepEqual(catalog.contribution("same.example")?.firstExpiry, [0, 20]);

  const renamed = { ...a, full_domain: "other.example" };
  assert.equal(catalog.apply(0, [{ row: renamed }]).affectedKeys, 2);
  assert.equal(catalog.contribution("same.example")?.source, "Cloudflare");
  assert.deepEqual(catalog.contribution("same.example")?.registration?.order, [1, 1]);
  assert.equal(catalog.contribution("other.example")?.source, "DNSHE");
  catalog.apply(1, [{ table: "managed", id: 20 }]);
  assert.equal(catalog.contribution("other.example")?.source, "自定义");
  assert.equal(catalog.contribution("other.example")?.registration, null);
  catalog.apply(2, [{ table: "custom", id: 1 }]);
  assert.equal(catalog.contribution("other.example"), undefined);
  assert.equal(catalog.contribution("same.example")?.source, "Cloudflare");
});

test("date changes follow reverse candidate edges without treating stripped names as the same domain", () => {
  const marked = row(2, "\u200b.example.net"), bare = row(1, "example.net", { source: "Cloudflare" });
  const catalog = new AffectedCatalog([marked, bare], [], NOW, 0);
  assert.equal(catalog.snapshot().length, 2);
  const dual = catalog.apply(0, [], [manual("EXAMPLE.NET.", "2026-12-08")]);
  assert.deepEqual(dual, { sequence: 1, affectedKeys: 2, dependencyVisits: 2, sourceVisits: 2 });
  assert.equal(catalog.contribution(marked.full_domain)?.resolved_time, Date.parse("2026-12-08"));
  catalog.apply(1, [], [manual(marked.full_domain, "2026-12-04")]);
  assert.equal(catalog.contribution(marked.full_domain)?.resolved_time, Date.parse("2026-12-04"));
  assert.equal(catalog.contribution(bare.full_domain)?.resolved_time, Date.parse("2026-12-08"));
  catalog.apply(2, [{ row: { ...marked, full_domain: "\u200b.other.net" } }], [manual("other.net", "2026-12-02")]);
  assert.equal(catalog.contribution("\u200b.other.net")?.resolved_time, Date.parse("2026-12-02"));
  const removed = catalog.apply(3, [], [{ name: bare.full_domain, value: null }]);
  assert.equal(removed.affectedKeys, 1, "renaming must remove old reverse edges");
  assert.equal(catalog.contribution(bare.full_domain)?.resolved_time, Date.parse(bare.expires_at));
});

test("replaying a known mixed change sequence gives the same contributions as rebuilding the indexes", () => {
  const rows = new Map(Array.from({ length: 80 }, (_, i) => [i, row(i, `label-${i % 17}.example`, {
    source: i % 2 ? "Cloudflare" : "DNSHE", created_at: i % 7 ? "2026-11-01" : "invalid",
    expires_at: i % 5 ? "2026-12-01 00:00" : "0000-00",
  })]));
  const dates = new Map<string, MetadataChange>();
  const catalog = new AffectedCatalog([...rows.values()], [], NOW, -480);
  for (let step = 0; step < 64; step++) {
    const id = step * 13 % 80;
    const next = row(id, `${step % 5 ? "" : "\u200b."}label-${step % 17}.example`, {
      source: step % 2 ? "DigitalPlat" : "Cloudflare", created_at: step % 3 ? "invalid" : undefined,
      status: step % 7 ? "正常" : "已过期",
    });
    const del = step % 4 === 0;
    const change: RowChange = del ? { table: "managed", id } : { row: next };
    if (del) rows.delete(id); else rows.set(id, next);
    const name = `label-${step % 17}.example`;
    const metadata = step % 3 === 0 ? { name, value: null } : manual(name, "2026-12-24");
    if (metadata.value) dates.set(name, metadata); else dates.delete(name);
    assert.equal(catalog.apply(step, [change], [metadata]).sequence, step + 1);
    assert.deepEqual(catalog.snapshot(), new AffectedCatalog([...rows.values()], [...dates.values()], NOW, -480).snapshot(), `step ${step}`);
  }
});

test("50k unrelated fixture rows do not increase work for a single rename or a single date dependency", () => {
  const rows = Array.from({ length: 50000 }, (_, i) => row(i, `label-${i}.example`));
  const catalog = new AffectedCatalog(rows, [], NOW, 0);
  const changed = catalog.apply(0, [{ row: { ...rows[0], full_domain: "new.example" } }]);
  assert.deepEqual(changed, { sequence: 1, affectedKeys: 2, dependencyVisits: 0, sourceVisits: 2 });
  assert.deepEqual(catalog.apply(1, [], [manual("label-1.example", "2026-12-09")]),
    { sequence: 2, affectedKeys: 1, dependencyVisits: 1, sourceVisits: 1 });
  assert.equal(catalog.contribution("label-0.example"), undefined);
  assert.equal(catalog.contribution("label-49999.example")?.alias, "owner-49999");
});

test("repair retains separate raw and resolved expiry and matches the reference after replacing a source", () => {
  const raw = row(1, "same.example", { expires_at: "2026-11-24 08:00", created_at: "2026-10-01" });
  const cf = row(2, "SAME.example.", { source: "Cloudflare", expires_at: "2026-11-25", created_at: "2026-11-20" });
  const offset = -480;
  const date = manual("same.example", "2026-12-08");
  const catalog = new AffectedCatalog([cf, raw], [date], NOW, offset);
  for (const version of [0, 1]) {
    if (version) catalog.apply(0, [{ table: "managed", id: raw.id }], [{ ...date, value: null }]);
    const actual = catalog.contribution("same.example")!;
    for (const now of [NOW, NOW + 1]) {
      const expected = computeDashboardStats({
        domains: version ? [] : [raw], cfZones: [cf], dpDomains: [], customDomains: [],
        multiProviderDomains: { dnspod: [], alidns: [], huaweicloud: [], vercel: [] },
        dnsheAccounts: [], cfAccountList: [], dpAccountList: [], customGroupList: [],
        multiProviderAccounts: { dnspod: [], alidns: [], huaweicloud: [], vercel: [] },
        cfExpiryMap: version ? {} : { "same.example": date.value! },
      }, now, 20, offset);
      const expired = !!actual.raw_status_expired || (actual.raw_time !== null && actual.raw_time < now) ||
        (actual.resolved_time !== null && actual.resolved_time < now);
      assert.equal(Number(expired), expected.expired);
      assert.equal(actual.resolved_time, expected.expiring[0]?.time);
      assert.equal(actual.full_domain, expected.expiring[0]?.full_domain);
      assert.equal(actual.alias, expected.expiring[0]?.alias);
      assert.equal(actual.registration?.created_at, expected.recent[0]?.created_at);
      assert.equal(actual.registration?.source, expected.recent[0]?.source);
    }
  }
});

test("stale, ambiguous, oversized and failed fixture updates cannot advance the sequence or retain partial metadata", () => {
  const a = row(1, "a.example"), b = row(2, "b.example");
  const catalog = new AffectedCatalog([a, b], [], NOW, 0);
  const initial = catalog.snapshot();
  assert.throws(() => catalog.apply(1, [{ row: a }]), /Stale/);
  assert.throws(() => catalog.apply(0, [{ row: a }, { table: "managed", id: a.id }]), /Duplicate/);
  assert.throws(() => catalog.apply(0, [], [manual("a.example", ""), manual("A.example.", "")]), /Duplicate/);
  assert.throws(() => catalog.apply(0, Array.from({ length: 257 }, () => ({ row: a }))), /batch too large/);
  assert.throws(() => catalog.apply(0, [{ row: { ...b, expires_at: "+250000-01-01T00:00:00Z" } }],
    [manual("a.example", "2026-12-31")]), /cannot prove expiry order/);
  assert.deepEqual(catalog.snapshot(), initial);
  assert.equal(catalog.apply(0, [{ row: a }]).sequence, 1);
  assert.deepEqual(catalog.snapshot(), initial);
});

test("too much reverse fan-out or too many contributing rows fails closed rather than publishing partial results", () => {
  const marked = Array.from({ length: 1025 }, (_, i) => row(i, `${"\u200b".repeat(i + 1)}.base.example`));
  const byMetadata = new AffectedCatalog(marked, [], NOW, 0);
  assert.throws(() => byMetadata.apply(0, [], [manual("base.example", "2026-12-07")]), /affected-key budget/);
  assert.equal(byMetadata.apply(0, [{ row: row(2000, "other.example") }]).sequence, 1);

  const same = Array.from({ length: 8193 }, (_, i) => row(i, "same.example"));
  const bySource = new AffectedCatalog(same, [], NOW, 0);
  assert.throws(() => bySource.apply(0, [{ table: "managed", id: 0 }]), /visit budget/);
  assert.equal(bySource.contribution("same.example")?.alias, "owner-0");
  assert.equal(bySource.apply(0, []).sequence, 1);
});
