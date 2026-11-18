/** Lightweight shared preference: line-DNS must not import the Scanner planner/word lists. */
export const SCANNER_ROOT_DOMAINS_KEY = "DNSHE_CUSTOM_ROOT_DOMAINS";

export function loadCustomRootDomains(fallback: string[]): string[] {
  try {
    const raw = localStorage.getItem(SCANNER_ROOT_DOMAINS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every(v => typeof v === "string")
      ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function saveCustomRootDomains(domains: string[]) {
  localStorage.setItem(SCANNER_ROOT_DOMAINS_KEY, JSON.stringify(domains));
}
