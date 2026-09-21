import type { ScanCursor } from "./scanner-types";

export const SCANNER_STORAGE_KEYS = {
  customRootDomains: "DNSHE_CUSTOM_ROOT_DOMAINS",
  scanCursor: "DNSHE_SCAN_CURSOR",
  reservedPrefixes: "DNSHE_RESERVED_PREFIXES",
  reservedFilterOff: "DNSHE_RESERVED_FILTER_OFF",
} as const;

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function loadCustomRootDomains(fallback: string[]): string[] {
  const parsed = readJson<unknown>(SCANNER_STORAGE_KEYS.customRootDomains);
  return Array.isArray(parsed) && parsed.length > 0 && parsed.every(v => typeof v === "string")
    ? parsed
    : fallback;
}

export function saveCustomRootDomains(domains: string[]) {
  localStorage.setItem(SCANNER_STORAGE_KEYS.customRootDomains, JSON.stringify(domains));
}

export function loadReservedPrefixes(fallback: string[]): string[] {
  const parsed = readJson<unknown>(SCANNER_STORAGE_KEYS.reservedPrefixes);
  return Array.isArray(parsed) && parsed.every(v => typeof v === "string") ? parsed : fallback;
}

export function saveReservedPrefixes(prefixes: string[]) {
  localStorage.setItem(SCANNER_STORAGE_KEYS.reservedPrefixes, JSON.stringify(prefixes));
}

export function loadReservedFilterEnabled(): boolean {
  return localStorage.getItem(SCANNER_STORAGE_KEYS.reservedFilterOff) !== "1";
}

export function saveReservedFilterEnabled(enabled: boolean) {
  localStorage.setItem(SCANNER_STORAGE_KEYS.reservedFilterOff, enabled ? "0" : "1");
}

export function loadScanCursor(): ScanCursor | null {
  return readJson<ScanCursor>(SCANNER_STORAGE_KEYS.scanCursor);
}

export function saveScanCursor(cursor: ScanCursor) {
  localStorage.setItem(SCANNER_STORAGE_KEYS.scanCursor, JSON.stringify(cursor));
}

export function clearScanCursor() {
  localStorage.removeItem(SCANNER_STORAGE_KEYS.scanCursor);
}
