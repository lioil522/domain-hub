import type { DatabaseManager } from "../db";
import type { BackupMetadata } from "../db/backup-snapshot";

export interface BackupRecord {
  version: number;
  exported_at: string;
  counts?: Record<string, number>;
  data: Record<string, unknown[]>;
  metadata?: BackupMetadata;
}

export class BackupRepository {
  constructor(private readonly db: DatabaseManager) {}
  exportAll(): Promise<BackupRecord> {
    return this.db.exportAllData();
  }
  importAll(snapshot: unknown): Promise<{ imported: Record<string, number> }> {
    return this.db.importAllData(snapshot);
  }
  preview(snapshot: unknown) { return this.db.previewDataImport(snapshot); }
}
