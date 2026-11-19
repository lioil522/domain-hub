import { RDAP_CACHE_PREFIX } from "./types";

export const CATALOG_REVISION_KEY = "catalog_summary_revision";
export const CATALOG_CACHE_PREFIX = "catalog_summary:1:";
const bindings = new WeakMap<object, object>();
type SqlBinding = Pick<D1Database, "prepare" | "batch">;

/** All current business writes use prepare/batch; unknown writes fail closed. */
export function affectsCatalog(sql: string, values: readonly unknown[] = []): boolean {
  const text = sql.replace(/\/\*[\s\S]*?\*\/|--[^\r\n]*/g, "").trim();
  if (/^(SELECT|PRAGMA|EXPLAIN)\b/i.test(text)) return false;
  const match = text.match(/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(?:["`[]?main["`\]]?\.)?["`[]?(\w+)/i);
  if (!match) return false;
  const table = match[1].toLowerCase();
  if (["accounts", "domains_cache", "custom_domains", "domain_date_overrides"].includes(table)) return true;
  if (table !== "cache") return false;
  if (values.some(value => typeof value === "string" && value.startsWith(RDAP_CACHE_PREFIX))) return true;
  const literal = text.match(/\bVALUES\s*\(\s*'([^']*)'/i)?.[1] ||
    text.match(/\bWHERE\s+key\s*=\s*'([^']*)'/i)?.[1];
  if (literal) return literal.startsWith(RDAP_CACHE_PREFIX);
  // Derived summary writes must not invalidate their own revision.
  const key = /^(INSERT|REPLACE)\b/i.test(text) ? values[0]
    : /\bWHERE\s+key\s*=\s*\?/i.test(text) ? values[values.length - 1] : undefined;
  if (typeof key === "string") return key.startsWith(RDAP_CACHE_PREFIX);
  if (text.includes(RDAP_CACHE_PREFIX)) return true;
  if (text.includes(CATALOG_CACHE_PREFIX)) return false;
  // Unscoped cache updates/deletes may remove live RDAP metadata.
  return true;
}

function instrument<T extends SqlBinding>(db: T, session?: (constraint?: D1SessionConstraint | D1SessionBookmark) => D1DatabaseSession): T {
  const existing = bindings.get(db);
  if (existing) return existing as T;
  const statements = new WeakMap<D1PreparedStatement, { native: D1PreparedStatement; sql: string; values: readonly unknown[] }>();

  const batch = async <R>(items: D1PreparedStatement[]): Promise<D1Result<R>[]> => {
    let changed = false;
    const native = items.map(item => {
      const info = statements.get(item);
      if (!info) throw new Error("Catalog write boundary requires statements from the same database/session prepare()");
      changed ||= affectsCatalog(info.sql, info.values);
      return info.native;
    });
    if (changed) native.push(db.prepare(`INSERT INTO settings(key,value) VALUES('${CATALOG_REVISION_KEY}',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(crypto.randomUUID()));
    const result = await db.batch<R>(native);
    if (result.some(row => !row.success)) throw new Error("Catalog transaction or revision write failed");
    return result.slice(0, items.length);
  };
  const wrapStatement = (native: D1PreparedStatement, sql: string, values: readonly unknown[] = []): D1PreparedStatement => {
    let wrapped: D1PreparedStatement;
    wrapped = new Proxy(native, {
      get(target, key) {
        if (key === "bind") return (...next: unknown[]) => wrapStatement(target.bind(...next), sql, next);
        if (affectsCatalog(sql, values)) {
          if (key === "run" || key === "all") return async () => (await batch([wrapped]))[0];
          if (key === "first") return async (column?: string) => {
            const result = await batch<Record<string, unknown>>([wrapped]);
            const row = result[0].results[0];
            return column === undefined ? row ?? null : row?.[column] ?? null;
          };
          if (key === "raw") return async (options?: { columnNames?: boolean }) => {
            const result = await batch<Record<string, unknown>>([wrapped]);
            const columns = result[0].results[0] ? Object.keys(result[0].results[0]) : [];
            const rows = result[0].results.map(row => columns.map(column => row[column]));
            return options?.columnNames ? [columns, ...rows] : rows;
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    statements.set(wrapped, { native, sql, values });
    return wrapped;
  };
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrapStatement(target.prepare(sql), sql);
      if (key === "batch") return batch;
      if (key === "withSession" && session) return (constraint?: D1SessionConstraint | D1SessionBookmark) => instrument(session(constraint));
      if (key === "exec") return (sql: string) => {
        if (sql.split(";").some(statement => affectsCatalog(statement))) throw new Error("Catalog mutations must use prepare/batch, not exec");
        const exec: unknown = Reflect.get(target, key, target);
        if (typeof exec !== "function") throw new Error("Database exec is unavailable");
        return exec.call(target, sql);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  bindings.set(db, wrapped); bindings.set(wrapped, wrapped);
  return wrapped;
}

/** Binding-only memoization, never finished responses or request credentials. */
export function versionedCatalogDatabase(db: D1Database): D1Database {
  return instrument(db, constraint => db.withSession(constraint));
}
