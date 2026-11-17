export interface AccountSyncResult {
  accountId: number;
  alias: string;
  status: "completed" | "paused" | "failed" | "skipped";
  domainCount?: number;
  nextPage?: number;
  error?: string;
}

export interface AccountSyncSummary {
  results: AccountSyncResult[];
  completed: number;
  paused: number;
  failed: number;
  skipped: number;
  error?: string;
}

export function summarizeAccountSync(results: AccountSyncResult[]): AccountSyncSummary {
  return {
    results,
    completed: results.filter(result => result.status === "completed").length,
    paused: results.filter(result => result.status === "paused").length,
    failed: results.filter(result => result.status === "failed").length,
    skipped: results.filter(result => result.status === "skipped").length,
  };
}
