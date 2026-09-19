import type { DatabaseManager } from "../db";

export interface AuditRecord {
  actor: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  provider?: string | null;
  result: "success" | "failure";
  timestamp?: string;
  details?: unknown;
}

export interface StoredAuditRecord extends AuditRecord {
  id: number;
  resource_type: string;
  created_at: string;
}

function parseDetails(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

export class AuditRepository {
  constructor(private readonly db: DatabaseManager) {}

  async write(record: AuditRecord): Promise<void> {
    await this.db.executeRaw(`
      INSERT INTO audit_logs (actor, action, resource_type, resource_id, provider, result, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [record.actor, record.action, record.resourceType, record.resourceId ?? null, record.provider ?? null, record.result, JSON.stringify(record.details ?? null)]);
  }

  async list(limit = 100): Promise<StoredAuditRecord[]> {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 500);
    const rows = await this.db.allRaw<StoredAuditRecord & { details: string | null }>(
      "SELECT id, actor, action, resource_type, resource_id, provider, result, details, created_at FROM audit_logs ORDER BY id DESC LIMIT ?",
      [safeLimit]
    );
    return rows.map((row) => ({
      ...row,
      details: parseDetails(row.details),
      resourceType: row.resource_type,
      timestamp: row.created_at,
    }));
  }
}
