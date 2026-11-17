export const RESTORE_TABLES = ["accounts", "custom_accounts", "custom_domains", "domains_cache", "domain_date_overrides"] as const;
export const RESTORE_MAX_ROWS = 10000;
export const RESTORE_MAX_BYTES = 8 * 1024 * 1024;
export const RESTORE_CHUNK_ROWS = 20;
export const RESTORE_CHUNK_BYTES = 256 * 1024;
export type RestoreTable = (typeof RESTORE_TABLES)[number];
export interface RestoreChunk {
  table: RestoreTable;
  offset: number;
  count: number;
  digest: string;
}
export interface RestoreManifest {
  header: Record<string, unknown>;
  data_tables: RestoreTable[];
  counts: Record<RestoreTable, number>;
  chunks: RestoreChunk[];
  digest: string;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter(key => object[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
