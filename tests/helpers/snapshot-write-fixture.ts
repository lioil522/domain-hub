import { stagedDomainWrites } from "../../src/db/dao/domain-dao";
import { versionedCatalogDatabase } from "../../src/db/catalog-version";

const JOB = "snapshot-write-fixture";
const guard = { sql: "EXISTS(SELECT 1 FROM sync_work WHERE id=? AND status='running' AND lease_token=?)", bindings: [JOB, "owned"] };
const stale = "2000-01-01 00:00:00";
export async function seedSnapshotFixture(db: D1Database, count: number) {
  if (!Number.isInteger(count) || count < 10 || count > 10000 || count % 10) throw new Error("Invalid fixture size");
  const seq = "WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<?)";
  await db.batch([
    db.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'one','test1','fake','dnshe'),(2,'two','test2','fake','dnshe')"),
    db.prepare("INSERT INTO actions(id,type,status) VALUES('test','sync','running')"),
    db.prepare(`INSERT INTO sync_work(id,action_id,account_id,alias,fingerprint,status,cursor,deadline_at,created_at,updated_at,lease_token,lease_until)
      VALUES(?,'test',1,'one','dummy','running','{"phase":"write"}',1,0,0,'owned',?)`).bind(JOB, Number.MAX_SAFE_INTEGER),
    db.prepare(`${seq} INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,created_at,expires_at,has_dns,dns_provider,updated_at)
      SELECT i,1,'','example','host-'||i||'.example','已解析','2025-01-01','2027-01-01',1,'system',? FROM seq`).bind(count, stale),
    db.prepare(`${seq} INSERT INTO sync_rows(job_id,domain_id,payload,enriched)
      SELECT ?,i,json_object('id',i,'full_domain','host-'||i||'.example','rootdomain','example',
        'expires_at','2027-01-01','created_at','2025-01-01','status','已解析','has_dns',1,'dns_provider','system','dns_state_known',1),1 FROM seq`).bind(count, JOB),
  ]);
}
export function snapshotWrites(db: D1Database, optimized: boolean, lease = guard) {
  if (optimized) return stagedDomainWrites(db, 1, JOB, lease);
  // Frozen expansion of the 2fb3b1a persisted-snapshot UPSERT. Independent
  // oracle: a mistake in the new field comparisons must not affect both arms.
  const f = (key: string) => `json_extract(r.payload,'$.${key}')`;
  const known = "EXISTS(SELECT 1 FROM sync_rows WHERE job_id=? AND domain_id=excluded.id AND json_extract(payload,'$.dns_state_known')=1)";
  return [db.prepare(`INSERT INTO domains_cache
    (id,account_id,subdomain,rootdomain,full_domain,status,created_at,expires_at,has_dns,dns_provider,provider_account_id,remote_id,updated_at)
    SELECT ${f("id")},?,COALESCE(${f("subdomain")},''),COALESCE(${f("rootdomain")},''),${f("full_domain")},
      CASE WHEN ${f("dns_state_known")}=1 OR ${f("status")} IN ('已解析','已委派','未解析') THEN COALESCE(${f("status")},'未解析') ELSE '未解析' END,
      COALESCE(${f("created_at")},''),COALESCE(${f("expires_at")},''),COALESCE(${f("has_dns")},1),${f("dns_provider")},
      CAST(${f("provider_account_id")} AS TEXT),${f("remote_id")},CURRENT_TIMESTAMP
    FROM sync_rows r WHERE r.job_id=? AND ${lease.sql}
    ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,
      status=CASE WHEN ${known} THEN excluded.status ELSE domains_cache.status END,
      has_dns=CASE WHEN ${known} THEN excluded.has_dns ELSE domains_cache.has_dns END,
      dns_provider=CASE WHEN ${known} THEN COALESCE(excluded.dns_provider,domains_cache.dns_provider) ELSE domains_cache.dns_provider END,
      created_at=COALESCE(NULLIF(excluded.created_at,''),domains_cache.created_at),expires_at=excluded.expires_at,
      provider_account_id=COALESCE(excluded.provider_account_id,domains_cache.provider_account_id),
      remote_id=COALESCE(excluded.remote_id,domains_cache.remote_id),updated_at=excluded.updated_at`)
    .bind(1, JOB, ...lease.bindings, JOB, JOB, JOB)];
}

/** Isolate the inventory write phase. Both variants use the real revision wrapper;
 * seed, aging, verification, staging, checkpoints and deletion are outside the meter. */
export async function measureSnapshotWrites(db: D1Database, n: number, optimized: boolean) {
  await seedSnapshotFixture(db, n);
  const versioned = versionedCatalogDatabase(db);
  const samples = [];
  for (const scenario of ["same", "tenPercent", "all"]) {
    for (let iteration = 0; iteration < 3; iteration++) {
      await db.batch([
        db.prepare("UPDATE domains_cache SET expires_at='2027-01-01',updated_at=?").bind(stale),
        db.prepare(`UPDATE sync_rows SET payload=json_set(payload,'$.expires_at',CASE WHEN domain_id<=? THEN '2028-01-01' ELSE '2027-01-01' END) WHERE job_id=?`)
          .bind(scenario === "same" ? 0 : scenario === "tenPercent" ? n / 10 : n, JOB),
      ]);
      const statements = snapshotWrites(versioned, optimized);
      const start = performance.now();
      const result = await versioned.batch(statements);
      const ms = performance.now() - start;
      const check = await db.prepare("SELECT COUNT(*) n,SUM(updated_at IS NULL OR updated_at=?) stale,SUM(expires_at='2028-01-01') changed FROM domains_cache")
        .bind(stale).first<{ n: number; stale: number; changed: number }>();
      if (check?.n !== n || check.stale !== 0 || check.changed !== (scenario === "same" ? 0 : scenario === "all" ? n : n / 10))
        throw new Error(`Snapshot fixture failed for ${scenario}`);
      // The binding strips the revision write's result before returning metrics.
      samples.push({ scenario, iteration, ms, writes: result.reduce((s, r) => s + r.meta.rows_written, 0),
        reads: result.reduce((s, r) => s + r.meta.rows_read, 0) });
    }
  }
  return samples;
}
