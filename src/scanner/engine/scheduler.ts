import type { ScannerJobModel } from "../../types/scanner";
import { ScannerJobStore } from "./job-store";
import { runScannerStep } from "./worker";

export interface ScannerStepResult {
  cursor: string;
  checked: number;
  available: number;
  registered: number;
  failed: number;
  done: boolean;
}

/** Execute exactly one resumable scanner slice. The cursor is persisted before the function returns. */
export async function runScannerSlice(
  store: ScannerJobStore,
  jobId: string,
  step: (cursor: string) => Promise<ScannerStepResult>,
): Promise<ScannerJobModel> {
  return runScannerStep(store, jobId, step);
}

/** Resume a paused/created job for at most `maxSlices` slices. */
export async function resumeScanner(
  store: ScannerJobStore,
  jobId: string,
  step: (cursor: string) => Promise<ScannerStepResult>,
  maxSlices = 1,
): Promise<ScannerJobModel> {
  const slices = Math.max(1, Math.min(100, Math.floor(maxSlices)));
  let current = await store.get(jobId);
  if (!current) throw new Error(`Scanner job ${jobId} not found`);
  for (let i = 0; i < slices; i += 1) {
    if (current.status === "completed" || current.status === "failed") return current;
    current = await runScannerStep(store, jobId, step);
    if (current.status !== "paused") return current;
  }
  return current;
}
