import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseManager } from "../../src/db";
import { CloudflareClient, mapZoneToUpstream, type CfZoneInfo } from "../../src/cloudflare";
import { syncCloudflareSlice } from "../../src/services/cloudflare-sync-service";
import { syncCloudflareZones } from "../../src/services/account-sync-service";
import { runDailySyncAndRenewal } from "../../src/cron/jobs/daily-sync";
import { ConflictError } from "../../src/errors";
import { testDatabase, TEST_AES_KEY } from "../helpers/database";

const zone = (id: string): CfZoneInfo => ({ id, name: `${id}.example.com`, status: "active" });
async function account(d1: D1Database, id = 1) {
  await d1.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES (?, ?, ?, 'unused', 'cloudflare')")
    .bind(id, `CF-${id}`, `cf-test-${id}`).run();
}
function clientFor(pages: CfZoneInfo[][], requested: number[] = []) {
  const client = new CloudflareClient("local-fake-token");
  client.listZones = async ({ startPage = 1 } = {}) => {
    requested.push(startPage);
    return { zones: pages[startPage - 1] || [], hasMore: startPage < pages.length, nextPage: startPage + 1 };
  };
  return client;
}
async function names(manager: DatabaseManager, accountId = 1) {
  return (await manager.getDomains("", "", accountId, "cloudflare")).map(row => row.full_domain).sort();
}

test("manual multi-invocation sync keeps prior pages and only deletes unseen baseline rows at completion", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  await manager.upsertAccountDomains(1, [mapZoneToUpstream(zone("deleted"))]);
  const requested: number[] = [];
  const client = clientFor([[zone("one")], [zone("two")], [zone("three")], [zone("four")]], requested);
  await assert.rejects(() => syncCloudflareZones(manager, 1, client), /再次点击/);
  assert.equal((await names(manager)).length, 4);
  assert.equal((await manager.firstRaw<{ next_page: number }>("SELECT next_page FROM cf_sync_state WHERE account_id=1"))?.next_page, 4);
  assert.equal(await syncCloudflareZones(manager, 1, client), 4);
  assert.deepEqual(requested, [1, 2, 3, 4]);
  assert.deepEqual(await names(manager), ["four.example.com", "one.example.com", "three.example.com", "two.example.com"]);
  assert.equal(await manager.firstRaw("SELECT * FROM cf_sync_state"), null);
});

test("Cron and manual sync share durable checkpoints instead of restarting at page one", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  const requested: number[] = [];
  const client = clientFor([[zone("one")], [zone("two")], [zone("three")], [zone("four")]], requested);
  manager.getClientForAccount = async () => ({ client, alias: "CF-test", provider: "cloudflare" });
  await runDailySyncAndRenewal(manager, undefined, "custom", true);
  assert.equal((await manager.firstRaw<{ next_page: number }>("SELECT next_page FROM cf_sync_state"))?.next_page, 4);
  assert.equal(await syncCloudflareZones(manager, 1, client), 4);
  assert.deepEqual(requested, [1, 2, 3, 4]);
  assert.equal((await names(manager)).length, 4);
});

test("failed upstream page preserves candidates and restarts from the last committed page", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  await manager.upsertAccountDomains(1, [mapZoneToUpstream(zone("baseline"))]);
  const requested: number[] = [];
  const client = clientFor([[zone("one")], [zone("two")]], requested);
  const list = client.listZones.bind(client);
  let fail = true;
  client.listZones = async options => {
    if (options?.startPage === 2 && fail) { fail = false; throw new Error("upstream outage"); }
    return list(options);
  };
  await assert.rejects(() => syncCloudflareSlice(manager, 1, client), /upstream outage/);
  assert.deepEqual(await names(manager), ["baseline.example.com", "one.example.com"]);
  assert.equal((await manager.firstRaw<{ next_page: number }>("SELECT next_page FROM cf_sync_state"))?.next_page, 2);
  const restarted = new DatabaseManager(d1, TEST_AES_KEY);
  assert.equal((await syncCloudflareSlice(restarted, 1, client)).completed, true);
  assert.deepEqual(await names(manager), ["one.example.com", "two.example.com"]);
});

test("empty complete upstream clears only the selected account", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1, 1); await account(d1, 2);
  await manager.upsertAccountDomains(1, [mapZoneToUpstream(zone("old"))]);
  await manager.upsertAccountDomains(2, [mapZoneToUpstream(zone("other"))]);
  const result = await syncCloudflareSlice(manager, 1, clientFor([[]]));
  assert.equal(result.totalSynced, 0);
  assert.deepEqual(await names(manager), []);
  assert.deepEqual(await names(manager, 2), ["other.example.com"]);
});

test("same-account leases reject overlapping runs but different accounts can proceed", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1, 1); await account(d1, 2);
  const lease = await manager.claimCloudflareSync(1);
  await assert.rejects(() => manager.claimCloudflareSync(1), ConflictError);
  const other = await manager.claimCloudflareSync(2);
  await manager.releaseCloudflareSync(1, lease);
  await manager.releaseCloudflareSync(2, other);
});

test("expired lease cannot write, delete or release a newer owner's lease", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  await manager.upsertAccountDomains(1, [mapZoneToUpstream(zone("keep"))]);
  const stale = await manager.claimCloudflareSync(1);
  await manager.executeRaw("UPDATE cf_sync_state SET lease_until=0 WHERE account_id=1");
  const current = await manager.claimCloudflareSync(1);
  await assert.rejects(() => manager.commitCloudflareSyncPage(1, stale, [mapZoneToUpstream(zone("stale"))], { hasMore: false, nextPage: 2 }), ConflictError);
  assert.deepEqual(await names(manager), ["keep.example.com"]);
  await manager.releaseCloudflareSync(1, stale);
  await assert.rejects(() => manager.claimCloudflareSync(1), ConflictError);
  await manager.releaseCloudflareSync(1, current);
});

test("failed checkpoint commit rolls back both page rows and seen markers", async t => {
  const { sqlite, d1, manager } = await testDatabase(t);
  await account(d1);
  await manager.upsertAccountDomains(1, [mapZoneToUpstream(zone("keep"))]);
  const lease = await manager.claimCloudflareSync(1);
  sqlite.exec(`CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON cf_sync_state
    WHEN NEW.next_page > OLD.next_page BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END`);
  await assert.rejects(() => manager.commitCloudflareSyncPage(1, lease, [mapZoneToUpstream(zone("new"))], { hasMore: true, nextPage: 2 }));
  assert.deepEqual(await names(manager), ["keep.example.com"]);
  assert.equal((await manager.firstRaw<{ next_page: number }>("SELECT next_page FROM cf_sync_state"))?.next_page, 1);
});

test("cache rows created during a paginated cycle are not deleted as unseen baseline candidates", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  const client = clientFor([[zone("one")], [zone("two")]]);
  await syncCloudflareSlice(manager, 1, client, 1);
  await manager.upsertAccountDomains(1, [mapZoneToUpstream(zone("concurrently-created"))]);
  await syncCloudflareSlice(manager, 1, client, 1);
  assert.deepEqual(await names(manager), ["concurrently-created.example.com", "one.example.com", "two.example.com"]);
});

test("expired cycle starts a new generation at page one without deleting cached rows early", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  const client = clientFor([[zone("one")], [zone("two")]]);
  await syncCloudflareSlice(manager, 1, client, 1);
  const old = await manager.firstRaw<{ generation: string }>("SELECT generation FROM cf_sync_state");
  await manager.executeRaw("UPDATE cf_sync_state SET updated_at=0, lease_until=0");
  const lease = await manager.claimCloudflareSync(1);
  assert.equal(lease.nextPage, 1);
  assert.notEqual(lease.generation, old?.generation);
  assert.deepEqual(await names(manager), ["one.example.com"]);
  await manager.releaseCloudflareSync(1, lease);
});

test("non-advancing upstream cursor stops without deleting candidates", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  await manager.upsertAccountDomains(1, [mapZoneToUpstream(zone("keep"))]);
  const client = clientFor([[]]);
  client.listZones = async () => ({ zones: [], hasMore: true, nextPage: 1 });
  await assert.rejects(() => syncCloudflareSlice(manager, 1, client), /游标未前进/);
  assert.deepEqual(await names(manager), ["keep.example.com"]);
});

test("malformed Cloudflare success payload is not treated as an authoritative empty account", async t => {
  const { d1, manager } = await testDatabase(t);
  await account(d1);
  await manager.upsertAccountDomains(1, [mapZoneToUpstream(zone("keep"))]);
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, result: null, errors: [] }));
  await assert.rejects(() => syncCloudflareSlice(manager, 1, new CloudflareClient("fake")), /响应格式无效/);
  assert.deepEqual(await names(manager), ["keep.example.com"]);
});

test("final cleanup failure rolls back deletion and the last page", async t => {
  const { sqlite, d1, manager } = await testDatabase(t);
  await account(d1);
  await manager.upsertAccountDomains(1, [mapZoneToUpstream(zone("old"))]);
  const client = clientFor([[zone("one")], [zone("two")]]);
  await syncCloudflareSlice(manager, 1, client, 1);
  sqlite.exec(`CREATE TRIGGER fail_cleanup BEFORE DELETE ON cf_sync_seen
    BEGIN SELECT RAISE(ABORT, 'cleanup failure'); END`);
  await assert.rejects(() => syncCloudflareSlice(manager, 1, client));
  assert.deepEqual(await names(manager), ["old.example.com", "one.example.com"]);
  assert.equal((await manager.firstRaw<{ next_page: number }>("SELECT next_page FROM cf_sync_state"))?.next_page, 2);
  sqlite.exec("DROP TRIGGER fail_cleanup");
  assert.equal((await syncCloudflareSlice(manager, 1, client)).completed, true);
  assert.deepEqual(await names(manager), ["one.example.com", "two.example.com"]);
});
