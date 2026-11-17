import type { Account } from "../../../types/account";
import type { ScanStatus, ScannerExecutorCheckpoint } from "./scanner-types";
import type { ScannerTask } from "./scanner-batch-planner";

export type ScannerWorkerAccount = Account | null;
export type ScannerTaskOutcome = { kind: "completed" | "aborted" } | { kind: "retry"; retryAfterMs?: number };

export type ScannerBatchExecutorOptions = {
  tasks: ScannerTask[];
  accounts: ScannerWorkerAccount[];
  rateLimitMs: number;
  getStatus: () => ScanStatus;
  waitWhilePaused?: () => Promise<void>;
  shouldSkip: (task: ScannerTask) => boolean;
  onTaskClaimed: (task: ScannerTask, index: number) => void;
  onSkipped: (task: ScannerTask, index: number) => void;
  processTask: (task: ScannerTask, account: ScannerWorkerAccount, index: number) => Promise<void | ScannerTaskOutcome>;
  signal?: AbortSignal;
  resume?: ScannerExecutorCheckpoint;
  onCheckpoint?: (checkpoint: ScannerExecutorCheckpoint) => void;
  /** Injectable monotonic clock/timer for regression tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type ScannerBatchExecutorResult = ScannerExecutorCheckpoint & { skippedCount: number; processedCount: number };

export function scannerSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, Math.max(0, ms));
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** A checkpoint advances only across consecutive definitive results, never across claimed tasks. */
export async function runScannerWorkers(options: ScannerBatchExecutorOptions): Promise<ScannerBatchExecutorResult> {
  const { tasks, getStatus, signal } = options;
  const now = options.now || (() => performance.now());
  const sleep = options.sleep || ((ms: number) => scannerSleep(ms, signal));
  const ahead = new Set(options.resume?.completedAhead || []);
  let lowWater = options.resume?.nextIndex || 0;
  if (!Number.isSafeInteger(lowWater) || lowWater < 0 || lowWater > tasks.length ||
      [...ahead].some(index => !Number.isSafeInteger(index) || index <= lowWater || index >= tasks.length) ||
      (options.resume && (options.resume.completedAhead.length !== ahead.size || options.resume.completedCount !== lowWater + ahead.size))) {
    throw new Error("Invalid scanner checkpoint");
  }
  let next = lowWater;
  let processedCount = lowWater + ahead.size;
  let skippedCount = 0;
  let stopped = false;
  let failure: unknown;
  let hasFailure = false;
  const retry: Array<{ index: number; readyAt: number }> = [];
  const accounts = options.accounts.length ? options.accounts : [null];
  const maxAhead = Math.min(1024, Math.max(8, accounts.length * 2));
  const cancelled = () => stopped || signal?.aborted || !["running", "paused"].includes(getStatus());
  const checkpoint = (): ScannerExecutorCheckpoint => ({ nextIndex: lowWater, completedAhead: [...ahead].sort((a, b) => a - b), completedCount: processedCount });
  const markCompleted = (index: number) => {
    if (index < lowWater || ahead.has(index)) return;
    ahead.add(index);
    processedCount++;
    while (ahead.delete(lowWater)) lowWater++;
    options.onCheckpoint?.(checkpoint());
  };
  const waitActive = async () => {
    while (!cancelled() && getStatus() === "paused") await sleep(50);
    return !cancelled();
  };
  const runWorker = async (account: ScannerWorkerAccount) => {
    let nextAllowed = 0;
    while (await waitActive()) {
      let index: number;
      const queued = retry.shift();
      if (queued) {
        index = queued.index;
        nextAllowed = Math.max(nextAllowed, queued.readyAt);
      } else {
        while (next < lowWater || ahead.has(next)) next++;
        if (next >= tasks.length) return;
        if (next >= lowWater + maxAhead) { await sleep(25); continue; }
        index = next++;
      }
      const task = tasks[index];
      options.onTaskClaimed(task, index);
      if (options.shouldSkip(task)) {
        skippedCount++;
        options.onSkipped(task, index);
        markCompleted(index);
        continue;
      }
      while (!cancelled()) {
        if (!await waitActive()) return;
        const remaining = nextAllowed - now();
        if (remaining <= 0) break;
        await sleep(remaining);
      }
      if (cancelled()) return;
      nextAllowed = now() + Math.max(0, options.rateLimitMs);
      const outcome = await options.processTask(task, account, index);
      if (cancelled() || outcome?.kind === "aborted") return;
      if (outcome?.kind === "retry") {
        retry.push({ index, readyAt: now() + Math.max(0, outcome.retryAfterMs || 0) });
        options.onCheckpoint?.(checkpoint());
      } else {
        markCompleted(index);
      }
    }
  };
  options.onCheckpoint?.(checkpoint());
  await Promise.all(accounts.map(async account => {
    try { await runWorker(account); }
    catch (error) { if (!hasFailure) failure = error; hasFailure = true; stopped = true; }
  }));
  if (hasFailure) throw failure;
  return { ...checkpoint(), skippedCount, processedCount };
}
