import { ProviderApiError } from "../errors/provider-api-error";

export interface SyncIssue {
  phase: "dns" | "account" | "continuation" | "renewal";
  message: string;
  domainId?: number;
  error_code?: string;
  status?: number;
  panelStatus?: number;
  rateLimited?: boolean;
  retryAfterMs?: number;
}

export interface AccountSyncResult {
  accountId: number;
  status: "completed" | "partial" | "failed" | "skipped";
  total: number;
  issues: SyncIssue[];
  nextPage?: number;
}

export interface SyncSummary {
  status: "completed" | "partial" | "failed";
  accounts: AccountSyncResult[];
}

export function syncIssue(error: unknown, phase: SyncIssue["phase"], domainId?: number): SyncIssue {
  return {
    phase, message: error instanceof Error ? error.message : String(error),
    ...(domainId === undefined ? {} : { domainId }),
    ...(error instanceof ProviderApiError ? {
      error_code: error.error_code, status: error.status, retryAfterMs: error.retryAfterMs,
      panelStatus: error.statusCode, ...(error.rateLimited ? { rateLimited: true } : {}),
    } : {}),
  };
}

export function summarizeSync(accounts: AccountSyncResult[]): SyncSummary {
  const incomplete = accounts.some(a => a.status === "failed" || a.status === "partial");
  const succeeded = accounts.some(a => a.status === "completed" || a.status === "partial");
  return { status: incomplete ? (succeeded ? "partial" : "failed") : "completed", accounts };
}

// Successful cache writes are retained; callers must not turn incomplete work into success.
export class IncompleteSyncError extends Error {
  constructor(readonly result: SyncSummary) {
    super(`同步未全部完成：${result.accounts.flatMap(a => a.issues.map(i => `[账号 ${a.accountId}] ${i.message}`)).join("；")}`);
    this.name = "IncompleteSyncError";
  }
}

export function requireCompletedSync(accounts: AccountSyncResult[]): SyncSummary {
  const result = summarizeSync(accounts);
  if (result.status !== "completed") throw new IncompleteSyncError(result);
  return result;
}
