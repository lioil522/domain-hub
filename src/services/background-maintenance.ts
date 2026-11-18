import type { DatabaseManager } from "../db";
import { runOneSyncSlice, type SyncRunOptions } from "./sync-work-runner";
import { runOneNotificationDelivery } from "./notification-service";
import { runExpiryReminderSlice } from "../cron/jobs/expiry-check";

/** Independent bounded units: one unavailable subsystem cannot starve another. */
export async function runBackgroundMaintenance(db: DatabaseManager, options: SyncRunOptions & { scanExpiry?: boolean } = {}) {
  const tasks = [
    runOneSyncSlice(db, options),
    runOneNotificationDelivery(db, { signal: options.signal }),
    options.scanExpiry === false ? Promise.resolve(0) : runExpiryReminderSlice(db, options),
  ];
  const results = await Promise.allSettled(tasks);
  const failed = results.map((result, index) => result.status === "rejected" ? ["sync", "notification", "expiry"][index] : "")
    .filter(Boolean);
  if (failed.length) throw new Error(`后台切片执行失败：${failed.join(", ")}；其他独立切片已执行，下轮继续`);
}
