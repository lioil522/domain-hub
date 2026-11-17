import { ValidationError } from "../errors";
import { PROVIDER_IDS } from "../providers/registry";
import { DATA_EXPORT_VERSION } from "./types";

export type BackupRow = Record<string, string | number | null>;
export const BACKUP_IMPORT_LIMIT = 500;
export const BACKUP_BODY_LIMIT = 20 * 1024 * 1024;

export const BACKUP_PLAN = [
  { table: "accounts", columns: ["id", "alias", "api_key", "api_secret", "provider", "website", "created_at"], identity: ["provider", "api_key"], required: ["alias", "api_key", "api_secret"] },
  { table: "custom_accounts", columns: ["id", "group_id", "name", "updated_at"], identity: ["group_id", "name"], required: ["name"] },
  { table: "custom_domains", columns: ["id", "group_id", "account_id", "full_domain", "registered_at", "expires_at", "remark", "updated_at"], identity: ["group_id", "account_id", "full_domain"], required: ["full_domain", "expires_at"] },
  { table: "domains_cache", columns: ["id", "account_id", "subdomain", "rootdomain", "full_domain", "status", "created_at", "expires_at", "last_renewed_at", "has_dns", "dns_provider", "provider_account_id", "remote_id", "updated_at"], identity: ["account_id", "full_domain", "remote_id"], required: ["rootdomain", "full_domain", "status", "expires_at"] },
  { table: "domain_date_overrides", columns: ["id", "account_id", "full_domain", "registered_at", "expires_at", "source", "updated_at"], identity: ["account_id", "full_domain"], required: ["full_domain"] },
] as const;
export type BackupTable = (typeof BACKUP_PLAN)[number]["table"];
export interface BackupMetadata {
  scope: "business";
  schema_version: number;
  key_id: string | null;
  checksum: string;
}
export interface BackupSnapshot {
  version: number;
  exported_at: string;
  counts?: Record<string, number>;
  metadata?: BackupMetadata;
  data: Record<string, unknown[]>;
}
export interface NormalizedBackup extends BackupSnapshot { data: Record<BackupTable, BackupRow[]>; }

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Validate all rows before preparing any writes; no object-to-string coercion. */
export function normalizeBackup(input: unknown): NormalizedBackup {
  if (!isObject(input) || input.version !== DATA_EXPORT_VERSION) throw new ValidationError(`备份文件版本不支持（期望 ${DATA_EXPORT_VERSION}）`);
  if (!isObject(input.data)) throw new ValidationError("备份文件缺少 data 字段");
  const allowedTables = new Set<string>(BACKUP_PLAN.map(step => step.table));
  if (Object.keys(input.data).some(table => !allowedTables.has(table))) throw new ValidationError("业务备份包含不支持的表；不能导入登录配置或系统状态");
  if (input.exported_at !== undefined && typeof input.exported_at !== "string") throw new ValidationError("备份导出时间格式无效");
  const data = {} as Record<BackupTable, BackupRow[]>;
  for (const step of BACKUP_PLAN) {
    const rows = input.data[step.table] ?? [];
    if (!Array.isArray(rows)) throw new ValidationError(`${step.table} 必须是数组`);
    data[step.table] = rows.map((raw, index) => {
      if (!isObject(raw)) throw new ValidationError(`${step.table} 第 ${index + 1} 行格式无效`);
      const row: BackupRow = {};
      for (const column of step.columns) {
        const value = raw[column] ?? (column === "provider" ? "dnshe" : column === "has_dns" ? 1 : column === "subdomain" ? "" : null);
        if (column === "id" || column === "group_id" || column === "account_id") {
          if (value === null && step.table === "custom_domains" && column === "account_id") row[column] = null;
          else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) row[column] = value;
          else throw new ValidationError(`${step.table} 第 ${index + 1} 行的 ${column} 必须是正整数`);
        } else if (column === "has_dns") {
          if (![0, 1, false, true].includes(value as number)) throw new ValidationError("has_dns 只能是 0 或 1");
          row[column] = Number(value);
        } else {
          if (value !== null && typeof value !== "string") throw new ValidationError(`${step.table} 第 ${index + 1} 行的 ${column} 必须是字符串或 null`);
          if (typeof value === "string" && value.length > 65536) throw new ValidationError(`${step.table}.${column} 超过字段长度上限`);
          row[column] = value as string | null;
        }
      }
      for (const column of step.required) {
        // Empty expiry means unknown in existing provider caches, not a missing column.
        if (typeof row[column] !== "string" || (column !== "expires_at" && !String(row[column]).trim())) throw new ValidationError(`${step.table} 第 ${index + 1} 行缺少 ${column}`);
      }
      if (step.table === "accounts" && !PROVIDER_IDS.includes(row.provider as (typeof PROVIDER_IDS)[number])) throw new ValidationError("备份账号包含不支持的服务商");
      if (step.table === "domains_cache" && typeof row.subdomain !== "string") throw new ValidationError("域名前缀必须是字符串");
      return row;
    });
  }
  if (input.counts !== undefined) {
    if (!isObject(input.counts) || Object.keys(input.counts).some(table => !allowedTables.has(table))) throw new ValidationError("备份 counts 格式无效");
    for (const step of BACKUP_PLAN) {
      if (input.counts[step.table] !== data[step.table].length) throw new ValidationError(`备份 ${step.table} 行数与 counts 不一致`);
    }
  }
  let metadata: BackupMetadata | undefined;
  if (input.metadata !== undefined) {
    const value = input.metadata;
    if (!isObject(value) || value.scope !== "business" || !Number.isSafeInteger(value.schema_version) || Number(value.schema_version) < 1 ||
        !(value.key_id === null || (typeof value.key_id === "string" && /^[a-f0-9]{64}$/.test(value.key_id))) ||
        typeof value.checksum !== "string" || !/^[a-f0-9]{64}$/.test(value.checksum)) throw new ValidationError("备份元数据格式无效");
    metadata = { scope: "business", schema_version: Number(value.schema_version),
      key_id: value.key_id as string | null, checksum: value.checksum };
  }
  return { version: DATA_EXPORT_VERSION, exported_at: String(input.exported_at ?? ""), data,
    counts: input.counts as Record<string, number> | undefined, metadata };
}

export { canonicalJson } from "../../shared/restore-wire";
