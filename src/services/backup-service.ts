import { BackupRepository } from "../repositories/backup-repository";
import type { DatabaseManager } from "../db";
import { normalizeBackup, type BackupSnapshot } from "../db/backup-snapshot";
import { diffBackup } from "../db/backup-diff";

export type { BackupSnapshot } from "../db/backup-snapshot";
export type { BackupDiff, BackupDiffItem } from "../db/backup-diff";

export class BackupService {
  private readonly repository: BackupRepository;
  constructor(db: DatabaseManager) { this.repository = new BackupRepository(db); }

  exportSnapshot(): Promise<BackupSnapshot> { return this.repository.exportAll(); }
  validate(snapshot: unknown): snapshot is BackupSnapshot {
    try { normalizeBackup(snapshot); return true; } catch { return false; }
  }
  preview(incoming: unknown) { return this.repository.preview(incoming); }
  diff(current: BackupSnapshot, incoming: BackupSnapshot) { return diffBackup(current, incoming); }
  restore(snapshot: unknown) { return this.repository.importAll(snapshot); }
}
