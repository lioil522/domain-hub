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
    await act(async () => { t.mock.timers.tick(1); });
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
