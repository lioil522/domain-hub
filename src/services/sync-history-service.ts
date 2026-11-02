import type { DatabaseManager } from "../db";
import { AppError } from "../errors";
import { previewSyncHistory, purgeSyncHistorySlice } from "../db/dao/sync-task-dao";

export const SYNC_HISTORY_CONFIRMATION = "purge-terminal-sync-history";
const invalid = () => new AppError("历史维护参数无效：保留30–3650天，每表每片1–100行；执行须明确确认", 400, "bad_request");

/** Explicit administrator entry only: no Cron, login, sync completion or
 * frontend polling invokes this service. Preview is the fail-safe default.
 */
export async function maintainSyncHistory(db: DatabaseManager, input: unknown = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !["retentionDays", "limit", "dryRun", "confirm"].includes(key))) throw invalid();
  const retentionDays = body.retentionDays ?? 30, limit = body.limit ?? 100, dryRun = body.dryRun ?? true;
  if (typeof retentionDays !== "number" || !Number.isSafeInteger(retentionDays) || retentionDays < 30 || retentionDays > 3650 ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof dryRun !== "boolean" ||
    body.confirm !== undefined && body.confirm !== SYNC_HISTORY_CONFIRMATION || !dryRun && body.confirm !== SYNC_HISTORY_CONFIRMATION ||
    ["retentionDays", "limit", "dryRun"].some(key => body[key] === null)) throw invalid();
  const olderThanSeconds = retentionDays * 86400;
  const deleted = dryRun ? { fragments: 0, items: 0, tasks: 0 } : await purgeSyncHistorySlice(db.connection, olderThanSeconds, limit, true);
  const sample = await previewSyncHistory(db.connection, olderThanSeconds, limit);
  return { dryRun, retentionDays, limit, deleted, sample, hasCandidates: sample.candidateTasks > 0,
    message: dryRun ? "仅预览有界样本，未删除同步历史" : "已执行一片有界维护；需要继续时请先重新预览，不自动重试" };
}
