import type { DatabaseManager } from "../db";
import type { ScannerJobModel, ScannerJobStatus } from "../types/scanner";

type ScannerRow = {
  id: string;
  status: ScannerJobStatus;
  cursor: string | null;
  total_checked: number | string | null;
  available: number | string | null;
  registered: number | string | null;
  failed: number | string | null;
  started_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
  error: string | null;
};

export class ScannerRepository {
  constructor(private readonly db: DatabaseManager) {}

  async save(job: ScannerJobModel): Promise<void> {
    await this.db.executeRaw(`
      INSERT INTO scanner_jobs (id, status, cursor, total_checked, available, registered, failed, started_at, updated_at, finished_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, cursor=excluded.cursor, total_checked=excluded.total_checked,
        available=excluded.available, registered=excluded.registered, failed=excluded.failed,
        started_at=excluded.started_at, updated_at=CURRENT_TIMESTAMP, finished_at=excluded.finished_at, error=excluded.error
    `, [job.id, job.status, job.cursor, job.totalChecked, job.available, job.registered, job.failed, job.startedAt || null, job.finishedAt || null, job.error || null]);
  }

  async get(id: string): Promise<ScannerJobModel | null> {
    const row = await this.db.firstRaw<ScannerRow>("SELECT * FROM scanner_jobs WHERE id = ?", [id]);
    return row ? this.fromRow(row) : null;
  }

  async list(limit = 50): Promise<ScannerJobModel[]> {
    const rows = await this.db.allRaw<ScannerRow>("SELECT * FROM scanner_jobs ORDER BY updated_at DESC LIMIT ?", [limit]);
    return rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: ScannerRow): ScannerJobModel {
    return {
      id: String(row.id),
      status: row.status,
      cursor: String(row.cursor || ""),
      totalChecked: Number(row.total_checked || 0),
      available: Number(row.available || 0),
      registered: Number(row.registered || 0),
      failed: Number(row.failed || 0),
      startedAt: row.started_at || undefined,
      updatedAt: row.updated_at || undefined,
      finishedAt: row.finished_at || undefined,
      error: row.error || undefined,
    };
  }
}
