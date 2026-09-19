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
    const current = await this.get(id);
    if (!current) throw new Error(`Action ${id} not found`);
    const next = { ...current, ...patch };
    await this.db.executeRaw(`
      UPDATE actions SET status = ?, progress = ?, started_at = ?, finished_at = ?, error = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [next.status, next.progress, next.started_at || null, next.finished_at || null, next.error || null, JSON.stringify(next.metadata ?? null), id]);
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
