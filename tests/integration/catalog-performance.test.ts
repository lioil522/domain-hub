import assert from "node:assert/strict";
import { test } from "node:test";
import { testDatabase } from "../helpers/database";
import { DomainCatalogRepository } from "../../src/repositories/domain-catalog-repository";
import { DomainCatalogService, catalogMatches } from "../../src/services/domain-catalog-service";
import { CachedDnsSearchRepository } from "../../src/repositories/cached-dns-search-repository";
import { CATALOG_PROVIDERS } from "../../shared/domain-catalog";
import { toASCII } from "../../shared/punycode";

test("SQL name prefilter is a semantic superset, including ASCII controls and Unicode case folding", async t => {
  const { sqlite, manager } = await testDatabase(t);
  CATALOG_PROVIDERS.forEach((provider, i) => sqlite.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(?,?,?,?,?)")
    .run(i + 1, provider, `fake-${i}`, "fake", provider));
  const names = ["normal.example", "UPPER.EXAMPLE", "A_%B.example", "A\0UPPER.example", "  spaced.example ",
    "İ.example", "Σ.example", "😀.example", "测试.example", toASCII("测试.example"), "XN--0ZWM56D.example",
    "xn--invalid-.example", "Example。net", ".invisible\u200b.example", "\x7F.EXAMPLE"];
  const insert = sqlite.prepare(`INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at)
    VALUES(?,?,'','example',?,'active','2027-01-01')`);
  names.forEach((name, i) => insert.run(i + 1, i % 7 + 1, name));
  names.forEach((name, i) => sqlite.prepare("INSERT INTO custom_domains(id,group_id,full_domain,expires_at) VALUES(?,8,?,'2027-01-01')").run(i + 1, name));
  const repo = new DomainCatalogRepository(manager), catalog = new DomainCatalogService(repo);
  const all = await repo.searchProjection();
  for (const query of ["upper", "测试", "测", "xn--0zw", "%", "_", "\0upper", "i\u0307", "σ", "example", "notfound"]) {
    const expected = all.filter(row => catalogMatches(row.full_domain, query));
    const filtered = (await repo.searchProjection({ query })).filter(row => catalogMatches(row.full_domain, query));
    assert.deepEqual(filtered, expected, JSON.stringify(query));
    const result = await catalog.search(query);
    for (const provider of CATALOG_PROVIDERS) {
      const matches = expected.filter(row => row.provider === provider);
      assert.equal(result.groups[provider].total, matches.length);
      assert.deepEqual(result.groups[provider].items, matches.slice(0, 8).map(row => ({ ...row })));
    }
  }
});

test("sparse search SQL cardinality stays small; DNS IDs are revalidated without the whole names inventory", async t => {
  const { sqlite, manager } = await testDatabase(t);
  sqlite.exec(`INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES
    (1,'DNSHE','fake-1','fake','dnshe'),(2,'DNSPod','fake-2','fake','dnspod');
    WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<10000)
    INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at)
    SELECT i,1+(i%2),'','example','item-'||i||'.example','active','2027-01-01' FROM seq`);
  sqlite.prepare("INSERT INTO cache(key,value,expires_at) VALUES('api_cache:dns:9999',?,2000000000)")
    .run(JSON.stringify([{ type: "TXT", name: "@", content: "sparse-token" }]));
  const repo = new DomainCatalogRepository(manager), dns = new CachedDnsSearchRepository(manager);
  const catalog = new DomainCatalogService(repo, dns);
  const projection = repo.searchProjection.bind(repo), returned: number[] = [];
  t.mock.method(repo, "searchProjection", async input => { const result = await projection(input); returned.push(result.length); return result; });
  assert.equal((await catalog.search("notfound")).groups.dnshe.total, 0);
  assert.equal(returned.pop(), 0);
  assert.equal((await catalog.search("sparse-token", "dns")).groups.dnspod.total, 1);
  assert.equal(returned.pop(), 1);
  assert.equal((await catalog.search("sparse-token", "all")).groups.dnspod.total, 1);
  assert.equal(returned.pop(), 1);
  await catalog.page({ provider: "dnspod", filter: 2, search: "item-", limit: 100 });
  assert.equal(returned.pop(), 5000, "paging cannot scan the unrelated provider/account");
  const matches = dns.matches.bind(dns);
  t.mock.method(dns, "matches", async (query, options) => {
    const hits = await matches(query, options);
    await manager.executeRaw("UPDATE domains_cache SET full_domain='replacement.example' WHERE id=9999");
    return hits;
  });
  assert.equal((await catalog.search("sparse-token", "dns")).groups.dnspod.total, 0, "stale DNS identity must not bind to a replacement name");
});
