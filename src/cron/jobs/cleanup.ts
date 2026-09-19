import type { DatabaseManager } from "../../db";
export async function run(db: DatabaseManager) { await db.purgeExpiredCache(); await db.purgeExpiredSessions(); }
