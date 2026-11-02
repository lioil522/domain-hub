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
  processTask: (task: ScannerTask, account: ScannerWorkerAccount, index: number) => Promise<void | "retry" | "failed" | "account-paused">;
  onProgress?: (nextUnfinishedIndex: number) => void;
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
  onProgress,
}: ScannerBatchExecutorOptions): Promise<ScannerBatchExecutorResult> {
  let nextTaskIndex = 0;
  let skippedCount = 0;
  let processedCount = 0;
  const retries: number[] = [];
  const completed = new Set<number>();
  let frontier = 0;
  const report = (index: number, success: boolean) => {
    if (success) completed.add(index);
    while (completed.has(frontier)) frontier++;
    onProgress?.(frontier);
  };
  // One pipeline per distinct account, with no fixed shared concurrency cap.
  // Cross-tab/background credential limits remain authoritative in the backend.
  const seen = new Set<number>();
  const workerAccounts = (accounts.length > 0 ? accounts : [null]).filter(account => {
    if (!account) return true;
    if (seen.has(account.id)) return false;
    seen.add(account.id);
    return true;
  });

  const runWorker = async (account: ScannerWorkerAccount) => {
    while (true) {
      if (getStatus() !== "running" && getStatus() !== "paused") return;

      if (getStatus() === "paused") {
        await waitWhilePaused();
        if (getStatus() === "idle") return;
        continue;
      }

      // Do not claim/send work after a pause or stop. Already in-flight
      // requests may finish; rejected requests are not automatically resent.
      if (getStatus() !== "running") continue;
      const index = retries.shift() ?? nextTaskIndex++;
      if (index >= tasks.length) return;

      const task = tasks[index];
      onTaskClaimed(task, index);
      if (shouldSkip(task)) {
        skippedCount++;
        processedCount++;
        onSkipped(task);
        report(index, true);
        continue;
      }

      const startedAt = performance.now();
      const result = await processTask(task, account, index);
      if (result === "retry") retries.push(index);
      else {
        processedCount++;
        report(index, result !== "failed" && result !== "account-paused");
      }
      if (result === "account-paused") return; // Never automatically resume/retry a cooled credential.

      // Timers may wake early; wall-clock adjustments must not shorten a lane's
      // interval. Recheck monotonic elapsed time before claiming any more work.
      let remainingMs = rateLimitMs - (performance.now() - startedAt);
      while (remainingMs > 0 && getStatus() !== "idle" && (nextTaskIndex < tasks.length || retries.length > 0)) {
        await new Promise(resolve => setTimeout(resolve, Math.ceil(remainingMs)));
        remainingMs = rateLimitMs - (performance.now() - startedAt);
      }
    }
  };

  await Promise.all(workerAccounts.map(runWorker));
  return { skippedCount, processedCount };
}
