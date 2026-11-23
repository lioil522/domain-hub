import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { computeDashboardStats, createCatalogDateParser } from "../../shared/dashboard-stats";
import { semanticFixture } from "../helpers/catalog-semantic-fixture";
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
