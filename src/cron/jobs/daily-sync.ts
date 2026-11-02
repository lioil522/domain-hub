import type { DatabaseManager } from "../../db";
import type { WebhookType } from "../notification";
import { runReminderRenewal } from "../../services/reminder-renewal-service";
import { summarizeSync } from "../../services/sync-result";

/** Compatibility name only: scheduled work NEVER performs full synchronization. */
export async function runDailySyncAndRenewal(db: DatabaseManager, webhookUrl?: string, webhookType: WebhookType = "custom", _isScheduled = false) {
  await runReminderRenewal(db, webhookUrl, webhookType);
  return summarizeSync([]);
}
