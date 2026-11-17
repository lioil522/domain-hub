export type WhoisResult = {
  searchedDomain?: string;
  success?: boolean;
  registered?: boolean;
  status?: string;
  registered_at?: string;
  expires_at?: string;
  registrant_email?: string;
  nameservers?: string[];
  message?: string;
};

export type AvailableDomain = {
  fullDomain: string;
  subdomain: string;
  rootdomain: string;
  time: string;
};

export type ScanLog = {
  id: number;
  time: string;
  text: string;
  status: "available" | "registered" | "error" | "info";
};

export type ScanCursor = {
  seqMode: boolean;
  charset: string;
  length: number;
  lastCandidate: string;
  taskIndex: number;
  checked: number;
  savedAt: string;
};

export type ScanStatus = "idle" | "running" | "paused" | "completed";
export type ScannerParams = { total: number; checked: number; available: number; failed?: number };

/** A deterministic plan snapshot, independent of later edits to the rule or word banks. */
export type ScannerPlanSnapshot = {
  seqMode: boolean;
  seqCharset: "字母" | "数字" | "字母数字";
  seqLength: number;
  seqStart: string;
  batchRules: string;
  excludeChars: string;
  batchLength: number;
  selectedRoots: string[];
  enableReservedFilter: boolean;
  reservedPrefixes: string[];
  ignorePool: boolean;
  wordBanks: Record<string, string[]>;
};

export type ScanCursorV2 = ScanCursor & {
  version: 2;
  backend: string;
  plan: ScannerPlanSnapshot;
  total: number;
  completedAhead: number[];
  availableDomains: AvailableDomain[];
  failedIndices: number[];
  retryUntil?: number;
};

export type ScannerExecutorCheckpoint = {
  nextIndex: number;
  completedAhead: number[];
  completedCount: number;
};
