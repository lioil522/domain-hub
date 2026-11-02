import type { DatabaseManager } from "../../db";
import { localExpiryReport } from "../../services/reminder-renewal-service";

/** Local collection only; delivery acknowledgement belongs to each channel. */
export async function collectExpiryReminders(db: DatabaseManager, days: number, out: string[]) {
  out.push(...await localExpiryReport(db, days));
}
