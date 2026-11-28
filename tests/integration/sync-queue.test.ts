import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { testDatabase, TEST_AES_KEY } from "../helpers/database";
import { encryptText } from "../../src/db/crypto";
import { DNSHEClient } from "../../src/dnshe";
import { CloudflareClient } from "../../src/cloudflare";
import { SyncWorkQueue, SYNC_LEASE_MS } from "../../src/db/dao/sync-work-dao";
import { runOneSyncSlice } from "../../src/services/sync-work-runner";
import { ActionRepository } from "../../src/repositories/action-repository";
import { ActionService } from "../../src/services/action-service";
import { providerFetch } from "../../src/providers/provider-fetch";
import { mapZoneToUpstream } from "../../src/cloudflare";
import { getClientForAccount } from "../../src/db/dao/account-dao";
import worker from "../../src/index";

const domain = (id: number) => ({ id, subdomain: `d${id}`, rootdomain: "us.ci", full_domain: `d${id}.us.ci`, status: "active", expires_at: "2035-01-01" });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: TestContext, ids = [1], count = 3) {
  const data = await testDatabase(t);
  for (const id of ids) await data.d1.prepare("INSERT INTO accounts(id,alias,provider,api_key,api_secret) VALUES(?,?,'dnshe',?,?)")
    .bind(id, `account-${id}`, `key-${id}`, await encryptText("secret", TEST_AES_KEY)).run();
  let clock = Date.now();
  const queue = new SyncWorkQueue(data.d1, () => clock), actions = new ActionService(new ActionRepository(data.manager));
  const clients = new Map<number, DNSHEClient>();
  for (const id of ids) {
    const client = new DNSHEClient("fake", "fake");
    client.listSubdomains = async (page = 1, perPage = 25) => ({ success: true,
      subdomains: Array.from({ length: count }, (_, i) => domain(id * 10000 + i)).slice((page - 1) * perPage, page * perPage), total: count });
    client.listDnsRecords = async () => ({ success: true, records: [] });
    client.getQuota = async () => ({ success: true, quota: { used: 1, available: 9, base: 10, invite_bonus: 0, total: 10 } });
    clients.set(id, client);
  }
  data.manager.getClientForAccount = async id => ({ client: clients.get(id)!, alias: `account-${id}`, provider: "dnshe" });
  const step = async (timeoutMs = 1000) => { clock += 2000; return runOneSyncSlice(data.manager, { queue, timeoutMs }); };
  const drain = async (id: string, limit = 500) => {
    for (let i = 0; i < limit; i++) {
      const state = await actions.get(id);
      if (state && ["completed", "failed", "cancelled", "paused"].includes(state.status)) return state;
      await step();
    }
    throw new Error("Queue did not reach a terminal state");
  };
  return { ...data, queue, clients, actions, step, drain, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

test("enqueue persists queued work before any network call and coalesces repeat clicks", async t => {
  const { queue, actions, clients } = await fixture(t);
  clients.get(1)!.listSubdomains = async () => assert.fail("Enqueue must not fetch upstream");
  const id = await queue.enqueue({ label: "test", accountIds: [1] });
  assert.equal((await actions.get(id))?.status, "queued");
  assert.equal((await queue.jobs(id)).length, 1);
  assert.equal(await queue.enqueue({ label: "repeat", accountIds: [1] }), id);
});

test("20 concurrent claimers acquire a work item at most once", async t => {
  const { queue } = await fixture(t);
  await queue.enqueue({ label: "test", accountIds: [1] });
  const claims = await Promise.all(Array.from({ length: 20 }, () => queue.claim()));
  assert.equal(claims.filter(Boolean).length, 1);
});

test("expired running lease is requeued without erasing its committed checkpoint", async t => {
  const { queue, advance } = await fixture(t);
  const id = await queue.enqueue({ label: "test", accountIds: [1] }), work = (await queue.claim())!;
  await queue.checkpoint(work, { phase: "list", page: 7, total: 150 });
  advance(SYNC_LEASE_MS + 1);
  await queue.recover();
  const next = (await queue.jobs(id))[0];
  assert.equal(next.status, "queued");
  assert.equal(JSON.parse(next.cursor).page, 7);
  assert.notEqual((await queue.claim())!.lease_token, work.lease_token);
});

test("an expired executor cannot write data or release its replacement lease", async t => {
  const { queue, manager, advance } = await fixture(t);
  const id = await queue.enqueue({ label: "test", accountIds: [1] }), old = (await queue.claim())!;
  advance(SYNC_LEASE_MS + 1); await queue.recover();
  const replacement = (await queue.claim())!;
  await assert.rejects(() => queue.stage(old, [domain(1)], { phase: "dns", total: 1 }, false), /租约已失效/);
  await queue.finish(old, "failed", "late");
  assert.equal((await queue.jobs(id))[0].lease_token, replacement.lease_token);
  assert.equal((await manager.firstRaw<{ n: number }>("SELECT COUNT(*) n FROM sync_rows"))?.n, 0);
});

test("old queued/running orphan actions fail clearly, while fresh and unrelated actions are preserved", async t => {
  const { manager, queue, actions, now } = await fixture(t);
  for (const [id, type, status, age] of [["old-queued", "sync", "queued", 3600000], ["old-running", "sync", "running", 3600000],
    ["fresh", "sync", "running", 0], ["other", "backup", "running", 3600000]] as const) {
    await manager.executeRaw("INSERT INTO actions(id,type,status,progress,updated_at) VALUES(?,?,?,0,?)", [id, type, status, new Date(now() - age).toISOString()]);
  }
  await queue.recover();
  assert.equal((await actions.get("old-queued"))?.status, "failed");
  assert.equal((await actions.get("old-running"))?.status, "failed");
  assert.match((await actions.get("old-running"))?.error || "", /持久执行器/);
  assert.equal((await actions.get("fresh"))?.status, "running");
  assert.equal((await actions.get("other"))?.status, "running");
});

test("DNSHE paginated queue completes after executor restart without deleting early pages", async t => {
  const { queue, manager, actions, d1, step, now } = await fixture(t, [1], 76);
  await manager.upsertDomain(1, { ...domain(999), dns_state_known: true });
  const id = await queue.enqueue({ label: "paged", accountIds: [1] });
  await step(); await step(); await step();
  assert.equal((await manager.getDomains()).length, 1);
  const restarted = new SyncWorkQueue(d1, now);
  for (let i = 0; i < 80 && (await actions.get(id))?.status !== "completed"; i++) {
    await step();
    await runOneSyncSlice(manager, { queue: restarted });
  }
  assert.equal((await actions.get(id))?.status, "completed");
  assert.equal((await manager.getDomains()).length, 76);
  assert.equal(await manager.getDomainById(999), null);
});

test("DNSHE authoritative empty list clears candidates but keeps rows added during the cycle", async t => {
  const { queue, manager, step, drain } = await fixture(t, [1], 0);
  await manager.upsertDomain(1, { ...domain(999), dns_state_known: true });
  const id = await queue.enqueue({ label: "empty", accountIds: [1] });
  await step();
  await manager.upsertDomain(1, { ...domain(888), dns_state_known: true });
  await drain(id);
  assert.equal(await manager.getDomainById(999), null);
  assert.ok(await manager.getDomainById(888));
});

test("unknown DNS results preserve previous DNS state and mark the action failed", async t => {
  const { clients, queue, manager, drain } = await fixture(t, [1], 1);
  await manager.upsertDomain(1, { ...domain(10000), status: "已委派", has_dns: 0, dns_provider: "Cloudflare", dns_state_known: true });
  clients.get(1)!.listDnsRecords = async () => ({ success: false, message: "unknown" });
  const id = await queue.enqueue({ label: "unknown", accountIds: [1] });
  assert.equal((await drain(id)).status, "failed");
  assert.equal((await manager.getDomainById(10000))?.status, "已委派");
});

test("bad account retries never prevent another queued account from finishing", async t => {
  const { queue, manager, clients, step, actions, advance } = await fixture(t, [1, 2], 1);
  clients.get(1)!.listSubdomains = async () => { throw new Error("upstream offline"); };
  const id = await queue.enqueue({ label: "fair", accountIds: [1, 2] });
  for (let i = 0; i < 80; i++) { advance(10000); await step(); }
  const jobs = await queue.jobs(id);
  assert.equal(jobs.find(job => job.account_id === 1)?.status, "failed");
  assert.equal(jobs.find(job => job.account_id === 2)?.status, "completed");
  assert.equal((await manager.getDomains("", "", 2)).length, 1);
  assert.equal((await actions.get(id))?.status, "failed");
});

test("late network result after cancellation cannot stage or commit data", async t => {
  const { queue, clients, manager, actions, step } = await fixture(t, [1], 1);
  const id = await queue.enqueue({ label: "cancel", accountIds: [1] });
  await step();
  const started = deferred<void>(), response = deferred<{ success: boolean; subdomains: ReturnType<typeof domain>[]; total: number }>();
  clients.get(1)!.listSubdomains = async () => { started.resolve(); return response.promise; };
  const execution = step(1000);
  await started.promise;
  await queue.control(id, "cancel");
  response.resolve({ success: true, subdomains: [domain(1)], total: 1 });
  await execution;
  assert.equal((await actions.get(id))?.status, "cancelled");
  assert.equal((await manager.firstRaw<{ n: number }>("SELECT COUNT(*) n FROM sync_rows"))?.n, 0);
});

test("slice timeout releases running state and fences a delayed response", async t => {
  const { queue, clients, manager, step } = await fixture(t, [1], 1);
  const id = await queue.enqueue({ label: "timeout", accountIds: [1] });
  await step();
  const response = deferred<{ success: boolean; subdomains: ReturnType<typeof domain>[]; total: number }>();
  clients.get(1)!.listSubdomains = async () => response.promise;
  await step(20);
  assert.equal((await queue.jobs(id))[0].status, "queued");
  response.resolve({ success: true, subdomains: [domain(1)], total: 1 });
  await Promise.resolve(); await Promise.resolve();
  assert.equal((await manager.firstRaw<{ n: number }>("SELECT COUNT(*) n FROM sync_rows"))?.n, 0);
});

test("pause blocks claims and explicit retry resumes the checkpoint", async t => {
  const { queue, step, drain } = await fixture(t);
  const id = await queue.enqueue({ label: "pause", accountIds: [1] });
  await step();
  const before = (await queue.jobs(id))[0].cursor;
  await queue.control(id, "pause");
  assert.equal(await queue.claim(), null);
  await queue.control(id, "retry");
  assert.equal((await queue.jobs(id))[0].cursor, before);
  assert.equal((await drain(id)).status, "completed");
});

test("credential updates cancel old work and create a fresh resumable action", async t => {
  const { queue, manager, actions } = await fixture(t);
  const old = await queue.enqueue({ label: "old", accountIds: [1] });
  await manager.executeRaw("UPDATE accounts SET api_secret=? WHERE id=1", [await encryptText("changed", TEST_AES_KEY)]);
  const fresh = await queue.enqueue({ label: "new", accountIds: [1] });
  assert.notEqual(fresh, old);
  assert.equal((await actions.get(old))?.status, "cancelled");
  assert.equal((await actions.get(fresh))?.status, "queued");
});

test("Cloudflare queue follows shared durable pages through one action", async t => {
  const { queue, manager, drain } = await fixture(t);
  await manager.executeRaw("UPDATE accounts SET provider='cloudflare' WHERE id=1");
  const client = new CloudflareClient("fake");
  client.listZones = async ({ startPage = 1 } = {}) => ({ zones: [{ id: `zone-${startPage}`, name: `z${startPage}.example.com`, status: "active" }],
    hasMore: startPage < 4, nextPage: startPage + 1 });
  manager.getClientForAccount = async () => ({ client, alias: "CF", provider: "cloudflare" });
  const id = await queue.enqueue({ label: "CF", accountIds: [1] });
  assert.equal((await drain(id)).status, "completed");
  assert.equal((await manager.getDomains("", "", 1, "cloudflare")).length, 4);
});

test("unknown renewal result is reconciled with GET and never blindly POSTed again", async t => {
  const { clients, queue, manager, drain } = await fixture(t, [1], 1);
  const client = clients.get(1)!, original = new Date(Date.now() + 86400000).toISOString(), renewed = new Date(Date.now() + 366 * 86400000).toISOString();
  client.listSubdomains = async () => ({ success: true, subdomains: [{ ...domain(10000), expires_at: original }], total: 1 });
  let posts = 0, reads = 0;
  client.renewSubdomain = async () => { posts++; throw new Error("reply lost after upstream applied renewal"); };
  client.getSubdomain = async () => { reads++; return { success: true, subdomain: { ...domain(10000), expires_at: renewed } }; };
  const id = await queue.enqueue({ label: "renew", accountIds: [1], renew: true });
  assert.equal((await drain(id)).status, "completed");
  assert.equal(posts, 1); assert.equal(reads, 1);
  assert.equal((await manager.getDomainById(10000))?.expires_at, renewed);
  const repeated = await queue.enqueue({ label: "stale upstream list", accountIds: [1], renew: true });
  assert.equal((await drain(repeated)).status, "completed");
  assert.equal(posts, 1);
});

test("quota cache refresh updates only its account and never gates domain progress", async t => {
  const { manager, queue, step } = await fixture(t);
  await manager.setCache("api_cache:quota", JSON.stringify([{ account_id: 2, alias: "keep", available: 88 }]));
  await queue.enqueue({ label: "quota", accountIds: [1] });
  await step();
  const values = JSON.parse((await manager.getCache("api_cache:quota"))!);
  assert.equal(values.find((row: { account_id: number }) => row.account_id === 2).available, 88);
  assert.equal(values.find((row: { account_id: number }) => row.account_id === 1).available, 9);
});

test("losing the work lease after journaling but before renewal prevents the outbound POST", async t => {
  const data = await fixture(t, [1], 1);
  const client = data.clients.get(1)!;
  const expires_at = new Date(Date.now() + 86400000).toISOString();
  client.listSubdomains = async () => ({ success: true, subdomains: [{ ...domain(10000), expires_at }], total: 1 });
  let posts = 0;
  client.renewSubdomain = async () => { posts++; return { success: false, message: "must not send" }; };
  const action = await data.queue.enqueue({ label: "renew lease", accountIds: [1], renew: true });
  const check = data.queue.ownsRenewalAttempt.bind(data.queue);
  t.mock.method(data.queue, "ownsRenewalAttempt", async (...args: Parameters<typeof check>) => {
    await data.queue.control(action, "pause"); // a separate committed transaction
    return check(...args);
  });
  assert.equal((await data.drain(action)).status, "paused");
  assert.equal(posts, 0);
  assert.equal(data.sqlite.prepare("SELECT status FROM sync_renew_journal").get()?.status, "attempting");
});

test("job deadline ends permanently queued work instead of reserving an account forever", async t => {
  const { queue, advance, actions } = await fixture(t);
  const id = await queue.enqueue({ label: "deadline", accountIds: [1] });
  advance(86400001); await queue.recover();
  assert.equal((await actions.get(id))?.status, "failed");
  assert.equal((await queue.jobs(id))[0].status, "failed");
});

test("managed sync API rejects dummy creation and manual completion", async t => {
  const { d1, manager } = await fixture(t), session = await manager.createSession(), jobs: Promise<unknown>[] = [];
  const call = (path: string, method: string, value?: unknown) => worker.fetch(new Request(`http://localhost${path}`, {
    method, headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  }), { DB: d1, AES_KEY: TEST_AES_KEY }, { waitUntil: (task: Promise<unknown>) => jobs.push(task), props: {} } as unknown as ExecutionContext);
  assert.equal((await call("/api/actions", "POST", { type: "sync" })).status, 400);
  const created = await call("/api/actions", "POST", { type: "sync", metadata: { accountIds: [1] } });
  const id = (await created.json() as { action: { id: string } }).action.id;
  assert.equal((await call(`/api/actions/${id}/complete`, "POST")).status, 409);
  assert.equal((await call(`/api/actions/${id}`, "PATCH", { status: "completed" })).status, 409);
  await call(`/api/actions/${id}/cancel`, "POST");
  await Promise.allSettled(jobs);
});

test("provider response-body deadline aborts a stream that never finishes", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode("{")); } })));
  const response = await providerFetch("https://test.invalid", {}, undefined, 10);
  await assert.rejects(() => response.json(), /取消或超时/);
});

test("provider response-byte budget is enforced before JSON allocation", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(5 * 1024 * 1024 + 1)));
  const response = await providerFetch("https://test.invalid");
  await assert.rejects(() => response.arrayBuffer(), /5MB/);
});

test("progress checkpoints reset transient failure streaks instead of accumulating forever", async t => {
  const { queue, advance } = await fixture(t);
  const id = await queue.enqueue({ label: "retry budget", accountIds: [1] }), first = (await queue.claim())!;
  await queue.finish(first, "queued", "temporary", 1, true);
  advance(2);
  const second = (await queue.claim())!;
  assert.equal(second.failures, 1);
  await queue.checkpoint(second, { phase: "list", page: 2, total: 25 });
  assert.equal((await queue.jobs(id))[0].failures, 0);
});

test("a staged page and its cursor cannot split at the lease boundary", async t => {
  const { queue, d1, sqlite } = await fixture(t);
  await queue.enqueue({ label: "page boundary", accountIds: [1] });
  const work = (await queue.claim())!;
  let at = work.lease_until - 1;
  const edge = new SyncWorkQueue(d1, () => at++);
  let rejected = false;
  try { await edge.stage(work, [domain(17)], { phase: "dns", page: 2, total: 1 }, false); }
  catch { rejected = true; }
  const staged = sqlite.prepare("SELECT COUNT(*) AS n FROM sync_rows WHERE job_id=?").get(work.id)?.n;
  const saved = JSON.parse((await queue.jobs(work.action_id))[0].cursor);
  assert.deepEqual({ staged, phase: saved.phase }, rejected ? { staged: 0, phase: "start" } : { staged: 1, phase: "dns" });
  assert.equal(rejected, false, "the admission sample is one millisecond before expiry");
});

test("queued Cloudflare final-page inventory and generation cleanup roll back if the outer job cursor cannot commit", async t => {
  const { queue, manager, sqlite, step, advance, actions } = await fixture(t);
  await manager.executeRaw("UPDATE accounts SET provider='cloudflare' WHERE id=1");
  const client = new CloudflareClient("fixture");
  const requests: number[] = [];
  client.listZones = async ({ startPage = 1 } = {}) => {
    requests.push(startPage);
    return { zones: [{ id: `atomic-${startPage}`, name: `atomic-${startPage}.example`, status: "active" }],
      hasMore: startPage === 1, nextPage: startPage + 1 };
  };
  manager.getClientForAccount = async () => ({ client, alias: "fixture", provider: "cloudflare" });
  await manager.upsertDomain(1, domain(42));
  const action = await queue.enqueue({ label: "atomic CF page", accountIds: [1] });
  await step(); // start -> cf
  await step(); // page 1 commits both cursors
  sqlite.exec(`CREATE TRIGGER fail_outer_cursor BEFORE UPDATE OF cursor ON sync_work
    WHEN json_extract(NEW.cursor,'$.phase')='done' BEGIN SELECT RAISE(ABORT,'fixture outer cursor failure'); END`);
  await step();
  assert.deepEqual(JSON.parse((await queue.jobs(action))[0].cursor), { phase: "cf", page: 2, total: 1 });
  assert.deepEqual(sqlite.prepare("SELECT full_domain FROM domains_cache ORDER BY full_domain").all().map(row => row.full_domain), ["atomic-1.example", "d42.us.ci"]);
  assert.equal(sqlite.prepare("SELECT next_page FROM cf_sync_state WHERE account_id=1").get()?.next_page, 2);
  assert.equal(sqlite.prepare("SELECT seen FROM cf_sync_seen WHERE domain_id=42").get()?.seen, 0);
  sqlite.exec("DROP TRIGGER fail_outer_cursor");
  advance(60001); await step();
  assert.deepEqual(requests, [1, 2, 2]);
  assert.equal((await actions.get(action))?.status, "completed");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM cf_sync_state").get()?.n, 0);
  assert.deepEqual(sqlite.prepare("SELECT full_domain FROM domains_cache ORDER BY full_domain").all().map(row => row.full_domain),
    ["atomic-1.example", "atomic-2.example"]);
});

test("CF page fetched across queue lease expiry is rejected while its CF generation still has a valid lease", async t => {
  const { queue, manager, sqlite, step, advance } = await fixture(t);
  await manager.executeRaw("UPDATE accounts SET provider='cloudflare' WHERE id=1");
  const client = new CloudflareClient("fixture");
  client.listZones = async () => {
    advance(SYNC_LEASE_MS);
    return { zones: [], hasMore: false, nextPage: 2 };
  };
  manager.getClientForAccount = async () => ({ client, alias: "fixture", provider: "cloudflare" });
  await manager.upsertDomain(1, domain(42));
  const action = await queue.enqueue({ label: "expired while fetching", accountIds: [1] });
  await step(); await step();
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM domains_cache WHERE id=42").get()?.n, 1);
  assert.equal(sqlite.prepare("SELECT next_page FROM cf_sync_state WHERE account_id=1").get()?.next_page, 1);
  assert.equal(JSON.parse((await queue.jobs(action))[0].cursor).phase, "cf");
});

test("four DNS observations and their low-water mark commit together on the last eligible tick", async t => {
  const data = await fixture(t, [1], 4);
  const action = await data.queue.enqueue({ label: "dns clock edge", accountIds: [1] });
  await data.step(); await data.step(); // begin, then stage authoritative list
  data.advance(2000); // next slice is due
  const at = data.now();
  let edge: number | undefined;
  data.clients.get(1)!.listDnsRecords = async () => {
    edge = at + SYNC_LEASE_MS - 1;
    return { success: true, records: [] };
  };
  const queue = new SyncWorkQueue(data.d1, () => edge === undefined ? at : edge++);
  await runOneSyncSlice(data.manager, { queue });
  const job = (await queue.jobs(action))[0];
  assert.equal(JSON.parse(job.cursor).checked, 4);
  assert.equal(data.sqlite.prepare("SELECT COUNT(*) n FROM sync_rows WHERE enriched=1 AND dns_attempts=1").get()?.n, 4);
  assert.equal(data.sqlite.prepare("SELECT COUNT(*) n FROM cache WHERE key LIKE 'api_cache:dns:%'").get()?.n, 4);
});

test("paused work restarts its snapshot if credentials changed before resume", async t => {
  const { queue, manager, step } = await fixture(t);
  const id = await queue.enqueue({ label: "paused credentials", accountIds: [1] });
  await step(); await queue.control(id, "pause");
  await manager.executeRaw("UPDATE accounts SET api_secret=? WHERE id=1", [await encryptText("new", TEST_AES_KEY)]);
  await queue.control(id, "retry");
  assert.equal(JSON.parse((await queue.jobs(id))[0].cursor).phase, "start");
});

test("Cloudflare credential change fences the old lease and restarts the cycle at page one", async t => {
  const { d1, manager } = await fixture(t);
  await manager.executeRaw("UPDATE accounts SET provider='cloudflare' WHERE id=1");
  const oldClient = (await getClientForAccount(d1, TEST_AES_KEY, 1)).client as CloudflareClient;
  const old = await manager.claimCloudflareSync(1, oldClient.credentialFingerprint);
  await manager.commitCloudflareSyncPage(1, old, [mapZoneToUpstream({ id: "old-zone", name: "old.example.com", status: "active" })], { hasMore: true, nextPage: 2 });
  await manager.executeRaw("UPDATE accounts SET api_secret=? WHERE id=1", [await encryptText("new-token", TEST_AES_KEY)]);
  await assert.rejects(() => manager.commitCloudflareSyncPage(1, old, [], { hasMore: false, nextPage: 2 }), /凭据已改变/);
  const client = (await getClientForAccount(d1, TEST_AES_KEY, 1)).client as CloudflareClient;
  const fresh = await manager.claimCloudflareSync(1, client.credentialFingerprint);
  assert.equal(fresh.nextPage, 1);
  assert.notEqual(fresh.generation, old.generation);
  await manager.releaseCloudflareSync(1, old);
  assert.equal((await manager.firstRaw<{ lease_token: string }>("SELECT lease_token FROM cf_sync_state"))?.lease_token, fresh.token);
});

test("a full 50-zone Cloudflare page uses a constant-sized transactional statement batch", async t => {
  const { manager } = await fixture(t);
  const lease = await manager.claimCloudflareSync(1);
  const zones = Array.from({ length: 50 }, (_, i) => mapZoneToUpstream({ id: `bulk-${i}`, name: `bulk-${i}.example.com`, status: "active" }));
  await manager.commitCloudflareSyncPage(1, lease, zones, { hasMore: true, nextPage: 2 });
  assert.equal((await manager.getDomains()).length, 50);
  assert.equal(lease.totalSynced, 50);
});

test("a stalled auxiliary quota request cannot keep domain synchronization at the first step", async t => {
  const { manager, queue, clients, step, drain } = await fixture(t);
  await manager.setCache("api_cache:quota", "[]");
  clients.get(1)!.getQuota = async () => new Promise(() => {});
  const id = await queue.enqueue({ label: "quota stall", accountIds: [1] });
  await step(20);
  assert.equal(JSON.parse((await queue.jobs(id))[0].cursor).phase, "list");
  assert.equal((await drain(id)).status, "completed");
});

test("action GET repairs an old queued orphan and explicit retry creates executable work", async t => {
  const { manager, d1 } = await fixture(t);
  const token = await manager.createSession(), jobs: Promise<unknown>[] = [];
  await manager.executeRaw(`INSERT INTO actions(id,type,status,progress,metadata,updated_at)
    VALUES('orphan','sync','queued',0,?,?)`, [JSON.stringify({ accountIds: [1], label: "old" }), new Date(Date.now() - 3600000).toISOString()]);
  const call = (path: string, method = "GET") => worker.fetch(new Request(`http://localhost${path}`, {
    method, headers: { Authorization: `Bearer ${token}` },
  }), { DB: d1, AES_KEY: TEST_AES_KEY }, { waitUntil: (task: Promise<unknown>) => jobs.push(task), props: {} } as unknown as ExecutionContext);
  const response = await call("/api/actions/orphan");
  assert.equal((await response.json() as { action: { status: string } }).action.status, "failed");
  const retry = await call("/api/actions/orphan/retry", "POST");
  assert.equal(retry.status, 200);
  assert.notEqual((await retry.json() as { action_id: string }).action_id, "orphan");
  await Promise.allSettled(jobs);
});
