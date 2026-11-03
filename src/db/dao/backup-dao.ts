/**
 * 数据导入 / 导出（备份与迁移）
 */

import { DATA_EXPORT_VERSION } from "../types";

/**
 * 导出全部业务数据为可移植快照
 *
 * 范围限定在 5 张业务表。settings / logs / cache 故意不导出。
 */
export async function exportAllData(db: D1Database): Promise<{
  version: number;
  exported_at: string;
  counts: Record<string, number>;
  data: Record<string, unknown[]>;
}> {
  const TABLES = [
    "accounts",
    "domains_cache",
    "custom_accounts",
    "custom_domains",
    "domain_date_overrides",
  ] as const;

  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (const table of TABLES) {
    const { results } = await db
      .prepare(`SELECT * FROM ${table}`)
      .all<Record<string, unknown>>();
    data[table] = results || [];
    counts[table] = (results || []).length;
  }

  return {
    version: DATA_EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    counts,
    data,
  };
}

/**
 * 导入业务数据快照（合并 upsert 语义）
 *
 * NOTE: 写入顺序遵循外键依赖：accounts → custom_accounts → custom_domains /
 * domains_cache / domain_date_overrides。
 */
export async function importAllData(db: D1Database, snapshot: {
  version?: number;
  data?: Record<string, unknown[]>;
}): Promise<{ imported: Record<string, number> }> {
  const version = Number(snapshot?.version);
  if (!Number.isFinite(version) || version !== DATA_EXPORT_VERSION) {
    throw new Error(
      `备份文件版本不支持（期望 ${DATA_EXPORT_VERSION}，实际 ${snapshot?.version ?? "缺失"}）`
    );
  }
  const src = snapshot?.data;
  if (!src || typeof src !== "object") {
    throw new Error("备份文件缺少 data 字段");
  }

  const imported: Record<string, number> = {};

  const PLAN: Array<{ table: string; columns: string[]; conflict: string[] }> = [
    {
      table: "accounts",
      columns: ["id", "alias", "api_key", "api_secret", "provider", "website", "created_at"],
      conflict: ["id"],
    },
    {
      table: "custom_accounts",
      columns: ["id", "group_id", "name", "updated_at"],
      conflict: ["id"],
    },
    {
      table: "custom_domains",
      columns: [
        "id", "group_id", "account_id", "full_domain",
        "registered_at", "expires_at", "remark", "updated_at",
      ],
      conflict: ["id"],
    },
    {
      table: "domains_cache",
      columns: [
        "id", "account_id", "subdomain", "rootdomain", "full_domain", "status",
        "created_at", "expires_at", "last_renewed_at", "has_dns", "dns_provider",
        "provider_account_id", "remote_id", "updated_at",
      ],
      conflict: ["id"],
    },
    {
      table: "domain_date_overrides",
      columns: ["id", "account_id", "full_domain", "registered_at", "expires_at", "source", "updated_at"],
      conflict: ["id"],
    },
  ];

  const statements: Array<ReturnType<D1Database["prepare"]>> = [];

  for (const step of PLAN) {
    const rows = Array.isArray(src[step.table]) ? (src[step.table] as unknown[]) : [];
    if (rows.length === 0) {
      imported[step.table] = 0;
      continue;
    }
    const colList = step.columns.join(", ");
    const placeholders = step.columns.map(() => "?").join(", ");
    const updates = step.columns
      .filter((c) => !step.conflict.includes(c))
      .map((c) => `${c} = excluded.${c}`)
      .join(", ");
    const sql = `INSERT INTO ${step.table} (${colList}) VALUES (${placeholders})
      ON CONFLICT(${step.conflict.join(", ")}) DO UPDATE SET ${updates}`;

    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const binds = step.columns.map((c) => {
        const v = row[c];
        if (v === undefined || v === null) return null;
        if (typeof v === "number" || typeof v === "string") return v;
        if (typeof v === "boolean") return v ? 1 : 0;
        return String(v);
      });
      statements.push(db.prepare(sql).bind(...binds));
    }
    imported[step.table] = rows.length;
  }

  if (statements.length > 0) {
    const MAX_STATEMENTS = 500;
    if (statements.length > MAX_STATEMENTS) {
      throw new Error(
        `本次导入需要写入 ${statements.length} 行，超过单次上限 ${MAX_STATEMENTS} 行。请分批导出/导入。`
      );
    }
    await db.batch(statements);
  }

  return { imported };
}
