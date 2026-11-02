import type { DatabaseManager } from "../db";
import type { ActionType, ActionStatus } from "../actions/action-types";

export interface StoredAction {
  id: string;
  type: ActionType;
  status: ActionStatus;
  progress: number;
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
  metadata?: unknown;
}

export class ActionRepository {
  constructor(private readonly db: DatabaseManager) {}

  async create(action: StoredAction): Promise<void> {
    await this.db.executeRaw(`
      INSERT INTO actions (id, type, status, progress, started_at, finished_at, error, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [action.id, action.type, action.status, action.progress, action.started_at || null, action.finished_at || null, action.error || null, JSON.stringify(action.metadata ?? null)]);
  }

  async update(id: string, patch: Partial<StoredAction>): Promise<void> {
    const columns = ["status", "progress", "started_at", "finished_at", "error", "metadata"] as const;
    const supplied = columns.filter(column => patch[column] !== undefined);
    if (!supplied.length) return;
    const values = supplied.map(column => column === "metadata" ? JSON.stringify(patch[column]) : patch[column]);
    // No read/merge/full-row write: independent patches cannot overwrite each other.
    // A settled/cancelled Action is immutable, including to a late background runner.
    await this.db.executeRaw(`
      UPDATE actions SET ${supplied.map(column => `${column} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('queued', 'running')
    `, [...values, id]);
  }

  async get(id: string): Promise<StoredAction | null> {
    const row = await this.db.firstRaw<StoredAction>("SELECT * FROM actions WHERE id = ?", [id]);
    if (!row) return null;
    return { ...row, metadata: this.parse(row.metadata) };
  }

  async list(limit = 50): Promise<StoredAction[]> {
    const rows = await this.db.allRaw<StoredAction>("SELECT * FROM actions ORDER BY updated_at DESC LIMIT ?", [limit]);
    return rows.map((row) => ({ ...row, metadata: this.parse(row.metadata) }));
  }

  private parse(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return value; }
  }
}
