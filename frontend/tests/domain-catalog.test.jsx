import assert from "node:assert/strict";
import { test } from "node:test";
import { act, create } from "react-test-renderer";
import { AppDataProvider, useAppData } from "../src/state/AppDataContext";
import { useDomainCatalog } from "../src/features/domains/hooks/useDomainCatalog";
import { DomainsPage } from "../src/features/domains/components/DomainsPage";
import { DomainTimeline } from "../src/components/DomainTimeline";
import { CATALOG_PROVIDERS } from "../../shared/domain-catalog";
import { computeDashboardStats } from "../../shared/dashboard-stats";
import { useCustomProvidersActions } from "../src/features/custom/hooks/custom-providers/useCustomProvidersActions";
import { useCustomProvidersData } from "../src/features/custom/hooks/custom-providers/useCustomProvidersData";
import { isCatalogPageResponse, isCatalogSearchResponse, isCatalogSummaryResponse } from "../src/features/domains/utils/catalog-response";
import { useDnsheDomains } from "../src/features/domains/hooks/useDnsheDomains";
import { SearchResultGroups } from "../src/components/search/SearchResultGroups";
import { useMultiProviders } from "../src/features/providers/hooks/useMultiProviders";
import { MULTI_PROVIDER_COLLAPSED_STORAGE } from "../src/features/providers/providerMeta";

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
const row = id => ({ id, account_id: 1, account_alias: "account", full_domain: `d-${id}.example.com`,
  subdomain: "", rootdomain: "example.com", status: "已解析", has_dns: 1, expires_at: "2027-02-01", last_renewed_at: null });
const page = id => ({ success: true, domains: [row(id)], custom_domains: [], total: 10_000,
  next_cursor: "next", account_counts: { 1: { total: 10_000, has_dns: 10_000 } }, hints: {} });
const emptyStats = () => computeDashboardStats({
  domains: [], cfZones: [], dpDomains: [], customDomains: [], dnsheAccounts: [], cfAccountList: [], dpAccountList: [],
  customGroupList: [], multiProviderDomains: { dnspod: [], alidns: [], huaweicloud: [], vercel: [] },
  multiProviderAccounts: { dnspod: [], alidns: [], huaweicloud: [], vercel: [] }, cfExpiryMap: {},
}, Date.parse("2026-11-18T00:00:00Z"), 20);
const summaryResponse = () => ({ success: true, summary: { stats: { ...emptyStats(), total: 10_000, active: 10_000 },
  provider_counts: Object.fromEntries(CATALOG_PROVIDERS.map(provider => [provider, provider === "dnshe" ? 10_000 : 0])), account_counts: {}, root_domains: [] } });

test("page cancellation prevents older filter responses and clears source data on logout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const storage = new Map([["DOMAIN_HUB_SESSION", "fixture-token"]]);
  const store = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const previous = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, window: globalThis.window };
  Object.assign(globalThis, { localStorage: store, sessionStorage: store, window: {
    setTimeout: (...args) => globalThis.setTimeout(...args), clearTimeout: id => globalThis.clearTimeout(id),
  } });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (String(input).includes("/summary")) return Response.json(summaryResponse());
    const response = deferred(); requests.push({ input: String(input), signal: init.signal, response });
    return response.promise;
  });
  let model, tree, logout;
  function Probe({ tab, search }) {
    const { setSessionToken } = useAppData();
    logout = () => setSessionToken(null); model = useDomainCatalog(tab, search); return null;
  }
  const render = (tab, search = "") => <AppDataProvider><Probe tab={tab} search={search} /></AppDataProvider>;
  try {
    await act(async () => { tree = create(render("domains")); });
    await act(async () => { t.mock.timers.tick(26); });
    assert.equal(requests.length, 1);
    await act(async () => { void model.source("dnshe").refresh("2"); });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].signal.aborted, true);
    await act(async () => { requests[1].response.resolve(Response.json(page(200))); });
    await act(async () => { requests[0].response.resolve(Response.json(page(1))); });
    assert.equal(model.pages.dnshe.domains[0].id, 200);
    assert.equal(model.pages.dnshe.filter, "2");
    assert.equal(model.summary.stats.total, 10_000);
    await act(async () => { tree.update(render("cloudflare")); });
    await act(async () => { t.mock.timers.tick(1); });
    assert.ok(requests[2].input.includes("provider=cloudflare"));
    await act(async () => { requests[2].response.resolve(Response.json(page(300))); });
    await act(async () => { storage.clear(); logout(); });
    assert.equal(requests[2].signal.aborted, true);
    assert.equal(model.summary, null);
    assert.ok(CATALOG_PROVIDERS.every(provider => model.pages[provider].domains.length === 0));
  } finally {
    if (tree) await act(async () => { tree.unmount(); });
    Object.assign(globalThis, previous);
  }
});

test("10,000-domain DNSHE view renders only the provided 100-row page with truthful group totals", async () => {
  let tree;
  await act(async () => { tree = create(<DomainsPage
    selectedAccountFilter="all" onSelectAccountFilter={() => {}} dnsheAccounts={[]} fetchDomains={() => {}}
    globalSearch="" onClearSearch={() => {}} searchHitCount={10_000} domainsCount={10_000}
    counts={{ 1: { total: 10_000, has_dns: 10_000 } }} actionLoading={null} onSyncDnsheDomains={() => {}}
    collapsedAccounts={new Set()} onToggleAllAccounts={() => {}} loadingDomains={false}
    groupedDomains={[{ accountId: 1, alias: "account", seq: 1, domains: Array.from({ length: 100 }, (_, i) => row(i + 1)) }]}
    checkHasDns={() => true} onToggleAccountCollapse={() => {}} onSyncAccount={() => {}}
    renderDomainCard={domain => <article key={domain.id} data-domain-card>{domain.full_domain}</article>}
  />); });
  assert.equal(tree.root.findAllByType("article").length, 100);
  assert.ok(JSON.stringify(tree.toJSON()).includes("10000"));
  await act(async () => { tree.unmount(); });
});

test("large timeline bucket retains full counts but renders only bounded summary rows", async () => {
  const domains = Array.from({ length: 10_000 }, (_, i) => row(i + 1));
  const options = { domains, cfZones: [], dpDomains: [], customDomains: [], dnsheAccounts: [],
    cfAccountList: [], dpAccountList: [], customGroupList: [],
    multiProviderDomains: Object.fromEntries(CATALOG_PROVIDERS.slice(3, 7).map(key => [key, []])),
    multiProviderAccounts: Object.fromEntries(CATALOG_PROVIDERS.slice(3, 7).map(key => [key, []])), cfExpiryMap: {} };
  const stats = computeDashboardStats(options, Date.parse("2026-11-18T00:00:00Z"), 20, 0);
  let tree;
  await act(async () => { tree = create(<DomainTimeline {...stats.timeline} onPickDomain={() => {}} />); });
  assert.equal(stats.timeline.scheduledTotal, 10_000);
  assert.equal(tree.root.findAllByType("li").length, 20);
  assert.ok(JSON.stringify(tree.toJSON()).includes("10000"));
  await act(async () => { tree.unmount(); });
});

test("custom metadata loading cannot reset a focused page, and stale identity responses are ignored", async () => {
  let tree, actions, rows = [], refreshes = 0, metadataError = null;
  const requests = [];
  const state = {
    setCustomAccounts: value => { rows = value; },
    setLoadingCustomDomains() {},
    setCustomMetadataError: value => { metadataError = value; },
  };
  const apiFetch = async (_url, init) => {
    const value = deferred(); requests.push({ ...value, signal: init.signal }); return value.promise;
  };
  function Probe({ identity }) {
    actions = useCustomProvidersActions({
      identity, state, groupedCustomDomains: [], apiFetch, showToast() {}, fetchAccounts() {}, isPermanentExpiry: () => false,
      refreshPage: async () => { refreshes++; },
    }); return null;
  }
  try {
    await act(async () => { tree = create(<Probe identity="first-session" />); });
    await act(async () => { void actions.fetchCustomDomains(false); });
    await act(async () => { requests[0].resolve(Response.json({ success: true, accounts: [{ id: 1, name: "first" }] })); });
    assert.equal(refreshes, 0, "first visit metadata must not overwrite the page focus");
    assert.equal(rows[0].name, "first");
    await act(async () => { void actions.fetchCustomDomains(); });
    await act(async () => { requests[1].resolve(Response.json({ success: true, accounts: [{ id: 1, name: "second" }] })); });
    assert.equal(refreshes, 1, "explicit refresh after mutations must reset the list cursor");
    await act(async () => { void actions.fetchCustomDomains(false); });
    await act(async () => { rows = []; tree.update(<Probe identity="new-session" />); });
    assert.equal(requests[2].signal.aborted, true);
    await act(async () => { requests[2].resolve(Response.json({ success: true, accounts: [{ id: 1, name: "stale" }] })); });
    assert.deepEqual(rows, []);
    assert.equal(metadataError, null);
  } finally { if (tree) await act(async () => { tree.unmount(); }); }
});

test("custom page rows still render under correct account IDs when account metadata is unavailable", async () => {
  let model, tree;
  function Probe() {
    model = useCustomProvidersData({
      accounts: [{ id: 8, provider: "custom", alias: "fixture" }], customAccounts: [], customGroupFilter: "all",
      customDomains: [{ id: 10_000, group_id: 8, account_id: 5, full_domain: "last.example.com", account_name: "from page",
        expires_at: "2027-02-01", updated_at: "2026-11-19" }],
      counts: { 8: { total: 10_000, has_dns: 0 } },
    }); return null;
  }
  await act(async () => { tree = create(<Probe />); });
  assert.equal(model.groupedCustomDomains[0].domainCount, 10_000);
  const account = model.groupedCustomDomains[0].accounts[0];
  assert.equal(account.id, 5);
  assert.equal(account.name, "from page");
  assert.equal(account.domains[0].id, 10_000);
  await act(async () => { tree.unmount(); });
});

test("page responses fail closed for false successes, malformed bodies and oversized full inventories", () => {
  assert.equal(isCatalogPageResponse(page(1)), true);
  assert.equal(isCatalogPageResponse({ ...page(1), success: false }), false);
  assert.equal(isCatalogPageResponse(null), false);
  assert.equal(isCatalogPageResponse({ ...page(1), domains: Array.from({ length: 101 }, (_, i) => row(i)) }), false);
  assert.equal(isCatalogPageResponse({ ...page(1), total: -1 }), false);
});
test("summary response validation rejects incomplete zero-count fallbacks and unbounded timeline details", () => {
  const value = summaryResponse();
  assert.equal(isCatalogSummaryResponse(value), true);
  assert.equal(isCatalogSummaryResponse({ success: true, summary: { stats: { total: 0 } } }), false);
  value.summary.stats.timeline.buckets[0].items = Array.from({ length: 21 }, () => row(1));
  assert.equal(isCatalogSummaryResponse(value), false);
});
test("search response validation requires all providers and bounded candidate lists", () => {
  const value = { success: true, result: { query: "example", groups: Object.fromEntries(CATALOG_PROVIDERS.map(provider => [provider, { total: 0, items: [] }])) } };
  assert.equal(isCatalogSearchResponse(value), true);
  value.result.groups.custom.items = Array.from({ length: 9 }, () => row(1));
  assert.equal(isCatalogSearchResponse(value), false);
  delete value.result.groups.custom;
  assert.equal(isCatalogSearchResponse(value), false);
});

test("a summary invalidated during its request is not published before the follow-up result", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const values = new Map([["DOMAIN_HUB_SESSION", "summary-test"]]);
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const previous = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, window: globalThis.window };
  Object.assign(globalThis, { localStorage: storage, sessionStorage: storage, window: {
    setTimeout: (...args) => globalThis.setTimeout(...args), clearTimeout: value => globalThis.clearTimeout(value),
  } });
  const requests = [];
  t.mock.method(globalThis, "fetch", async () => { const request = deferred(); requests.push(request); return request.promise; });
  let model, tree;
  function Probe() { model = useDomainCatalog("dashboard", ""); return null; }
  try {
    await act(async () => { tree = create(<AppDataProvider><Probe /></AppDataProvider>); });
    await act(async () => { t.mock.timers.tick(26); });
    assert.equal(requests.length, 1);
    await act(async () => { void model.refreshSummary(); });
    await act(async () => { requests[0].resolve(Response.json(summaryResponse())); });
    assert.equal(model.summary, null, "an invalidated old result must not appear as current");
    await act(async () => { t.mock.timers.tick(26); });
    assert.equal(requests.length, 2);
    const latest = summaryResponse(); latest.summary.stats.total = 12_345; latest.summary.stats.active = 12_345;
    latest.summary.provider_counts.dnshe = 12_345;
    await act(async () => { requests[1].resolve(Response.json(latest)); });
    assert.equal(model.summary.stats.total, 12_345);
    assert.equal(model.refreshingSummary, false);
  } finally {
    if (tree) await act(async () => { tree.unmount(); });
    Object.assign(globalThis, previous);
  }
});
test("DNS-filtered server pages cannot be discarded by the DNSHE name-only grouping hook", async () => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem() { return null; }, setItem() {} };
  let model, tree;
  function Probe({ filtered }) { model = useDnsheDomains([row(9999)], [], "content-only-token", filtered); return null; }
  try {
    await act(async () => { tree = create(<Probe filtered />); });
    assert.equal(model.groupedDomains[0].domains[0].id, 9999);
    await act(async () => { tree.update(<Probe filtered={false} />); });
    assert.equal(model.groupedDomains.length, 0, "legacy callers retain name-only filtering");
  } finally { if (tree) await act(async () => tree.unmount()); globalThis.localStorage = previous; }
});
test("DNS search results explain cache scope and pass exact source/ID/account to navigation", async () => {
  let tree, jump;
  const result = { kw: "content-only-token", dns_scope: "valid_cached_records", dnsheHits: [], cfHits: [
    { id: 100001, account_id: 9, full_domain: "same.example.net", dns_match: { type: "TXT", name: "_verify", preview: "<script>content-only-token</script>" } },
  ], dpHits: [], customHits: [], multiHits: { dnspod: [], alidns: [], huaweicloud: [], vercel: [] } };
  try {
    await act(async () => { tree = create(<SearchResultGroups result={result} onJump={(...args) => { jump = args; }} />); });
    assert.ok(JSON.stringify(tree.toJSON()).includes("不是实时全量 DNS 查询"));
    assert.ok(JSON.stringify(tree.toJSON()).includes("DNS 缓存"));
    assert.equal(tree.root.findAllByType("script").length, 0);
    await act(async () => tree.root.findByType("button").props.onClick());
    assert.deepEqual(jump, ["cf", "same.example.net", 100001, 9]);
  } finally { if (tree) await act(async () => tree.unmount()); }
});
test("search response metadata uses Unicode character bounds without accepting oversized previews or wrong sources", () => {
  const value = { success: true, result: { query: "token", scope: "all", dns_scope: "valid_cached_records",
    groups: Object.fromEntries(CATALOG_PROVIDERS.map(provider => [provider, { total: 0, items: [] }])) } };
  value.result.groups.dnshe = { total: 1, items: [{ id: 1, account_id: 1, provider: "dnshe", full_domain: "example.net",
    dns_match: { type: "TXT", name: "@", preview: "😀".repeat(512) } }] };
  assert.equal(isCatalogSearchResponse(value), true);
  value.result.groups.dnshe.items[0].dns_match.preview = "😀".repeat(513);
  assert.equal(isCatalogSearchResponse(value), false);
  value.result.groups.dnshe.items[0].dns_match.preview = "token";
  value.result.groups.dnshe.items[0].provider = "cloudflare";
  assert.equal(isCatalogSearchResponse(value), false);
});
test("global cached search suppresses an old response and exact locators keep their client-owned control state", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = { getItem: key => key === "DOMAIN_HUB_SESSION" ? "search-fixture" : null, setItem() {}, removeItem() {} };
  const previous = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, window: globalThis.window };
  Object.assign(globalThis, { localStorage: store, sessionStorage: store, window: {
    setTimeout: (...args) => globalThis.setTimeout(...args), clearTimeout: id => globalThis.clearTimeout(id),
  } });
  const searches = [], pages = [];
  const result = query => ({ success: true, result: { query, scope: "all", dns_scope: "valid_cached_records",
    groups: Object.fromEntries(CATALOG_PROVIDERS.map(provider => [provider, { total: 0, items: [] }])) } });
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (String(input).includes("/summary")) return Response.json(summaryResponse());
    if (String(input).includes("/search?")) {
      const response = deferred(); searches.push({ input: String(input), signal: init.signal, response }); return response.promise;
    }
    pages.push(String(input));
    return Response.json({ ...page(100001), domains: [{ ...row(100001), account_id: 9 }], focusId: 1, filter: "all", focus: "malicious-control.example" });
  });
  let model, tree;
  function Probe({ search }) { model = useDomainCatalog("domains", search); return null; }
  const render = search => <AppDataProvider><Probe search={search} /></AppDataProvider>;
  try {
    await act(async () => { tree = create(render("old-content")); });
    await act(async () => t.mock.timers.tick(251));
    assert.ok(searches[0].input.includes("search_in=all"));
    assert.ok(pages[0].includes("search_in=all"));
    await act(async () => { tree.update(render("new-content")); });
    await act(async () => t.mock.timers.tick(251));
    assert.equal(searches[0].signal.aborted, true);
    await act(async () => searches[1].response.resolve(Response.json(result("new-content"))));
    await act(async () => searches[0].response.resolve(Response.json(result("old-content"))));
    assert.equal(model.result.query, "new-content");
    await act(async () => { model.locate("dnshe", "same.example.net", 100001, 9); tree.update(render("")); });
    await act(async () => t.mock.timers.tick(1));
    const url = pages[pages.length - 1];
    assert.ok(url.includes("focus_id=100001") && url.includes("account_id=9"));
    assert.equal(model.pages.dnshe.focusId, 100001);
    assert.equal(model.pages.dnshe.filter, "9");
    assert.equal(model.pages.dnshe.focus, "same.example.net");
  } finally { if (tree) await act(async () => tree.unmount()); Object.assign(globalThis, previous); }
});
test("revealing a searched account expands only the target group without discarding other collapsed groups", async () => {
  const previous = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage };
  const values = new Map([["DOMAIN_HUB_SESSION", "fold-fixture"], [MULTI_PROVIDER_COLLAPSED_STORAGE.dnspod, "[1,2]"]]);
  const store = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  Object.assign(globalThis, { localStorage: store, sessionStorage: store });
  let model, tree;
  const pages = Object.fromEntries(["dnspod", "alidns", "huaweicloud", "vercel"].map(key => [key,
    { domains: [], loading: false, total: 0, filter: "all", refresh: async () => {} }]));
  function Probe() { model = useMultiProviders({ pages, setActionLoading() {}, waitForAccountDomainSync: async () => {}, handleSyncAccount: async () => {} }); return null; }
  try {
    await act(async () => { tree = create(<AppDataProvider><Probe /></AppDataProvider>); });
    assert.equal(model.multiProviderCollapsed.dnspod.has(2), true);
    await act(async () => model.revealMultiProviderAccount("dnspod", 2));
    assert.equal(model.multiProviderCollapsed.dnspod.has(2), false);
    assert.equal(model.multiProviderCollapsed.dnspod.has(1), true);
    assert.equal(values.get(MULTI_PROVIDER_COLLAPSED_STORAGE.dnspod), "[1]");
  } finally { if (tree) await act(async () => tree.unmount()); Object.assign(globalThis, previous); }
});
