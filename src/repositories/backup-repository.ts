import type { DatabaseManager } from "../db";

export interface BackupRecord {
  version: number;
  exported_at: string;
  counts?: Record<string, number>;
  data: Record<string, unknown[]>;
}

export class BackupRepository {
  constructor(private readonly db: DatabaseManager) {}
  exportAll(): Promise<BackupRecord> {
    return this.db.exportAllData();
  }
  importAll(snapshot: BackupRecord): Promise<{ imported: Record<string, number> }> {
    return this.db.importAllData(snapshot);
  }
}
