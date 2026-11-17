import type { ApiFetch } from "../../../api/client";
import type { ScannerTask } from "./scanner-batch-planner";
import { scannerJsonRequest } from "./scanner-request";

export type ScannerPoolOptions = {
  apiFetch: ApiFetch;
  tasks: ScannerTask[];
  batchSize: number;
  onFailure: (error: unknown) => void;
  onBackgroundComplete: (registeredCount: number) => void;
  signal?: AbortSignal;
};

export async function primeScannerSkipPool({
  apiFetch,
  tasks,
  batchSize,
  onFailure,
  onBackgroundComplete,
  signal,
}: ScannerPoolOptions): Promise<Set<string>> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) throw new Error("batchSize must be greater than zero");

  const skipSet = new Set<string>();
  let failed = false;

  const fetchChunk = async (chunk: ScannerTask[]) => {
    const { response, payload } = await scannerJsonRequest(apiFetch, "/api/whois/pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains: chunk.map(task => task.queryFull) }),
    }, signal);
    if (signal?.aborted) return;
    const data = payload && typeof payload === "object" ? payload as { success?: boolean; registered?: unknown[]; message?: string } : {};
    if (!response.ok || data.success !== true || !Array.isArray(data.registered)) throw new Error(data.message || "查重池响应无效");
    const requested = new Set(chunk.map(task => task.queryFull));
    data.registered.forEach((domain: unknown) => { if (typeof domain === "string" && requested.has(domain)) skipSet.add(domain); });
  };

  const handleFailure = (error: unknown) => {
    if (failed || signal?.aborted) return;
    failed = true;
    onFailure(error);
  };

  try {
    if (tasks.length > 0 && !signal?.aborted) await fetchChunk(tasks.slice(0, batchSize));
  } catch (error) {
    handleFailure(error);
  }

  if (tasks.length > batchSize && !signal?.aborted) {
    // Bounded background prefetch, not one Promise per chunk of an enormous task array.
    void (async () => {
      for (let offset = batchSize; offset < tasks.length && !signal?.aborted && !failed; offset += batchSize) {
        await fetchChunk(tasks.slice(offset, offset + batchSize));
      }
      if (!failed && !signal?.aborted) onBackgroundComplete(skipSet.size);
    })().catch(handleFailure);
  }

  return skipSet;
}
