import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { computeDashboardStats, createCatalogDateParser, parseCatalogDate, type DashboardStatsOptions } from "../../shared/dashboard-stats";
import { semanticFixture, selectionFixture } from "../helpers/catalog-semantic-fixture";
import { createCatalogMatcher } from "../../shared/catalog-match";
import { toASCII, toUnicode } from "../../shared/punycode";
import { domainKeyCandidates, normalizeDomainKey } from "../../shared/domain-keys";

test("stats preserve the pre-optimization seeded semantic corpus, including invalid-date ties", () => {
  const digest = createHash("sha256");
  for (let seed = 1; seed <= 100; seed++) {
    for (const offset of [-480, 0, 330]) {
      digest.update(JSON.stringify(computeDashboardStats(semanticFixture(seed), Date.parse("2026-11-23T00:00:00Z"), 20, offset)));
    }
  }
  assert.equal(digest.digest("hex"), "fb565975725901e8a4feb62ab07371d856de27e3e4d40978c06d343a75dcb603");
});

test("larger selection corpus preserves delayed expiry insertion and late invalid recent ordering", () => {
  const digest = createHash("sha256");
  for (let seed = 1; seed <= 30; seed++) for (const offset of [-480, 0, 330]) {
    digest.update(JSON.stringify(computeDashboardStats(selectionFixture(seed), Date.parse("2026-11-23T00:00:00Z"), 20, offset)));
  }
  assert.equal(digest.digest("hex"), "fbb2dcbb88d3a928e6a33980b952ed1b9a3efd0c141e9edede8954feceef4167");
});

test("prepared matchers preserve literal, Unicode, malformed Punycode and empty-query behavior", () => {
  const names = ["EXAMPLE.NET", "Example。net", "测试.example", "xn--0zwm56d.example", "XN--0ZWM56D.example",
    "prefix-xn--0zwm56d", "xn--invalid-.example", " A_\0B% ", "😀.example", "İ.example", "Σ.example", "\u200b.example", ""];
  const queries = ["", " example ", "测", "测试.example", "xn--0zw", "%", "_", "\0b", "i\u0307", "σ", "😀", "notfound"];
  for (const query of queries) for (const name of names) {
    const q = query.trim().toLowerCase();
    const expected = name.toLowerCase().includes(q) || toUnicode(name).toLowerCase().includes(q) || name.toLowerCase().includes(toASCII(q).toLowerCase());
    assert.equal(createCatalogMatcher(query).matches(name), expected, JSON.stringify({ name, query }));
  }
  for (let code = 0; code < 128; code++) {
    const raw = ` AB${String.fromCharCode(code)}CD.EXAMPLE `;
    assert.equal(toASCII(raw), raw.trim().toLowerCase());
    assert.equal(toUnicode(raw), raw);
  }
  for (const name of names) {
    const key = normalizeDomainKey(name);
    const stripped = normalizeDomainKey(name.replace(/[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g, ""));
    assert.deepEqual(domainKeyCandidates(name), key === stripped ? [key] : [key, stripped]);
  }
});

test("timeline bounded selection is stable and keeps full counts for all slice modes", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const input = semanticFixture(seed), now = Date.parse("2026-11-23T00:00:00Z");
    const full = computeDashboardStats(input, now, Infinity, 0);
    for (const limit of [0, 1, 2, 20, -1, 1.5, NaN]) {
      const bounded = computeDashboardStats(input, now, limit, 0);
      assert.deepEqual(bounded.recent, full.recent);
      assert.deepEqual(bounded.expiring, full.expiring);
      bounded.timeline.buckets.forEach((bucket, i) => {
        assert.equal(bucket.count, full.timeline.buckets[i].count);
        assert.deepEqual(bucket.items, full.timeline.buckets[i].items.slice(0, limit));
      });
    }
  }
});

test("repeated dates are parsed once per request and invalid dates are memoized", t => {
  const parse = Date.parse.bind(Date); let calls = 0;
  t.mock.method(Date, "parse", (raw: string) => { calls++; return parse(raw); });
  const parser = createCatalogDateParser(0);
  for (let i = 0; i < 10000; i++) {
    parser("2027-01-01"); parser("invalid");
  }
  assert.equal(calls, 2);
  const second = createCatalogDateParser(-480);
  second("2027-01-01"); assert.equal(calls, 3, "a different request/offset must not inherit dates");
  for (let i = 0; i < 3000; i++) parser(`invalid-${i}`);
  const before = calls;
  parser("invalid-2999"); parser("invalid-2999");
  assert.equal(calls, before + 2, "memo admission must stop at its bounded capacity");
});

function legacyRecent(input: DashboardStatsOptions, offset = 0) {
  const sources = [
    { rows: input.domains, source: "DNSHE" }, { rows: input.cfZones, source: "Cloudflare" },
    { rows: input.dpDomains, source: "DigitalPlat" }, { rows: input.multiProviderDomains.dnspod, source: "DNSPod" },
    { rows: input.multiProviderDomains.alidns, source: "阿里云 DNS" }, { rows: input.multiProviderDomains.huaweicloud, source: "华为云 DNS" },
    { rows: input.multiProviderDomains.vercel, source: "Vercel" },
  ];
  const first = new Map<string, { full_domain: string; created_at: string | undefined; source: string; alias: string }>();
  for (const { rows, source } of sources) for (const row of rows) {
    const key = normalizeDomainKey(row.full_domain);
    if (!key || !row.created_at || first.has(key)) continue;
    first.set(key, { full_domain: row.full_domain, created_at: row.created_at, source, alias: row.account_alias });
  }
  return [...first.values()].sort((a, b) => parseCatalogDate(b.created_at!, offset) - parseCatalogDate(a.created_at!, offset)).slice(0, 6);
}
function singleSource(count = 10000): DashboardStatsOptions {
  const input = semanticFixture(1);
  input.cfZones = []; input.dpDomains = []; input.customDomains = []; input.cfExpiryMap = {};
  input.multiProviderDomains = { dnspod: [], alidns: [], huaweicloud: [], vercel: [] };
  input.domains = Array.from({ length: count }, (_, i) => ({ full_domain: `item-${i}.example`, expires_at: "2027-01-05",
    created_at: `2026-11-${String(i % 20 + 1).padStart(2, "0")}`, account_alias: `owner-${i}` }));
  return input;
}

test("finite registrations retain stable top six without a full recent sort", () => {
  const input = singleSource(), expected = legacyRecent(input);
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "sort")!, sort = Array.prototype.sort, lengths: number[] = [];
  let result;
  try {
    Object.defineProperty(Array.prototype, "sort", { ...descriptor, value: function<T>(this: T[], compare?: (a: T, b: T) => number) {
      lengths.push(this.length); return sort.call(this, compare) as T[];
    } });
    result = computeDashboardStats(input, Date.parse("2026-11-23T00:00:00Z"), 20, 0);
  } finally { Object.defineProperty(Array.prototype, "sort", descriptor); }
  assert.deepEqual(result.recent, expected);
  assert.ok(lengths.every(length => length <= 6), "finite recent selections must not sort the inventory");
  assert.equal(result.total, 10000);
});

test("a late invalid first registration falls back to legacy sort rather than silently disappearing", () => {
  const input = singleSource();
  input.domains[9998].created_at = "late-invalid";
  input.cfZones = [{ ...input.domains[9998], created_at: "2026-11-22", account_alias: "later valid owner" }];
  assert.deepEqual(computeDashboardStats(input, Date.parse("2026-11-23T00:00:00Z"), 20, 0).recent, legacyRecent(input));
  const shifted = selectionFixture(3);
  shifted.domains[0].created_at = "";
  shifted.cfZones.unshift({ ...shifted.domains[0], created_at: "invalid", account_alias: "late first registration" });
  assert.deepEqual(computeDashboardStats(shifted, Date.parse("2026-11-23T00:00:00Z"), 20, 0).recent, legacyRecent(shifted));
});

test("each canonical key has one aggregate and raw conversion memo admissions are bounded", t => {
  const input = singleSource(5000), set = Map.prototype.set; let inventoryWrites = 0, conversionWrites = 0;
  t.mock.method(Map.prototype, "set", function(this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (typeof key === "string" && /^item-\d+\.example$/.test(key)) {
      if (typeof value === "object" && value !== null && "expiryIndex" in value) inventoryWrites++;
      if (typeof value === "string") conversionWrites++;
    }
    return set.call(this, key, value);
  });
  const result = computeDashboardStats(input, Date.parse("2026-11-23T00:00:00Z"), 20, 0);
  assert.equal(inventoryWrites, 5000);
  assert.equal(conversionWrites, 512);
  assert.equal(result.total, 5000);
});

test("first finite expiry order survives delayed dates and later source replacement", () => {
  const input = singleSource(0);
  const row = (full_domain: string, expires_at: string) => ({ full_domain, expires_at, account_alias: full_domain });
  input.domains = [row("a.example", "0000-00-00"), row("b.example", "2027-01-05"), row("c.example", "invalid"), row("d.example", "2027-01-05")];
  input.cfZones = [row("a.example", "2027-01-05"), row("c.example", "2027-01-05")];
  input.dpDomains = [row("b.example", "2027-01-04")];
  const result = computeDashboardStats(input, Date.parse("2026-11-23T00:00:00Z"), 20, 0);
  assert.deepEqual(result.expiring.map(item => item.full_domain), ["b.example", "d.example", "a.example", "c.example"]);
  assert.deepEqual(result.timeline.buckets.find(bucket => bucket.key === "2027-01")?.items.map(item => item.full_domain),
    ["b.example", "d.example", "a.example", "c.example"]);
  assert.equal(result.timeline.permanentCount, 0);
});
