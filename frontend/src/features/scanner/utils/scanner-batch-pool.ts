import type { ApiFetch } from "../../../api/client";
import type { ScannerTask } from "./scanner-batch-planner";

export type ScannerPoolOptions = {
  apiFetch: ApiFetch;
  tasks: ScannerTask[];
  batchSize: number;
  onFailure: (error: unknown) => void;
  onBackgroundComplete: (registeredCount: number) => void;
};

export async function primeScannerSkipPool({
  apiFetch,
  tasks,
  batchSize,
  onFailure,
  onBackgroundComplete,
}: ScannerPoolOptions): Promise<Set<string>> {
  if (batchSize <= 0) throw new Error("batchSize must be greater than zero");

  const chunks: ScannerTask[][] = [];
  for (let index = 0; index < tasks.length; index += batchSize) {
    chunks.push(tasks.slice(index, index + batchSize));
  }

  const skipSet = new Set<string>();
  let failed = false;

  const fetchChunk = async (chunk: ScannerTask[]) => {
    const response = await apiFetch("/api/whois/pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains: chunk.map(task => task.queryFull) }),
    });
    const data = await response.json();
    if (data.success && Array.isArray(data.registered)) {
      data.registered.forEach((domain: string) => skipSet.add(domain));
    }
  };

  const handleFailure = (error: unknown) => {
    if (failed) return;
    failed = true;
    onFailure(error);
  };

  try {
    if (chunks.length > 0) await fetchChunk(chunks[0]);
  } catch (error) {
    handleFailure(error);
  }

  if (chunks.length > 1) {
    void Promise.all(chunks.slice(1).map(chunk => fetchChunk(chunk).catch(handleFailure))).then(() => {
      if (!failed) onBackgroundComplete(skipSet.size);
    });
  }

  return skipSet;
}
