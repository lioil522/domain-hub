import type { ScanCursor, ScanCursorV2 } from "./scanner-types";
import { isScanCursorV2 } from "./scanner-checkpoint";

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

export function scannerBackendKey(backend = ""): string {
  return backend.trim().replace(/\/+$/, "") || "/";
}

function cursorKey(backend: string) {
  return `${SCANNER_STORAGE_KEYS.scanCursor}:${encodeURIComponent(scannerBackendKey(backend))}`;
}

export function loadScanCursor(backend = ""): ScanCursor | ScanCursorV2 | null {
  const parsed = readJson<unknown>(cursorKey(backend));
  if (isScanCursorV2(parsed) && parsed.backend === scannerBackendKey(backend)) return parsed;
  // Keep old checkpoints visible, but require a fresh scan rather than guessing their missing configuration.
  const legacy = readJson<ScanCursor>(SCANNER_STORAGE_KEYS.scanCursor);
  return legacy && typeof legacy.lastCandidate === "string" && Number.isSafeInteger(legacy.checked) && legacy.checked >= 0 ? legacy : null;
}

export function saveScanCursor(cursor: ScanCursorV2) {
  if (!isScanCursorV2(cursor)) throw new Error("扫描检查点无效，已拒绝保存");
  localStorage.setItem(cursorKey(cursor.backend), JSON.stringify(cursor));
}

export function clearScanCursor(backend = "") {
  localStorage.removeItem(cursorKey(backend));
  localStorage.removeItem(SCANNER_STORAGE_KEYS.scanCursor);
}
