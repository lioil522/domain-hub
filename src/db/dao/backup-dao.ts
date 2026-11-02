import { BACKUP_PLAN, validBusinessSnapshot, type BackupRow } from "../backup-format";
import { decryptText, encryptText } from "../crypto";

/** A single read transaction: never export a mixture of before/after states.
 * Fetch limit+1 per table before materialising an unbounded business snapshot. */
export async function exportAllData(db: D1Database) {
  const results = await db.batch<BackupRow>(BACKUP_PLAN.map(p => db.prepare(`SELECT * FROM ${p.table} ORDER BY id LIMIT 501`)));
  if (results.length !== BACKUP_PLAN.length || results.some(r => !r.success)) throw new Error("备份读取失败");
  const data = Object.fromEntries(BACKUP_PLAN.map((p,n) => [p.table, results[n].results]));
  const snapshot = { version: 1, exported_at: new Date().toISOString(), counts: Object.fromEntries(BACKUP_PLAN.map(p => [p.table, data[p.table].length])), data };
  if (!validBusinessSnapshot(snapshot)) throw new Error("业务快照超过500行/8MiB上限或包含无效数据；请使用停写后的数据库/AES成对备份，不导出截断文件");
  return snapshot;
}

/** Merge without destructive ID upserts. Match only persisted provider/key AND
 * verified secret, never an alias. Local IDs map; provider domain IDs stay exact.
 * Every assertion and insert, including audit, commits in ONE batch. Unique/FK
 * or concurrent identity/allocation conflicts roll back; unknowns are not retried.
 */
export async function importAllData(db: D1Database, snapshot: unknown, aesKey?: string, sourceAesKey?: string, dryRun = false) {
  if (!validBusinessSnapshot(snapshot)) throw new Error("备份无效：最多500行/8MiB，必须包含完整父子归属，禁止重复ID和未知表/字段");
  if (sourceAesKey !== undefined && (typeof sourceAesKey !== "string" || !sourceAesKey || sourceAesKey.length > 4096)) throw new Error("源AES密钥参数无效");
  const src = snapshot.data, imported: Record<string, number> = {};
  const mappings: Record<string, Record<string, number>> = Object.fromEntries(BACKUP_PLAN.map(p => [p.table, {}]));
  const allocationSql = (table: string) => table === "domains_cache" ? `(SELECT COALESCE(MAX(id),0) FROM ${table})` :
    `MAX((SELECT COALESCE(MAX(id),0) FROM ${table}),COALESCE((SELECT seq FROM sqlite_sequence WHERE name='${table}'),0))`;
  const reads = await db.batch<{ max: number }>(BACKUP_PLAN.map(p => db.prepare(`SELECT ${allocationSql(p.table)} AS max`)));
  if (reads.length !== 5 || reads.some(r => !r.success)) throw new Error("导入基线读取失败");
  const maxima = Object.fromEntries(BACKUP_PLAN.map((p,n) => [p.table, Number(reads[n].results[0].max)]));
  const baseline = { ...maxima };
  const assertions: D1PreparedStatement[] = [], inserts: D1PreparedStatement[] = [];
  const assert = (sql: string, binds: (string | number | null)[]) => assertions.push(db.prepare(`INSERT INTO sync_commit_assertions(valid) SELECT CASE WHEN ${sql} THEN 1 ELSE 0 END`).bind(...binds));
  for (const p of BACKUP_PLAN) {
    imported[p.table] = 0;
    const rows = src[p.table] || [];
    // One bounded lookup batch per table, never one D1 API call per imported row.
    const lookup = rows.length ? await db.batch<BackupRow>(rows.map(raw => {
      if (p.table === "accounts") return db.prepare("SELECT * FROM accounts WHERE api_key=?").bind(raw.api_key);
      if (p.table === "domains_cache") return db.prepare("SELECT * FROM domains_cache WHERE id=? OR (account_id=? AND full_domain=?)").bind(raw.id, mappings.accounts[String(raw.account_id)], raw.full_domain);
      if (p.table === "custom_accounts") return db.prepare("SELECT * FROM custom_accounts WHERE group_id=? AND name=?").bind(mappings.accounts[String(raw.group_id)], raw.name);
      if (p.table === "custom_domains") return db.prepare("SELECT * FROM custom_domains WHERE group_id=? AND account_id IS ? AND full_domain=?").bind(mappings.accounts[String(raw.group_id)], raw.account_id == null ? null : mappings.custom_accounts[String(raw.account_id)], raw.full_domain);
      return db.prepare("SELECT * FROM domain_date_overrides WHERE account_id=? AND full_domain=?").bind(mappings.accounts[String(raw.account_id)], raw.full_domain);
    })) : [];
    if (lookup.length !== rows.length || lookup.some(r => !r.success || r.results.length > 1)) throw new Error("导入身份读取失败或存在重复归属");
    for (const [index, raw] of rows.entries()) {
      const row: BackupRow = { ...raw };
      const existing = lookup[index].results[0] ?? null;
      if (p.table === "accounts") {
        try {
          const secret = raw.provider === "custom" && raw.api_secret === "" ? "" : await decryptText(String(raw.api_secret), sourceAesKey ?? aesKey);
          if (raw.provider !== "custom" && !secret) throw new Error("empty credential");
          if (existing) {
            const currentSecret = existing.provider === "custom" && existing.api_secret === "" ? "" : await decryptText(String(existing.api_secret), aesKey);
            if (existing.provider !== raw.provider || currentSecret !== secret) throw new Error("identity conflict");
            mappings.accounts[String(raw.id)] = Number(existing.id);
            assert("EXISTS(SELECT 1 FROM accounts WHERE id=? AND api_key=? AND api_secret=? AND provider=?)", [existing.id, existing.api_key, existing.api_secret, existing.provider]);
            continue;
          }
          row.api_secret = await encryptText(secret, aesKey);
        } catch { throw new Error("备份凭据无法验证或与目标账号冲突；未导入，请核对源AES密钥/账号身份（不会输出密钥）"); }
      }
      if (p.table === "custom_accounts" || p.table === "custom_domains") row.group_id = mappings.accounts[String(raw.group_id)];
      if (p.table === "domains_cache" || p.table === "domain_date_overrides") row.account_id = mappings.accounts[String(raw.account_id)];
      if (p.table === "custom_domains" && raw.account_id != null) row.account_id = mappings.custom_accounts[String(raw.account_id)];
      if (existing) {
        if (p.table === "domains_cache" && existing.id !== raw.id) throw new Error("服务商域名ID冲突；不改写远端ID");
        // A merge must not silently overwrite newer user/cache edits. Timestamp
        // fields may differ; all imported substantive fields must match.
        const keys = Object.keys(row).filter(k => k !== "id" && k !== "updated_at");
        if (keys.some(k => (row[k] ?? null) !== (existing![k] ?? null))) throw new Error("目标业务数据冲突；不会覆盖已有域名/日期/自定义账号，请人工选择");
        mappings[p.table][String(raw.id)] = Number(existing.id);
        assert(`EXISTS(SELECT 1 FROM ${p.table} WHERE id=? AND ${keys.map(k => `${k} IS ?`).join(" AND ")})`, [existing.id, ...keys.map(k => existing![k] ?? null)]);
        continue;
      }
      if (p.table !== "domains_cache") {
        maxima[p.table]++; if (!Number.isSafeInteger(maxima[p.table])) throw new Error("本地ID分配超出安全范围");
        row.id = maxima[p.table];
      }
      mappings[p.table][String(raw.id)] = Number(row.id);
      if (p.table === "domains_cache") assert("NOT EXISTS(SELECT 1 FROM domains_cache WHERE id=? OR (account_id=? AND full_domain=?))", [row.id, row.account_id, row.full_domain]);
      if (p.table === "custom_domains" && row.account_id == null) assert("NOT EXISTS(SELECT 1 FROM custom_domains WHERE group_id=? AND account_id IS NULL AND full_domain=?)", [row.group_id, row.full_domain]);
      // Omitted legacy fields retain SQL defaults (timestamps, source, has_dns).
      // Explicit null remains null; don't silently replace it with a new value.
      const columns = p.columns.filter(k => Object.hasOwn(row, k));
      inserts.push(db.prepare(`INSERT INTO ${p.table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).bind(...columns.map(k => row[k])));
      imported[p.table]++;
    }
  }
  if (dryRun) return { imported, mappings };
  // Reject concurrent allocation changes, including insertions at higher IDs
  // that would not collide with our chosen IDs but could duplicate identities.
  for (const p of BACKUP_PLAN) if (p.table !== "domains_cache" && imported[p.table]) assert(`${allocationSql(p.table)}=?`, [baseline[p.table]]);
  const results = await db.batch([
    ...assertions, db.prepare("DELETE FROM sync_commit_assertions"), ...inserts,
    db.prepare("INSERT INTO audit_logs(actor,action,resource_type,result,details) VALUES('session','restore','backup','success',?)").bind(JSON.stringify({ imported, localIdsMapped: true, providerDomainIdsPreserved: true })),
  ]);
  if (results.some(r => !r.success) || results.length !== assertions.length + inserts.length + 2) throw new Error("导入提交结果未确认；请检查审计/目标数据，不自动重试");
  return { imported, mappings };
}
