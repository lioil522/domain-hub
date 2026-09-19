export type ScannerJobStatus = "created" | "running" | "paused" | "completed" | "failed";

export function isScannerJobStatus(value: unknown): value is ScannerJobStatus {
  return typeof value === "string" && ["created", "running", "paused", "completed", "failed"].includes(value);
}

export interface ScannerJobModel {
  id: string;
  status: ScannerJobStatus;
  cursor: string;
  totalChecked: number;
  available: number;
  registered: number;
  failed: number;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  error?: string;
}
