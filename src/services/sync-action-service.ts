import type { DatabaseManager } from "../db";
import { ActionRepository } from "../repositories/action-repository";
import { ActionService } from "./action-service";
import { IncompleteSyncError, type SyncSummary } from "./sync-result";

// Tracks best-effort waitUntil work, not a durable queue or an automatic retry engine.
export async function queueSyncAction(
  db: DatabaseManager,
  metadata: { label: string; accountIds?: number[] },
  run: () => Promise<SyncSummary>,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<string> {
  const service = new ActionService(new ActionRepository(db));
  const action = await service.start("sync", metadata);
  let registered = false;
  const job = Promise.resolve().then(async () => {
    // Do not issue upstream requests if waitUntil registration throws synchronously.
    if (!registered) return;
    let result: SyncSummary;
    try {
      result = await run();
    } catch (error) {
      if (!(error instanceof IncompleteSyncError)) {
        await service.fail(action.id, error instanceof Error ? error.message : String(error));
        return;
      }
      result = error.result;
    }
    await service.settleSync(action.id, result, metadata);
  });
  try {
    waitUntil(job);
    registered = true;
  } catch (error) {
    await service.fail(action.id, "同步任务未能登记，未执行上游请求");
    throw error;
  }
  return action.id;
}
