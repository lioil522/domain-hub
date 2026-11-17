import {
  LEGACY_COLUMNS, MIGRATION_NAMES, MIGRATION_TABLE, MIGRATION_TABLE_SQL,
  SCHEMA_INDEXES, SCHEMA_TABLES, SCHEMA_VERSION,
  BASELINE_TABLES, BASELINE_INDEXES, RESTORE_SCHEMA_TABLES, RESTORE_SCHEMA_INDEXES,
  SYNC_SCHEMA_TABLES, SYNC_SCHEMA_INDEXES,
} from "./schema-definition";

const inFlight = new WeakMap<D1Database, Promise<number>>();
const historySql = `SELECT version, name FROM ${MIGRATION_TABLE} ORDER BY version`;

function requireSuccess(results: D1Result<unknown>[]) {
  if (results.some(result => !result.success)) throw new Error("Schema query or migration failed");
}

async function readVersion(db: D1Database): Promise<number> {
  const result = await db.prepare(historySql).all<{ version: number; name: string }>();
  requireSuccess([result]);
  const rows = result.results;
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].version !== index + 1 || rows[index].name !== MIGRATION_NAMES[index]) {
      throw new Error("Unsupported or inconsistent schema history; do not downgrade or rewrite migration records");
    }
  }
  return rows.length;
}

async function tableStatements(db: D1Database, tables: readonly (typeof SCHEMA_TABLES)[number][], allowLegacy = false): Promise<string[]> {
  // Table-valued PRAGMA functions inspect all required fields in one read.
  // Existing tables need no redundant CREATE, preserving a cold-request budget.
  const result = await db.prepare(`WITH required(table_name) AS (VALUES ${tables.map(table => `('${table.name}')`).join(",")})
    SELECT required.table_name,fields.name FROM required,pragma_table_info(required.table_name) fields`)
    .all<{ table_name: string; name: string }>();
  requireSuccess([result]);
  const columnsByTable = new Map<string, Set<string>>();
  for (const column of result.results) {
    const bucket = columnsByTable.get(column.table_name) || new Set<string>();
    bucket.add(column.name); columnsByTable.set(column.table_name, bucket);
  }
  const statements: string[] = [];
  tables.forEach(table => {
    const columns = columnsByTable.get(table.name);
    if (!columns?.size) { statements.push(table.sql); return; }
    for (const name of table.columns) {
      if (columns.has(name)) continue;
      const definition = allowLegacy ? LEGACY_COLUMNS[table.name]?.[name] : undefined;
      if (!definition) throw new Error(`Unsupported legacy schema: ${table.name}.${name} is missing; manual recovery required`);
      statements.push(`ALTER TABLE ${table.name} ADD COLUMN ${name} ${definition}`);
    }
  });
  return statements;
}

const normalizedSql = (sql: string) => sql.toLowerCase().replace(/\bif not exists\b/g, "").replace(/[\s;"`[\]]/g, "");

async function checkExistingIndexes(db: D1Database, requireAll: boolean, indexes = SCHEMA_INDEXES) {
  const result = await db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
    .all<{ name: string; sql: string }>();
  requireSuccess([result]);
  const existing = new Map(result.results.map(row => [row.name, row.sql]));
  for (const index of indexes) {
    const sql = existing.get(index.name);
    if (sql && normalizedSql(sql) !== normalizedSql(index.sql)) {
      throw new Error(`Schema index ${index.name} has an unexpected definition; not overwriting it`);
    }
    if (!sql && requireAll) throw new Error(`Required schema index ${index.name} is missing`);
  }
}

async function migrate(db: D1Database): Promise<number> {
  let version: number;
  try {
    version = await readVersion(db);
  } catch (error) {
    // An outage or malformed ledger is not an empty/fresh database.
    if (!(error instanceof Error) || !/no such table:\s*(?:main\.)?domain_hub_schema_migrations\b/i.test(error.message)) throw error;
    const result = await db.prepare(MIGRATION_TABLE_SQL).run();
    requireSuccess([result]);
    version = await readVersion(db);
  }
  while (version < SCHEMA_VERSION) {
    const nextVersion = version + 1;
    const name = MIGRATION_NAMES[version];
    let statements: string[];
    if (nextVersion === 1) {
      const all = await tableStatements(db, SCHEMA_TABLES, true);
      if (all.length === SCHEMA_TABLES.length && all.every(sql => sql.startsWith("CREATE TABLE"))) {
        // Fresh databases commit the complete schema and all version records in
        // one transaction, leaving enough first-request budget for login/setup.
        await checkExistingIndexes(db, false);
        try {
          await db.batch([
            ...all.map(sql => db.prepare(sql)), ...SCHEMA_INDEXES.map(index => db.prepare(index.sql)),
            db.prepare(`INSERT INTO ${MIGRATION_TABLE}(version,name)
              SELECT json_extract(value,'$.version'),json_extract(value,'$.name') FROM json_each(?)`)
              .bind(JSON.stringify(MIGRATION_NAMES.map((name, index) => ({ version: index + 1, name })))),
          ]);
        } catch (error) { if (await readVersion(db) !== SCHEMA_VERSION) throw error; }
        return SCHEMA_VERSION;
      }
      const names = new Set(BASELINE_TABLES.map(table => table.name));
      statements = all.filter(sql => names.has(sql.match(/^(?:CREATE TABLE IF NOT EXISTS|ALTER TABLE)\s+(\w+)/)?.[1] || ""));
    }
    else if (nextVersion === 2) {
      await checkExistingIndexes(db, false, BASELINE_INDEXES);
      statements = BASELINE_INDEXES.map(index => index.sql);
    } else if (nextVersion === 3) {
      await checkExistingIndexes(db, false, RESTORE_SCHEMA_INDEXES);
      statements = [...await tableStatements(db, RESTORE_SCHEMA_TABLES), ...RESTORE_SCHEMA_INDEXES.map(index => index.sql)];
    } else if (nextVersion === 4) {
      await checkExistingIndexes(db, false, SYNC_SCHEMA_INDEXES);
      statements = [...await tableStatements(db, [...SYNC_SCHEMA_TABLES, SCHEMA_TABLES.find(table => table.name === "cf_sync_state")!], true),
        ...SYNC_SCHEMA_INDEXES.map(index => index.sql)];
    } else throw new Error(`No migration implementation for schema version ${nextVersion}`);
    try {
      const results = await db.batch([
        ...statements.map(sql => db.prepare(sql)),
        db.prepare(`INSERT INTO ${MIGRATION_TABLE} (version, name) VALUES (?, ?)`).bind(nextVersion, name),
      ]);
      requireSuccess(results);
      version = nextVersion;
    } catch (error) {
      // Separate isolates/connections can race on ALTER. Only a committed history
      // record from the other executor proves this entire migration succeeded.
      const committedVersion = await readVersion(db);
      if (committedVersion < nextVersion) throw error;
      version = committedVersion;
    }
  }
  return version;
}

/**
 * Successful calls retain no global readiness flag. Each later request checks
 * its own binding's small migration ledger, without CREATE/ALTER/PRAGMA writes.
 */
export function ensureDatabaseSchema(db: D1Database): Promise<number> {
  const existing = inFlight.get(db);
  if (existing) return existing;
  const promise = migrate(db).finally(() => { inFlight.delete(db); });
  inFlight.set(db, promise);
  return promise;
}

/** Full structural check for startup/maintenance, not the normal request path. */
export async function verifyDatabaseSchema(db: D1Database): Promise<void> {
  if (await readVersion(db) !== SCHEMA_VERSION) throw new Error("Schema migrations are incomplete");
  const results = await db.batch<{ name: string }>(SCHEMA_TABLES.map(table => db.prepare(`PRAGMA table_info(${table.name})`)));
  requireSuccess(results);
  SCHEMA_TABLES.forEach((table, index) => {
    const columns = new Set(results[index].results.map(column => column.name));
    if (table.columns.some(name => !columns.has(name))) throw new Error(`Required table/column is missing in ${table.name}`);
  });
  await checkExistingIndexes(db, true);
}
