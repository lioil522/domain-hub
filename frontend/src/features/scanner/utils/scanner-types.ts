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
export type ScannerParams = { total: number; checked: number; available: number };
