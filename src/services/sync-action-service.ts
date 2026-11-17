import type { DatabaseManager } from "../db";
import { ActionRepository } from "../repositories/action-repository";
import { ActionService } from "./action-service";
import type { AccountSyncResult, AccountSyncSummary } from "./sync-results";

export type SyncRunnerContext = {
  onResult: (result: AccountSyncResult) => Promise<void>;
  isCancelled: () => Promise<boolean>;
};

/** Start is distinct from complete: only the runner's structured result settles an action. */
export async function startSyncAction(
  db: DatabaseManager,
  metadata: { label: string; accountIds?: number[] },
  run: (context: SyncRunnerContext) => Promise<AccountSyncSummary>,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<string> {
  const service = new ActionService(new ActionRepository(db));
  const action = await service.start("sync", metadata);
  waitUntil((async () => {
    try {
      const results: AccountSyncResult[] = [];
      const summary = await run({
        isCancelled: async () => !["running", "queued"].includes((await service.get(action.id))?.status || ""),
        onResult: async result => {
          results.push(result);
          const progress = 100 * results.filter(item => item.status === "completed" || item.status === "skipped").length / Math.max(1, metadata.accountIds?.length || results.length);
          await service.updateSyncProgress(action.id, { ...metadata, results: [...results] }, progress);
        },
      });
      await service.finishSync(action.id, summary, metadata);
    } catch (error) {
      await service.failActive(action.id, error instanceof Error ? error.message : String(error), metadata);
    }
  })());
  return action.id;
}
