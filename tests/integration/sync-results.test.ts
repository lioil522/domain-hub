import assert from "node:assert/strict";
import { test } from "node:test";
import { DNSHEClient } from "../../src/dnshe";
import { CloudflareClient } from "../../src/cloudflare";
import { DigitalPlatClient } from "../../src/digitalplat";
import { resyncAccountsInBackground, deepSyncAccountDomains } from "../../src/services/account-sync-service";
import { startSyncAction } from "../../src/services/sync-action-service";
import { summarizeAccountSync } from "../../src/services/sync-results";
import { ActionService } from "../../src/services/action-service";
import { ActionRepository } from "../../src/repositories/action-repository";
import { fetchAllSubdomainsFromClient } from "../../src/cron/jobs/upstream-sync";
import { runDailySyncAndRenewal } from "../../src/cron/jobs/daily-sync";
import { waitForSyncAction } from "../../frontend/src/features/domains/utils/sync-action";
import { testDatabase, TEST_AES_KEY } from "../helpers/database";
import { encryptText } from "../../src/db/crypto";
import worker from "../../src/index";
import { SyncWorkQueue } from "../../src/db/dao/sync-work-dao";
import { runOneSyncSlice } from "../../src/services/sync-work-runner";

const noWait = async () => {};
const subdomain = (id: number) => ({ id, subdomain: `domain${id}`, rootdomain: "us.ci", full_domain: `domain${id}.us.ci`, status: "active", expires_at: "2035-01-01" });
async function account(d1: D1Database, id = 1) {
  await d1.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES (?, ?, ?, ?, 'dnshe')")
    .bind(id, `Account ${id}`, `fake-${id}`, await encryptText("fake-secret", TEST_AES_KEY)).run();
}
function dnsClient() {
  const client = new DNSHEClient("fake", "fake");
  client.listSubdomains = async () => ({ success: true, subdomains: [subdomain(101)], total: 1 });
  client.listDnsRecords = async () => ({ success: true, records: [] });
  return client;
}

test("account sync returns per-account failure instead of swallowing it as success", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1, 1); await account(d1, 2);
  const client = dnsClient();
  manager.getClientForAccount = async id => {
    if (id === 1) throw new Error("credential failure");
    return { client, alias: "good", provider: "dnshe" };
  };
  const results = await resyncAccountsInBackground(manager, [1, 2], "manual", { sleep: noWait });
  assert.equal(results.failed, 1);
  assert.equal(results.completed, 1);
  assert.deepEqual(results.results.map(result => result.status), ["failed", "completed"]);
});

test("failed DNS-record lookup preserves known DNS state and reports account failure", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  await manager.upsertDomain(1, { ...subdomain(101), status: "已委派", has_dns: 0, dns_provider: "Cloudflare", dns_state_known: true });
  const client = dnsClient();
  client.listDnsRecords = async () => ({ success: false, message: "lookup failed" });
  manager.getClientForAccount = async () => ({ client, alias: "DNSHE", provider: "dnshe" });
  const summary = await resyncAccountsInBackground(manager, [1], "manual", { sleep: noWait });
  assert.equal(summary.failed, 1);
  assert.equal((await manager.getDomainById(101))?.status, "已委派");
});

test("authoritative empty DNSHE account clears obsolete cached rows", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  await manager.upsertDomain(1, { ...subdomain(101), dns_state_known: true });
  const client = dnsClient();
  client.listSubdomains = async () => ({ success: true, subdomains: [], total: 0 });
  assert.equal(await deepSyncAccountDomains(manager, 1, client), 0);
  assert.equal((await manager.getDomains()).length, 0);
});

test("record lookups use at most five simultaneous upstream requests", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  const client = dnsClient();
  client.listSubdomains = async () => ({ success: true, subdomains: Array.from({ length: 12 }, (_, i) => subdomain(i + 1)), total: 12 });
  let active = 0, maximum = 0;
  client.listDnsRecords = async () => {
    active++; maximum = Math.max(maximum, active);
    await Promise.resolve();
    active--;
    return { success: true, records: [] };
  };
  await deepSyncAccountDomains(manager, 1, client);
  assert.equal(maximum, 5);
});

test("pagination budget, short/incomplete pages and repeated IDs reject non-authoritative lists", async () => {
  const client = { listSubdomains: async () => ({ success: true, subdomains: [subdomain(1)], total: 2 }) };
  await assert.rejects(() => fetchAllSubdomainsFromClient(client, { maxPages: 1, perPage: 1 }), /预算/);
  await assert.rejects(() => fetchAllSubdomainsFromClient(client), /不完整/);
  await assert.rejects(() => fetchAllSubdomainsFromClient(client, { maxPages: 2, perPage: 1 }), /重复/);
});

test("partial Cloudflare slice reports paused rather than completed", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  const client = new CloudflareClient("fake");
  client.listZones = async ({ startPage = 1 } = {}) => ({ zones: [{ id: `zone${startPage}`, name: `zone${startPage}.example.com`, status: "active" }], hasMore: startPage < 4, nextPage: startPage + 1 });
  manager.getClientForAccount = async () => ({ client, alias: "CF", provider: "cloudflare" });
  const summary = await resyncAccountsInBackground(manager, [1], "manual", { sleep: noWait });
  assert.equal(summary.paused, 1);
  assert.equal(summary.completed, 0);
  assert.equal(summary.results[0].nextPage, 4);
});

test("sync action uses failed summary and persists its account results", async t => {
  const { manager } = await testDatabase(t);
  const jobs: Promise<unknown>[] = [];
  const summary = summarizeAccountSync([{ accountId: 1, alias: "bad", status: "failed", error: "upstream failed" }]);
  const id = await startSyncAction(manager, { label: "test", accountIds: [1] }, async () => summary, job => jobs.push(job));
  await Promise.all(jobs);
  const action = await new ActionService(new ActionRepository(manager)).get(id);
  assert.equal(action?.status, "failed");
  assert.deepEqual((action?.metadata as { summary: unknown }).summary, summary);
});

test("sync action treats paused slices as paused and empty successful sync as completed", async t => {
  const { manager } = await testDatabase(t);
  for (const [summary, expected] of [
    [summarizeAccountSync([{ accountId: 1, alias: "CF", status: "paused", nextPage: 4 }]), "paused"],
    [summarizeAccountSync([{ accountId: 1, alias: "empty", status: "completed", domainCount: 0 }]), "completed"],
  ] as const) {
    const jobs: Promise<unknown>[] = [];
    const id = await startSyncAction(manager, { label: "test" }, async () => summary, job => jobs.push(job));
    await Promise.all(jobs);
    assert.equal((await new ActionService(new ActionRepository(manager)).get(id))?.status, expected);
  }
});

test("late completion cannot overwrite a cancelled action", async t => {
  const { manager } = await testDatabase(t);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const jobs: Promise<unknown>[] = [];
  const id = await startSyncAction(manager, { label: "test" }, async () => { await gate; return summarizeAccountSync([]); }, job => jobs.push(job));
  const actions = new ActionService(new ActionRepository(manager));
  await actions.cancel(id);
  finish();
  await Promise.all(jobs);
  assert.equal((await actions.get(id))?.status, "cancelled");
});

test("unexpected runner errors mark actions failed without returning false completion", async t => {
  const { manager } = await testDatabase(t);
  const jobs: Promise<unknown>[] = [];
  const id = await startSyncAction(manager, { label: "test" }, async () => { throw new Error("runner crash"); }, job => jobs.push(job));
  await Promise.all(jobs);
  assert.equal((await new ActionService(new ActionRepository(manager)).get(id))?.status, "failed");
});

test("daily sync includes renewal failure in the returned action outcome", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  const client = dnsClient();
  client.listSubdomains = async () => ({ success: true, subdomains: [{ ...subdomain(101), expires_at: new Date(Date.now() + 86400000).toISOString() }], total: 1 });
  client.renewSubdomain = async () => ({ success: false, message: "renewal failed" });
  manager.getClientForAccount = async () => ({ client, alias: "DNSHE", provider: "dnshe" });
  const summary = await runDailySyncAndRenewal(manager);
  assert.equal(summary.completed, 1);
  assert.match(summary.error || "", /续期失败/);
});

test("sync waiting uses terminal action status, not a fixed delay or domain-count fingerprint", async () => {
  let requests = 0;
  const action = await waitForSyncAction(async () => Response.json({ success: true, action: { id: "job", status: ++requests === 1 ? "running" : "failed", error: "failed" } }), "job", { sleep: noWait });
  assert.equal(action.status, "failed");
  assert.equal(requests, 2);
  const pending = await waitForSyncAction(async () => Response.json({ success: true, action: { id: "job", status: "running" } }), "job", { timeoutMs: 0 });
  assert.equal(pending.status, "pending");
});

test("WHOIS propagates rate-limit status and Retry-After instead of returning HTTP 400", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  const session = await manager.createSession();
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: false, message: "rate limited" }, { status: 429, headers: { "Retry-After": "30" } }));
  const response = await worker.fetch(new Request("http://localhost/api/whois?domain=aa.us.ci&account_id=1", { headers: { Authorization: `Bearer ${session}` } }),
    { DB: d1, AES_KEY: TEST_AES_KEY }, { waitUntil() {}, props: {} } as unknown as ExecutionContext);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "30");
  assert.equal((await response.json() as { error_code: string }).error_code, "rate_limited");
});

test("unknown WHOIS response cannot enter the registered skip pool", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  const session = await manager.createSession();
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, registered: null }));
  const response = await worker.fetch(new Request("http://localhost/api/whois?domain=aa.us.ci&account_id=1", { headers: { Authorization: `Bearer ${session}` } }),
    { DB: d1, AES_KEY: TEST_AES_KEY }, { waitUntil() {}, props: {} } as unknown as ExecutionContext);
  assert.equal(response.status, 502);
  assert.deepEqual(await manager.getWhoisPool(["aa.us.ci"]), []);
});

test("manual sync API returns an action ID and its terminal result is queryable", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  const token = await manager.createSession();
  const jobs: Promise<unknown>[] = [];
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, subdomains: [], total: 0, records: [] }));
  const response = await worker.fetch(new Request("http://localhost/api/accounts/1/sync", { method: "POST", headers: { Authorization: `Bearer ${token}` } }),
    { DB: d1, AES_KEY: TEST_AES_KEY }, { waitUntil: (job: Promise<unknown>) => jobs.push(job), props: {} } as unknown as ExecutionContext);
  assert.equal(response.status, 202);
  const payload = await response.json() as { action_id: string };
  assert.equal(typeof payload.action_id, "string");
  await Promise.all(jobs);
  let clock = Date.now();
  const queue = new SyncWorkQueue(d1, () => clock);
  for (let i = 0; i < 12; i++) { clock += 2000; await runOneSyncSlice(manager, { queue }); }
  const action = await new ActionService(new ActionRepository(manager)).get(payload.action_id);
  assert.equal(action?.status, "completed");
});

test("malformed DigitalPlat success cannot be treated as an empty authoritative account", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  await manager.upsertDomain(1, { ...subdomain(101), dns_state_known: true });
  const client = new DigitalPlatClient("fake");
  manager.getClientForAccount = async () => ({ client, alias: "DigitalPlat", provider: "digitalplat" });
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, data: {} }));
  const summary = await resyncAccountsInBackground(manager, [1], "manual", { sleep: noWait });
  assert.equal(summary.failed, 1);
  assert.ok(await manager.getDomainById(101));
});
