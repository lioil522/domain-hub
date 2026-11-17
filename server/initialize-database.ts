import { ensureDatabaseSchema, verifyDatabaseSchema } from "../src/db/schema-migrations";

/** Do not open the HTTP listener or start Cron until migration and verification succeed. */
export async function initializeDatabase(db: D1Database): Promise<void> {
  await ensureDatabaseSchema(db);
  await verifyDatabaseSchema(db);
}
