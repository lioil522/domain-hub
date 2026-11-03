import type { Account } from "../../../types/account";
import type { ScanStatus } from "./scanner-types";
import type { ScannerTask } from "./scanner-batch-planner";

export type ScannerWorkerAccount = Account | null;

export type ScannerBatchExecutorOptions = {
  tasks: ScannerTask[];
  accounts: ScannerWorkerAccount[];
  rateLimitMs: number;
  getStatus: () => ScanStatus;
  waitWhilePaused: () => Promise<void>;
  shouldSkip: (task: ScannerTask) => boolean;
  onTaskClaimed: (task: ScannerTask, index: number) => void;
  onSkipped: (task: ScannerTask) => void;
  processTask: (task: ScannerTask, account: ScannerWorkerAccount, index: number) => Promise<void>;
};

export type ScannerBatchExecutorResult = {
  skippedCount: number;
  processedCount: number;
};

export async function runScannerWorkers({
  tasks,
  accounts,
  rateLimitMs,
  getStatus,
  waitWhilePaused,
  shouldSkip,
  onTaskClaimed,
  onSkipped,
  processTask,
}: ScannerBatchExecutorOptions): Promise<ScannerBatchExecutorResult> {
  let nextTaskIndex = 0;
  let skippedCount = 0;
  let processedCount = 0;
  const workerAccounts = accounts.length > 0 ? accounts : [null];

  const runWorker = async (account: ScannerWorkerAccount) => {
    while (true) {
      if (getStatus() === "idle") return;

      if (getStatus() === "paused") {
        await waitWhilePaused();
        if (getStatus() === "idle") return;
        continue;
      }

      const index = nextTaskIndex++;
      if (index >= tasks.length) return;

      const task = tasks[index];
      onTaskClaimed(task, index);

      if (shouldSkip(task)) {
        skippedCount++;
        processedCount++;
        onSkipped(task);
        continue;
      }

      const startedAt = Date.now();
      await processTask(task, account, index);
      processedCount++;

      const elapsed = Date.now() - startedAt;
      if (elapsed < rateLimitMs) {
        await new Promise(resolve => setTimeout(resolve, rateLimitMs - elapsed));
      }
    }
  };

  await Promise.all(workerAccounts.map(runWorker));
  return { skippedCount, processedCount };
}
