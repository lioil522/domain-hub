import { ConflictError, ValidationError } from "../../errors";
import { BACKUP_IMPORT_LIMIT, BACKUP_PLAN, normalizeBackup, type BackupRow, type BackupSnapshot } from "../backup-snapshot";
import { diffBackup } from "../backup-diff";
import { backupChecksum, backupKeyId, verifyBackupIntegrity } from "../backup-integrity";
import { SCHEMA_VERSION } from "../schema-definition";
import { DATA_EXPORT_VERSION } from "../types";

/** One read transaction, fixed columns only; no settings, sessions or operator-added fields. */
export async function readBackupData(db: D1Database): Promise<BackupSnapshot & { counts: Record<string, number> }> {
  const results = await db.batch<Record<string, unknown>>(BACKUP_PLAN.map(step =>
    db.prepare(`SELECT ${step.columns.join(", ")} FROM ${step.table} ORDER BY id`)));
  if (results.some(result => !result.success)) throw new Error("读取业务备份失败");
  const data: Record<string, unknown[]> = {}, counts: Record<string, number> = {};
  BACKUP_PLAN.forEach((step, index) => {
    data[step.table] = results[index].results;
    counts[step.table] = data[step.table].length;
  });
  return { version: DATA_EXPORT_VERSION, exported_at: new Date().toISOString(), counts, data };
}

export async function exportAllData(db: D1Database, aesKey?: string) {
  const raw = await readBackupData(db);
  const snapshot = normalizeBackup(raw);
  await verifyBackupIntegrity(raw, snapshot, aesKey);
  snapshot.metadata = { scope: "business", schema_version: SCHEMA_VERSION, key_id: await backupKeyId(aesKey), checksum: "0".repeat(64) };
  snapshot.metadata.checksum = await backupChecksum(snapshot);
  return { ...snapshot, counts: raw.counts, data: snapshot.data as Record<string, unknown[]> };
}

export async function previewAllData(db: D1Database, input: unknown, aesKey?: string) {
  const snapshot = normalizeBackup(input);
  await verifyBackupIntegrity(input as BackupSnapshot, snapshot, aesKey);
  return diffBackup(await readBackupData(db), snapshot);
}

/**
 * Fence numeric and natural identities inside the write transaction. An invalid
 * INTEGER PRIMARY KEY deliberately aborts the whole batch instead of silently
 * skipping a conflicted row and committing its siblings.
 */
function guardedUpsert(db: D1Database, step: (typeof BACKUP_PLAN)[number], row: BackupRow) {
  let natural = step.identity.map(column => `${column} IS ?`).join(" AND ");
  let guardBinds: Array<string | number | null> = step.identity.map(column => row[column]);
  if (step.table === "accounts") {
    // api_key is globally unique even across providers.
    natural = "api_key IS ?";
    guardBinds = [row.api_key];
  }
  if (step.table === "domains_cache") {
    natural = "account_id IS ? AND (full_domain IS ? OR (? IS NOT NULL AND remote_id IS ?))";
    guardBinds = [row.account_id, row.full_domain, row.remote_id, row.remote_id];
  }
  let guard = `EXISTS (SELECT 1 FROM ${step.table} WHERE (${natural}) AND id != ?)`;
  guardBinds.push(row.id);
  if (step.table === "custom_domains" && row.account_id !== null) {
    guard += " OR EXISTS (SELECT 1 FROM custom_accounts WHERE id = ? AND group_id IS NOT ?)";
    guardBinds.push(row.account_id, row.group_id);
  }
  const identity = step.identity.map(column => `${step.table}.${column} IS excluded.${column}`).join(" AND ");
  const updates = step.columns.filter(column => column !== "id").map(column => `${column}=excluded.${column}`);
  const sql = `INSERT INTO ${step.table} (${step.columns.join(", ")})
    SELECT CASE WHEN ${guard} THEN 'backup_identity_conflict' ELSE ? END, ${step.columns.slice(1).map(() => "?").join(", ")}
    WHERE 1
    ON CONFLICT(id) DO UPDATE SET
      id=CASE WHEN ${identity} THEN ${step.table}.id ELSE 'backup_identity_conflict' END, ${updates.join(", ")}`;
  return db.prepare(sql).bind(...guardBinds, ...step.columns.map(column => row[column]));
}

export async function importAllData(db: D1Database, input: unknown, aesKey?: string): Promise<{ imported: Record<string, number> }> {
  const snapshot = normalizeBackup(input);
  const count = BACKUP_PLAN.reduce((n, step) => n + snapshot.data[step.table].length, 0);
  if (count > BACKUP_IMPORT_LIMIT) throw new ValidationError(`本次导入 ${count} 行，超过直接导入上限 ${BACKUP_IMPORT_LIMIT} 行；请使用分段恢复，不要拆文件破坏引用关系`);
  await verifyBackupIntegrity(input as BackupSnapshot, snapshot, aesKey);
  const diff = diffBackup(await readBackupData(db), snapshot);
  if (diff.totalConflicts) throw new ConflictError(`备份有 ${diff.totalConflicts} 项身份或引用冲突，请先查看预览并显式解决 ID 映射`, "backup_conflict");
  const statements = BACKUP_PLAN.flatMap(step => snapshot.data[step.table].map(row => guardedUpsert(db, step, row)));
  if (statements.length) {
    try { await db.batch(statements); }
    catch (error) {
      if (error instanceof Error && /datatype mismatch/i.test(error.message)) throw new ConflictError("目标业务身份在预览后发生变化，整批已回滚，请重新预览", "backup_conflict");
      throw error;
    }
  }
  return { imported: Object.fromEntries(BACKUP_PLAN.map(step => [step.table, snapshot.data[step.table].length])) };
}
