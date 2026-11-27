import assert from "node:assert/strict";
import { test } from "node:test";
import { testDatabase } from "../helpers/database";
import { seedSnapshotFixture, snapshotWrites } from "../helpers/snapshot-write-fixture";
import { CATALOG_REVISION_KEY, versionedCatalogDatabase } from "../../src/db/catalog-version";
import { DomainCatalogRepository } from "../../src/repositories/domain-catalog-repository";
import { DomainCatalogService } from "../../src/services/domain-catalog-service";
import { SyncWorkQueue } from "../../src/db/dao/sync-work-dao";

const jobId = "snapshot-write-fixture";
test("snapshot commit preserves every stored column against the legacy statement, including unknown DNS and absent metadata", async t => {
  const before = await testDatabase(t), after = await testDatabase(t);
  const stored = [];
  for (const [data, optimized] of [[before, false], [after, true]] as const) {
    const { sqlite, d1 } = data;
    await seedSnapshotFixture(d1, 20);
    sqlite.exec(`UPDATE domains_cache SET remote_id='prev',provider_account_id='old',last_renewed_at='keep';
      UPDATE domains_cache SET account_id=2 WHERE id=1;
      UPDATE domains_cache SET created_at=NULL,dns_provider=NULL,has_dns=NULL WHERE id=12;
      DELETE FROM domains_cache WHERE id=16;
      DELETE FROM sync_rows WHERE domain_id=20`);
    const changes: Array<[number, Record<string, unknown>]> = [
      [2, { expires_at: "" }], [3, { provider_account_id: 123 }], [4, { remote_id: "" }],
      [5, { created_at: "2026-05-02" }], [6, { status: "已委派" }], [7, { has_dns: 0 }],
      [8, { dns_provider: "external" }], [9, { created_at: "", remote_id: null, provider_account_id: null, dns_provider: null }],
      [10, { dns_state_known: false, status: "未解析", has_dns: 0, dns_provider: "must-not-replace" }],
      [11, { dns_state_known: false, status: "未解析", created_at: "2026-05-03" }],
      [12, { created_at: "", dns_provider: null }], [13, { rootdomain: "other", full_domain: "ignored-on-conflict.example" }],
      [14, { dns_state_known: false, provider_account_id: "", remote_id: "new" }],
      [15, { status: "something-else", dns_state_known: null }], [16, { created_at: null, status: "active", dns_state_known: false }],
    ];
    for (const [id, patch] of changes) {
      const payload = JSON.parse(String(sqlite.prepare("SELECT payload FROM sync_rows WHERE domain_id=?").get(id)?.payload));
      sqlite.prepare("UPDATE sync_rows SET payload=? WHERE domain_id=?").run(JSON.stringify({ ...payload, ...patch }), id);
    }
    const db = versionedCatalogDatabase(d1);
    await db.batch(snapshotWrites(db, optimized));
    const rows = sqlite.prepare("SELECT * FROM domains_cache ORDER BY id").all();
    for (const row of rows) {
      if (row.id === 20) assert.equal(row.updated_at, "2000-01-01 00:00:00", "row outside payload is untouched");
      else {
        assert.match(String(row.updated_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        assert.notEqual(row.updated_at, "2000-01-01 00:00:00");
      }
    }
    stored.push(rows.map(({ updated_at, ...rest }) => rest));
  }
  assert.deepEqual(stored[1], stored[0]);
});

test("unchanged snapshot still refreshes per-row timestamps, advances its cursor and invalidates the warm summary", async t => {
  const { d1, sqlite, manager } = await testDatabase(t);
  await seedSnapshotFixture(d1, 10);
  const service = new DomainCatalogService(new DomainCatalogRepository(manager));
  const now = Date.parse("2026-06-01T12:00:00Z");
  const first = await service.summaryResult(now);
  assert.equal((await service.summaryResult(now)).cache, "hit");
  const queue = manager.syncQueue(), work = (await queue.jobs("test"))[0];
  await queue.writeDomains(work, { phase: "renew", total: 10 });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM domains_cache WHERE updated_at='2000-01-01 00:00:00'").get()?.n, 0);
  assert.equal(JSON.parse((await queue.jobs("test"))[0].cursor).phase, "renew");
  const rebuilt = await service.summaryResult(now);
  assert.equal(rebuilt.cache, "miss");
  assert.deepEqual(rebuilt.summary, first.summary);
});

test("lost lease fences both the payload writes and timestamp updates; checkpoint failure rolls back both", async t => {
  const { d1, sqlite, manager } = await testDatabase(t);
  await seedSnapshotFixture(d1, 10);
  sqlite.exec(`UPDATE sync_rows SET payload=json_set(payload,'$.expires_at','2028-01-01') WHERE domain_id=1;
    INSERT INTO sync_candidates(job_id,domain_id) VALUES('${jobId}',10);
    DELETE FROM sync_rows WHERE domain_id=10`);
  const queue = manager.syncQueue(), work = (await queue.jobs("test"))[0];
  const inventory = () => sqlite.prepare("SELECT * FROM domains_cache ORDER BY id").all();
  const original = inventory();
  await assert.rejects(() => queue.writeDomains({ ...work, lease_token: "stale" }, { phase: "renew" }), /租约/);
  assert.deepEqual(inventory(), original);
  const revision = () => sqlite.prepare("SELECT value FROM settings WHERE key=?").get(CATALOG_REVISION_KEY)?.value;
  const lastRevision = revision();
  sqlite.exec("CREATE TRIGGER reject_cursor BEFORE UPDATE OF cursor ON sync_work BEGIN SELECT RAISE(ABORT,'injected checkpoint failure'); END");
  await assert.rejects(() => queue.writeDomains(work, { phase: "renew" }), /injected checkpoint failure/);
  assert.deepEqual(inventory(), original);
  assert.equal(revision(), lastRevision);
  assert.equal(JSON.parse((await queue.jobs("test"))[0].cursor).phase, "write");
});

test("persistent UPDATE OF triggers observe one legacy wide update per incoming matched row", async t => {
  const { d1, sqlite } = await testDatabase(t);
  await seedSnapshotFixture(d1, 10);
  sqlite.exec(`CREATE TABLE update_observations(id INTEGER,kind TEXT);
    CREATE TRIGGER observe_wide AFTER UPDATE OF account_id ON domains_cache BEGIN
      INSERT INTO update_observations VALUES(NEW.id,'indexed'); END;
    CREATE TRIGGER observe_time AFTER UPDATE OF updated_at ON domains_cache BEGIN
      INSERT INTO update_observations VALUES(NEW.id,'time'); END`);
  await d1.batch(snapshotWrites(d1,true));
  await d1.batch(snapshotWrites(d1,true));
  const counts = sqlite.prepare("SELECT kind,COUNT(*) n FROM update_observations GROUP BY kind ORDER BY kind").all();
  assert.deepEqual(counts.map(r => [r.kind,r.n]), [["indexed",20],["time",20]]);
});

test("the whole staged observation uses one UTC second, including when execution starts later", async t => {
  const { d1, sqlite } = await testDatabase(t);
  await seedSnapshotFixture(d1, 10);
  sqlite.exec("UPDATE sync_rows SET payload=json_set(payload,'$.remote_id','new') WHERE domain_id=1");
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-19T23:59:59.999Z") });
  const statements = snapshotWrites(d1, true);
  t.mock.timers.tick(2000);
  const results = await d1.batch(statements);
  assert.deepEqual(results.map(r => r.meta.changes), [1, 9], "no double touch for the changed row");
  assert.deepEqual(sqlite.prepare("SELECT DISTINCT updated_at FROM domains_cache").all().map(r => r.updated_at), ["2026-09-19 23:59:59"]);
});

test("inventory, deletion and cursor use one lease decision at the edge of the batch", async t => {
  const { d1, sqlite } = await testDatabase(t);
  await seedSnapshotFixture(d1, 10);
  sqlite.exec("UPDATE sync_work SET lease_until=101");
  let clock = 100;
  const queue = new SyncWorkQueue(versionedCatalogDatabase(d1), () => clock++);
  const work = (await queue.jobs("test"))[0];
  await queue.writeDomains(work, { phase: "renew", total: 10 });
  assert.equal(JSON.parse((await queue.jobs("test"))[0].cursor).phase, "renew");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM domains_cache WHERE updated_at='2000-01-01 00:00:00'").get()?.n, 0);
});
