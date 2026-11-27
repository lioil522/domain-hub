import assert from "node:assert/strict";
import { test } from "node:test";
import { testDatabase } from "../helpers/database";
import { versionedCatalogDatabase } from "../../src/db/catalog-version";
import { RDAP_CACHE_PREFIX } from "../../src/db/types";
import {
  installCapture, installDependencies, bootstrapDependencies, readJournal, refreshDependencies,
  findDateDependents, findOwnerDependents, fixtureSync, seedCaptureFixture,
  claimDirty, ackDirty, eventKeys, measureDirtyQueue,
} from "../prototypes/catalog-write-capture";

test("actual JSON upsert plus difference deletion captures only relevant row changes", async t => {
  const { d1, sqlite } = await testDatabase(t);
  await seedCaptureFixture(d1, 100);
  await installCapture(d1);
  await fixtureSync(versionedCatalogDatabase(d1), 100);
  const events = await readJournal(d1);
  for (const op of ["UPDATE", "INSERT", "DELETE"]) assert.equal(events.filter(e => e.op === op).length, 10);
  assert.ok(events.every(e => e.entity === "domains_cache"));
  assert.equal(events.find(e => e.op === "DELETE")?.new_name, null);
  assert.equal(events.find(e => e.op === "INSERT")?.old_name, null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM domains_cache").get()?.n, 100);
  assert.equal(typeof sqlite.prepare("SELECT value FROM settings WHERE key='catalog_summary_revision'").get()?.value, "string");
  const last = events.at(-1)!.seq;
  await fixtureSync(versionedCatalogDatabase(d1), 100);
  assert.deepEqual(await readJournal(d1, last), []);
});

test("catalog transaction and journal roll back together on a later statement failure or journal failure", async t => {
  const { d1, sqlite } = await testDatabase(t);
  await seedCaptureFixture(d1, 10);
  await installCapture(d1);
  const db = versionedCatalogDatabase(d1);
  await assert.rejects(() => db.batch([
    db.prepare("UPDATE domains_cache SET full_domain='new.example' WHERE id=1"),
    db.prepare("UPDATE domains_cache SET account_id=-1 WHERE id=2"),
  ]), /FOREIGN KEY/);
  assert.deepEqual(await readJournal(d1), []);
  sqlite.exec(`CREATE TRIGGER fixture_reject_journal BEFORE INSERT ON test_catalog_journal
    BEGIN SELECT RAISE(ABORT,'fixture journal failure'); END`);
  await assert.rejects(() => db.prepare("DELETE FROM accounts WHERE id=1").run(), /fixture journal failure/);
  assert.equal(sqlite.prepare("SELECT full_domain FROM domains_cache WHERE id=1").get()?.full_domain, "item-1.example");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM domain_date_overrides").get()?.n, 1);
  assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key='catalog_summary_revision'").get(), undefined);
});

test("account and custom subaccount cascades retain child tombstones without joining deleted parents", async t => {
  const { d1 } = await testDatabase(t);
  await seedCaptureFixture(d1, 10);
  await installCapture(d1);
  await d1.prepare("DELETE FROM custom_accounts WHERE id=21").run();
  await d1.prepare("DELETE FROM accounts WHERE id=1").run();
  const events = await readJournal(d1);
  assert.deepEqual(events.filter(e => e.entity === "custom_domains").map(e => e.old_name), ["\u200b.item-1.example"]);
  assert.deepEqual(events.filter(e => e.entity === "domain_date_overrides").map(e => e.old_name), ["item-1.example"]);
  assert.equal(events.filter(e => e.entity === "domains_cache").length, 10);
  assert.equal(events.filter(e => e.entity === "accounts").length, 1);
  assert.ok(events.every(e => e.op === "DELETE" && e.new_id === null));
  const first = await readJournal(d1, 0, 3);
  assert.deepEqual(await readJournal(d1, first.at(-1)!.seq), events.slice(3));
});

test("manual rename and physical RDAP eviction capture exact keys, never credential or cache payload values", async t => {
  const { d1 } = await testDatabase(t);
  await seedCaptureFixture(d1, 10);
  await installCapture(d1);
  await d1.batch([
    d1.prepare("UPDATE domain_date_overrides SET full_domain='renamed.example' WHERE id=1"),
    d1.prepare("UPDATE accounts SET api_secret='not-for-journal' WHERE id=1"),
    d1.prepare("UPDATE accounts SET alias='changed' WHERE id=1"),
    d1.prepare("INSERT INTO cache(key,value,expires_at) VALUES(?,'not-for-journal',1),('api_cache:dns:1','not-for-journal',1)")
      .bind(`${RDAP_CACHE_PREFIX}old.example`),
    d1.prepare("UPDATE cache SET key=? WHERE key=?").bind(`${RDAP_CACHE_PREFIX}new.example`, `${RDAP_CACHE_PREFIX}old.example`),
    d1.prepare("DELETE FROM cache WHERE expires_at<=1"),
  ]);
  const events = await readJournal(d1);
  assert.deepEqual(events.map(({ entity, op, old_name, new_name }) => [entity, op, old_name, new_name]), [
    ["domain_date_overrides", "UPDATE", "item-1.example", "renamed.example"],
    ["accounts", "UPDATE", null, null],
    ["cache", "INSERT", null, "old.example"], ["cache", "UPDATE", "old.example", "new.example"],
    ["cache", "DELETE", "new.example", null],
  ]);
  assert.ok(!JSON.stringify(events).includes("not-for-journal"));
});

test("quiescent index refresh follows rename, ID movement and deletion without rewriting expiry-only keys", async t => {
  const { d1, sqlite } = await testDatabase(t);
  await seedCaptureFixture(d1, 10);
  await installCapture(d1);
  await installDependencies(d1);
  await bootstrapDependencies(d1);
  const old = await findDateDependents(d1, "item-1.example");
  assert.equal(old.length, 2);
  assert.equal((await findOwnerDependents(d1, 1)).length, 10);
  await d1.batch([
    d1.prepare("UPDATE domains_cache SET full_domain='renamed.example',id=101 WHERE id=1"),
    d1.prepare("UPDATE domains_cache SET expires_at='2027-02-01' WHERE id=2"),
    d1.prepare("DELETE FROM domains_cache WHERE id=3"),
  ]);
  const changes = await refreshDependencies(d1, await readJournal(d1));
  assert.equal(changes.reduce((n, r) => n + r.meta.changes, 0), 3, "two index-row removals and one insertion");
  assert.equal((await findDateDependents(d1, "item-1.example")).length, 1);
  assert.deepEqual((await findDateDependents(d1, "renamed.example")).map(row => row.canonical), ["renamed.example"]);
  assert.equal((await findOwnerDependents(d1, 1)).length, 9);
  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN SELECT DISTINCT canonical FROM test_catalog_dependencies WHERE canonical=? OR alternate=?`)
    .all("item-1.example", "item-1.example").map(r => r.detail).join(" ");
  assert.match(plan, /test_catalog_by_canonical/);
  assert.match(plan, /test_catalog_by_alternate/);
});

test("REPLACE with recursive triggers off demonstrates a missing tombstone; it is not a supported write shape", async t => {
  const { d1, sqlite } = await testDatabase(t);
  await seedCaptureFixture(d1, 10);
  await installCapture(d1);
  sqlite.exec("PRAGMA recursive_triggers=OFF");
  await d1.prepare(`INSERT OR REPLACE INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at)
    VALUES(1,1,'','example','replacement.example','已解析','2027-01-01')`).run();
  const events = await readJournal(d1);
  assert.equal(events.length, 1);
  assert.equal(events[0].old_name, null, "the implicit deletion did not run the delete trigger");
  assert.equal(events[0].new_name, "replacement.example");
});

test("an in-flight old claim cannot acknowledge a re-dirtied key, even after it is claimed again", async t => {
  const { d1 } = await testDatabase(t);
  await seedCaptureFixture(d1, 10);
  await installCapture(d1, "dirty");
  const update = (date: string) => d1.prepare("UPDATE domains_cache SET expires_at=? WHERE id=1").bind(date).run();
  await update("2027-02-01");
  const first = await claimDirty(d1, 0);
  assert.equal(first.keys.length, 2);
  assert.equal((await claimDirty(d1, 1)).keys.length, 0);
  await update("2027-03-01");
  assert.equal((await ackDirty(d1, 2, first)).removed, 0);
  const second = await claimDirty(d1, 3);
  assert.deepEqual(second.keys, first.keys);
  assert.notEqual(first.token, second.token);
  assert.equal((await ackDirty(d1, 4, first)).removed, 0);
  assert.equal((await ackDirty(d1, 5, second)).removed, 2);
  await update("2027-04-01");
  const third = await claimDirty(d1, 6);
  assert.equal((await ackDirty(d1, 7, second)).removed, 0, "delete and re-insert must not resurrect an old claim");
  assert.equal((await ackDirty(d1, 30_006, third)).removed, 0, "expired claims cannot ack");
  const recovered = await claimDirty(d1, 30_006);
  assert.deepEqual(recovered.keys, third.keys);
  assert.equal((await ackDirty(d1, 30_007, recovered)).removed, 2);
});

test("rollback preserves the previously claimed work and does not leak new raw keys or date scopes", async t => {
  const { d1 } = await testDatabase(t);
  await seedCaptureFixture(d1, 10);
  await installCapture(d1, "dirty");
  await d1.prepare("UPDATE domains_cache SET expires_at='2027-02-01' WHERE id=1").run();
  const claim = await claimDirty(d1, 0);
  await assert.rejects(() => d1.batch([
    d1.prepare("UPDATE domains_cache SET full_domain='never-commit.example' WHERE id=1"),
    d1.prepare("UPDATE domain_date_overrides SET full_domain='never-commit.example' WHERE id=1"),
    d1.prepare("UPDATE domains_cache SET account_id=-1 WHERE id=2"),
  ]), /FOREIGN KEY/);
  assert.equal((await claimDirty(d1, 1)).keys.length, 0);
  assert.equal((await ackDirty(d1, 2, claim)).removed, 2);
  assert.equal((await claimDirty(d1, 3)).keys.length, 0);
});

test("coalescing preserves all raw rename and cascade keys even when no intermediate row survives", async t => {
  const journal = await testDatabase(t), dirty = await testDatabase(t);
  for (const [db, mode] of [[journal.d1, "journal"], [dirty.d1, "dirty"]] as const) {
    await seedCaptureFixture(db, 10);
    await installCapture(db, mode);
    await db.batch([
      db.prepare("UPDATE domains_cache SET full_domain='intermediate.example' WHERE id=1"),
      db.prepare("UPDATE domains_cache SET id=101,full_domain='new.example' WHERE id=1"),
      db.prepare("UPDATE domain_date_overrides SET full_domain='new.example' WHERE id=1"),
      db.prepare("INSERT INTO cache(key,value,expires_at) VALUES(?,'fixture',1)").bind(`${RDAP_CACHE_PREFIX}新.example`),
      db.prepare("UPDATE cache SET key='api_cache:dns:1' WHERE key=?").bind(`${RDAP_CACHE_PREFIX}新.example`),
      db.prepare("DELETE FROM accounts WHERE id=1"),
    ]);
  }
  const set = (keys: ReturnType<typeof eventKeys>) => [...new Set(keys.map(({ kind, key }) => JSON.stringify([kind,key])))].sort();
  const claim = await claimDirty(dirty.d1, 0);
  assert.deepEqual(set(claim.keys), set((await readJournal(journal.d1)).flatMap(eventKeys)));
  assert.ok(claim.keys.some(row => row.kind === "name" && row.key === "intermediate.example"));
  assert.ok(claim.keys.some(row => row.kind === "domains_cache" && row.key === 101));
  assert.ok(claim.keys.some(row => row.kind === "date" && row.key === "新.example"));
});

test("bounded dirty claims and log pages deliver the same keys at different backlog sizes", async t => {
  const journal = await testDatabase(t), dirty = await testDatabase(t);
  const a = await measureDirtyQueue(journal.d1, 300, "journal");
  const b = await measureDirtyQueue(dirty.d1, 300, "dirty");
  for (const phase of ["sync", "hot", "cascade"] as const) {
    assert.equal(a[phase].digest, b[phase].digest);
    assert.equal(a[phase].distinctKeys, b[phase].distinctKeys);
  }
  assert.equal(a.hot.queued, 500);
  assert.equal(b.hot.queued, 40);
  assert.ok(b.cascade.queued > a.cascade.queued, "ID and name keys can amplify low-duplication work");
});
