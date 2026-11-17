export type ScannerQueryResult =
  | { kind: "available" | "registered" }
  | { kind: "retry"; reason: string; retryAfterMs: number };

/** Both delta-seconds and HTTP-date Retry-After values are accepted. */
export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return 1200;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.min(86400000, Math.max(0, Math.ceil(Number(value) * 1000)));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(86400000, Math.max(0, date - now)) : 1200;
}

export function classifyScannerResponse(status: number, payload: unknown, retryAfter: string | null = null): ScannerQueryResult {
  const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const whois = data.whois && typeof data.whois === "object" ? data.whois as Record<string, unknown> : {};
  if (status === 429 || ["rate_limited", "rate_limit", "quota_exceeded"].includes(String(data.error_code || whois.error_code || ""))) {
    return { kind: "retry", reason: String(data.message || whois.message || "触发上游限流或配额上限"), retryAfterMs: retryAfterMs(retryAfter) };
  }
  if (status >= 200 && status < 300 && data.success === true && (whois.success === undefined || whois.success === true) && typeof whois.registered === "boolean") {
    return { kind: whois.registered ? "registered" : "available" };
  }
  return { kind: "retry", reason: String(data.message || whois.message || `查询结果未知（HTTP ${status}）`), retryAfterMs: 1200 };
}
