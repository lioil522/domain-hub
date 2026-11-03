import { BackupRepository, type BackupRecord } from "../repositories/backup-repository";
import type { DatabaseManager } from "../db";

export interface BackupSnapshot extends BackupRecord { version: number; exported_at: string; data: Record<string, unknown[]>; }
export interface BackupDiffItem { table: string; add: number; update: number; remove: number; conflicts: number; }
export interface BackupDiff { tables: BackupDiffItem[]; totalAdd: number; totalUpdate: number; totalRemove: number; totalConflicts: number; }

const TABLE_KEYS = ["accounts", "domains_cache", "custom_accounts", "custom_domains", "domain_date_overrides"] as const;

function rowKey(row: unknown): string {
  if (!row || typeof row !== "object") return JSON.stringify(row);
  const value = row as Record<string, unknown>;
  if (value.id !== undefined) return String(value.id);
  if (value.full_domain !== undefined) return String(value.full_domain);
  if (value.alias !== undefined) return String(value.alias);
  return JSON.stringify(value);
}

export class BackupService {
  private readonly repository: BackupRepository;
  constructor(db: DatabaseManager) { this.repository = new BackupRepository(db); }

  async exportSnapshot(): Promise<BackupSnapshot> {
    return this.repository.exportAll();
  }

  validate(snapshot: unknown): snapshot is BackupSnapshot {
    if (!snapshot || typeof snapshot !== "object") return false;
    const value = snapshot as Record<string, unknown>;
    if (value.version !== 1 || typeof value.exported_at !== "string" || !value.data || typeof value.data !== "object") return false;
    const data = value.data as Record<string, unknown>;
    return TABLE_KEYS.every((table) => data[table] === undefined || Array.isArray(data[table]));
  }

  async preview(incoming: unknown): Promise<BackupDiff> {
    if (!this.validate(incoming)) throw new Error("备份文件格式无效或版本不受支持");
    const current = await this.repository.exportAll();
    return this.diff(current, incoming);
  }

  diff(current: BackupSnapshot, incoming: BackupSnapshot): BackupDiff {
    const tables: BackupDiffItem[] = TABLE_KEYS.map((table) => {
      const before = new Map((current.data[table] || []).map((row) => [rowKey(row), row]));
      const after = new Map((incoming.data[table] || []).map((row) => [rowKey(row), row]));
      let add = 0; let update = 0; let remove = 0; let conflicts = 0;
      for (const [key, row] of after) {
        if (!before.has(key)) add++;
        else if (JSON.stringify(before.get(key)) !== JSON.stringify(row)) update++;
      }
      for (const key of before.keys()) if (!after.has(key)) remove++;
      // Current import is merge/upsert, so deletes are informational only; they are never executed.
      conflicts = 0;
      return { table, add, update, remove, conflicts };
    });
    return {
      tables,
      totalAdd: tables.reduce((n, t) => n + t.add, 0),
      totalUpdate: tables.reduce((n, t) => n + t.update, 0),
      totalRemove: tables.reduce((n, t) => n + t.remove, 0),
      totalConflicts: tables.reduce((n, t) => n + t.conflicts, 0),
    };
  }

  restore(snapshot: BackupSnapshot) {
    if (!this.validate(snapshot)) throw new Error("备份文件格式无效或版本不受支持");
    return this.repository.importAll(snapshot);
  }
}
