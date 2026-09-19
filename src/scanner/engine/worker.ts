import type { ScannerJobModel } from "../../types/scanner";
import { ScannerJobStore } from "./job-store";

export async function runScannerStep(
  store: ScannerJobStore,
  jobId: string,
  step: (cursor: string) => Promise<{ cursor: string; checked: number; available: number; registered: number; failed: number; done: boolean }>
): Promise<ScannerJobModel> {
  const current = await store.get(jobId);
  if (!current) throw new Error(`Scanner job ${jobId} not found`);
  if (current.status === "completed" || current.status === "failed") return current;
  const running = { ...current, status: "running" as const, updatedAt: new Date().toISOString() };
  await store.save(running);
  try {
    const result = await step(current.cursor);
    const next: ScannerJobModel = {
      ...running,
      status: result.done ? "completed" : "paused",
      cursor: result.cursor,
      totalChecked: current.totalChecked + result.checked,
      available: current.available + result.available,
      registered: current.registered + result.registered,
      failed: current.failed + result.failed,
      updatedAt: new Date().toISOString(),
      finishedAt: result.done ? new Date().toISOString() : undefined,
    };
    await store.save(next);
    return next;
  } catch (error) {
    const next = { ...running, status: "failed" as const, error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() };
    await store.save(next);
    throw error;
  }
}
