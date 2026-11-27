// Experiment only: install on a fresh isolated fixture, never via a migration.
import { domainKeyCandidates } from "../../shared/domain-keys";
import { buildDomainJsonUpsert } from "../../src/db/dao/domain-dao";
import { RDAP_CACHE_PREFIX } from "../../src/db/types";

const journal = "test_catalog_journal";
const projection = "test_catalog_dependencies";
const tables = [
  { table: "domains_cache", key: "id", name: "full_domain", fields: ["account_id", "full_domain", "rootdomain", "has_dns", "created_at", "expires_at", "status"] },
  { table: "custom_domains", key: "id", name: "full_domain", fields: ["group_id", "full_domain", "expires_at"] },
  { table: "domain_date_overrides", key: "id", name: "full_domain", fields: ["account_id", "full_domain", "expires_at", "updated_at"] },
  { table: "accounts", key: "id", name: null, fields: ["alias", "provider"] },
  { table: "cache", key: "key", name: "key", fields: ["value", "expires_at"] },
] as const;

function triggerSql() {
  return tables.flatMap(({ table, key, name, fields }) => (["INSERT", "UPDATE", "DELETE"] as const).map(op => {
    const from = op !== "INSERT", to = op !== "DELETE";
    const matches = (ref: string) => `substr(${ref}.key,1,${RDAP_CACHE_PREFIX.length})='${RDAP_CACHE_PREFIX}'`;
    const guard = [
      ...(table === "cache" ? [`(${[...(from ? [matches("old")] : []), ...(to ? [matches("new")] : [])].join(" OR ")})`] : []),
      ...(op === "UPDATE" ? [`(${[key, ...fields].map(field => `old.${field} IS NOT new.${field}`).join(" OR ")})`] : []),
    ];
    const project = (ref: string, present: boolean) => !present || !name ? "NULL" :
      table === "cache" ? `CASE WHEN ${matches(ref)} THEN substr(${ref}.key,${RDAP_CACHE_PREFIX.length + 1}) END` : `${ref}.${name}`;
    return `CREATE TRIGGER test_capture_${table}_${op.toLowerCase()} AFTER ${op} ON ${table}
      ${guard.length ? "WHEN " + guard.join(" AND ") : ""} BEGIN
      INSERT INTO ${journal}(entity,op,old_id,new_id,old_name,new_name)
      VALUES('${table}','${op}',${from ? `old.${key}` : "NULL"},${to ? `new.${key}` : "NULL"},${project("old", from)},${project("new", to)});
      END`;
  }));
}

async function all<T>(db: D1Database, sql: string, args: unknown[] = []) {
  const result = await db.prepare(sql).bind(...args).all<T>();
  if (!result.success || !Array.isArray(result.results)) throw new Error("Fixture read failed");
  return result.results;
}
async function batch(db: D1Database, statements: D1PreparedStatement[]) {
  const result = await db.batch(statements);
  if (result.length !== statements.length || result.some(r => !r.success)) throw new Error("Fixture transaction failed");
  return result;
}

export async function installCapture(db: D1Database) {
  await batch(db, [
    `CREATE TABLE ${journal}(seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, op TEXT NOT NULL,
      old_id, new_id, old_name TEXT, new_name TEXT)`,
    ...triggerSql(),
  ].map(sql => db.prepare(sql)));
}

export interface CaptureEvent {
  seq: number; entity: string; op: string; old_id: number | string | null; new_id: number | string | null;
  old_name: string | null; new_name: string | null;
}
export function readJournal(db: D1Database, after = 0, limit = 256) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid journal range");
  return all<CaptureEvent>(db, `SELECT * FROM ${journal} WHERE seq>? ORDER BY seq LIMIT ?`, [after, limit]);
}

type Scope = "domains_cache" | "custom_domains";
type SourceRow = { id: number; owner: number; full_domain: string };
export async function installDependencies(db: D1Database) {
  await batch(db, [
    `CREATE TABLE ${projection}(entity TEXT NOT NULL, id INTEGER NOT NULL, owner INTEGER NOT NULL,
      canonical TEXT NOT NULL, alternate TEXT, PRIMARY KEY(entity,id)) WITHOUT ROWID`,
    `CREATE INDEX test_catalog_by_canonical ON ${projection}(canonical)`,
    `CREATE INDEX test_catalog_by_alternate ON ${projection}(alternate) WHERE alternate IS NOT NULL`,
    `CREATE INDEX test_catalog_by_owner ON ${projection}(owner)`,
  ].map(sql => db.prepare(sql)));
}
function sourceSql(scope: Scope) {
  return `SELECT id,${scope === "domains_cache" ? "account_id" : "group_id"} owner,full_domain FROM ${scope}`;
}
function storeDependencies(db: D1Database, scope: Scope, rows: SourceRow[]) {
  return db.prepare(`INSERT INTO ${projection}(entity,id,owner,canonical,alternate)
    SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]')
    FROM json_each(?) WHERE 1
    ON CONFLICT(entity,id) DO UPDATE SET owner=excluded.owner,canonical=excluded.canonical,alternate=excluded.alternate
    WHERE owner IS NOT excluded.owner OR canonical IS NOT excluded.canonical OR alternate IS NOT excluded.alternate`)
    .bind(scope, JSON.stringify(rows.map(row => {
      const [key, other] = domainKeyCandidates(row.full_domain);
      return [row.id, row.owner, key, other ?? null];
    })));
}
export async function bootstrapDependencies(db: D1Database) {
  for (const scope of ["domains_cache", "custom_domains"] as const) {
    let after = -1;
    for (;;) {
      const rows = await all<SourceRow>(db, `${sourceSql(scope)} WHERE id>? ORDER BY id LIMIT 256`, [after]);
      if (!rows.length) break;
      await batch(db, [storeDependencies(db, scope, rows)]);
      after = rows.at(-1)!.id;
    }
  }
}

// Quiescent experiment: apply a committed journal page against the current
// fixture. No durable consumption, transaction fencing or consumer checkpoint
// is inferred from this. Account/date events do not change spatial membership.
export async function refreshDependencies(db: D1Database, events: readonly CaptureEvent[]) {
  if (events.length > 256) throw new Error("Fixture replay budget exceeded");
  const statements: D1PreparedStatement[] = [];
  for (const scope of ["domains_cache", "custom_domains"] as const) {
    const ids = new Set<number>();
    for (const event of events) if (event.entity === scope) {
      for (const id of [event.old_id, event.new_id]) if (typeof id === "number") ids.add(id);
    }
    if (!ids.size) continue;
    const rows = await all<SourceRow>(db, `${sourceSql(scope)} WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify([...ids])]);
    for (const row of rows) ids.delete(row.id);
    if (ids.size) statements.push(db.prepare(`DELETE FROM ${projection} WHERE entity=? AND id IN (SELECT value FROM json_each(?))`)
      .bind(scope, JSON.stringify([...ids])));
    if (rows.length) statements.push(storeDependencies(db, scope, rows));
  }
  return statements.length ? batch(db, statements) : [];
}
export function findDateDependents(db: D1Database, key: string) {
  return all<{ canonical: string }>(db, `SELECT DISTINCT canonical FROM ${projection} WHERE canonical=? OR alternate=? ORDER BY canonical`, [key, key]);
}
export function findOwnerDependents(db: D1Database, owner: number) {
  return all<{ canonical: string }>(db, `SELECT DISTINCT canonical FROM ${projection} WHERE owner=? ORDER BY canonical`, [owner]);
}

export async function seedCaptureFixture(db: D1Database, n: number) {
  if (!Number.isInteger(n) || n < 10 || n > 10000 || n % 10) throw new Error("Fixture size must be 10..10,000 and divisible by 10");
  await batch(db, [
    db.prepare(`INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES
      (1,'managed','fixture-one','fixture-private-one','dnshe'),(2,'custom','fixture-two','fixture-private-two','custom')`),
    db.prepare(`INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at)
      SELECT value,1,'','example','item-'||value||'.example','已解析','2027-01-01' FROM json_each(?)`).bind(JSON.stringify(Array.from({ length: n }, (_, i) => i + 1))),
    db.prepare(`INSERT INTO custom_accounts(id,group_id,name) VALUES(21,2,'subaccount')`),
    db.prepare(`INSERT INTO custom_domains(id,group_id,account_id,full_domain,expires_at) VALUES(1,2,21,?,'2027-01-01')`).bind("\u200b.item-1.example"),
    db.prepare(`INSERT INTO domain_date_overrides(id,account_id,full_domain,expires_at) VALUES(1,1,'item-1.example','2027-01-02')`),
  ]);
}

// Same production UPSERT helper and anti-join shape used by sync; fixture IDs
// and no lease/network. Does not pretend to execute the entire sync workflow.
export function fixtureSync(db: D1Database, n: number) {
  const patch = JSON.stringify(Array.from({ length: n }, (_, i) => ({
    id: i + n / 10 + 1, rootdomain: "example", full_domain: `item-${i + n / 10 + 1}.example`,
    expires_at: i < n / 10 ? "2027-02-01" : "2027-01-01", status: "已解析", has_dns: 1,
  })));
  return batch(db, [
    buildDomainJsonUpsert(db, 1, { from: "json_each(?) j", json: "j.value", where: "1", bindings: [patch] }, { sql: "1", bindings: [] }),
    db.prepare(`DELETE FROM domains_cache WHERE account_id=1 AND id NOT IN
      (SELECT json_extract(value,'$.id') FROM json_each(?))`).bind(patch),
  ]);
}

// Caller provisions a NEW database per mode. No startup/install/backfill
// writes are included in the operation timings; backfill is reported separately.
export async function measureCapture(db: D1Database, n: number, captured: boolean) {
  const stats = (results: D1Result<unknown>[]) => results.reduce((sum, r) => ({
    writes: sum.writes + r.meta.rows_written, changes: sum.changes + r.meta.changes,
  }), { writes: 0, changes: 0 });
  const timed = async (run: () => Promise<D1Result<unknown>[]>) => {
    const start = performance.now(), results = await run();
    return { ms: performance.now() - start, ...stats(results) };
  };
  await seedCaptureFixture(db, n);
  let bootstrapMs = 0;
  if (captured) {
    await installCapture(db);
    await installDependencies(db);
    const start = performance.now();
    await bootstrapDependencies(db);
    bootstrapMs = performance.now() - start;
  }
  let after = 0;
  const replay = async () => {
    let events = 0, changes = 0, writes = 0;
    const start = performance.now();
    if (captured) for (;;) {
      const page = await readJournal(db, after);
      if (!page.length) break;
      events += page.length;
      const cost = stats(await refreshDependencies(db, page));
      changes += cost.changes; writes += cost.writes;
      after = page.at(-1)!.seq;
    }
    return { events, changes, writes, ms: performance.now() - start };
  };
  const sync = await timed(() => fixtureSync(db, n));
  const syncReplay = await replay();
  const repeat = await timed(() => fixtureSync(db, n));
  const repeatReplay = await replay();
  const date = await timed(() => batch(db, [db.prepare("UPDATE domain_date_overrides SET expires_at='2027-03-01' WHERE id=1")]));
  const dateReplay = await replay();
  const cascade = await timed(() => batch(db, [db.prepare("DELETE FROM accounts WHERE id=1")]));
  const cascadeReplay = await replay();
  return { n, captured, bootstrapMs, sync, syncReplay, repeat, repeatReplay, date, dateReplay, cascade, cascadeReplay };
}
