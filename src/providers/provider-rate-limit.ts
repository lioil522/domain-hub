import { parseAlidnsResponse } from "./alidns-response";
import { isObject } from "./list-integrity";

// Exact, documented codes only. Resource quotas and lock contention are not rates.
const dnspodCodes = new Set([
  "RequestLimitExceeded", "RequestLimitExceeded.GlobalRegionUinLimitExceeded",
  "RequestLimitExceeded.IPLimitExceeded", "RequestLimitExceeded.UinLimitExceeded",
  "RequestLimitExceeded.BatchTaskLimit", "RequestLimitExceeded.CreateDomainLimit",
  "RequestLimitExceeded.RequestLimitExceeded",
]);
const alidnsCodes = new Set(["Throttling", "Throttling.User"]);

function optionalText(body: Record<string, unknown>, field: string): boolean {
  return body[field] === undefined || typeof body[field] === "string";
}

/** Accept only lossless UTC+8 calendar dates, not Date.parse's normalized dates. */
export function dnsheResetAfter(details: unknown, now = Date.now()): number | undefined {
  if (!isObject(details) || typeof details.reset_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(details.reset_at)) return undefined;
  const text = details.reset_at.replace(" ", "T");
  const date = Date.parse(text + "+08:00");
  return Number.isFinite(date) && new Date(date + 8 * 3600_000).toISOString().slice(0, 19) === text
    ? Math.max(0, date - now) : undefined;
}

function epochDelay(value: unknown, scale: number, now: number): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  const epoch = value * scale;
  return Number.isSafeInteger(epoch) ? Math.max(0, epoch - now) : undefined;
}

/** Observation only: malformed/unknown bodies stay on the client's normal error path.
 * Called after bounded UTF-8 reading, before releasing the permit, within its deadline.
 * Alidns XML accepts only the Error root here, never an arbitrary success document.
 */
export function recognizeProviderRateLimit(provider: string, text: string, now = Date.now()):
  { resetAfterMs?: number } | undefined {
  if (!["dnshe", "dnspod", "alidns", "huaweicloud", "vercel"].includes(provider)) return undefined;
  let body: unknown;
  try { body = provider === "alidns" ? parseAlidnsResponse(text, "", true) : JSON.parse(text); }
  catch { return undefined; }
  if (!isObject(body) || (body.success !== undefined && body.success !== false)) return undefined;
  switch (provider) {
    case "dnshe":
      return body.success === false && body.error_code === "rate_limit_exceeded" &&
        optionalText(body, "message") && optionalText(body, "error")
        ? { resetAfterMs: dnsheResetAfter(body.details, now) } : undefined;
    case "dnspod": {
      const response = body.Response;
      const error = isObject(response) ? response.Error : undefined;
      return isObject(error) && typeof error.Code === "string" && dnspodCodes.has(error.Code) && optionalText(error, "Message")
        ? {} : undefined;
    }
    case "alidns":
      return typeof body.Code === "string" && alidnsCodes.has(body.Code) && optionalText(body, "Message") ? {} : undefined;
    case "huaweicloud": {
      const code = body.error_code ?? body.code;
      return code === "APIGW.0308" && optionalText(body, "error_msg") && optionalText(body, "message") ? {} : undefined;
    }
    case "vercel": {
      const error = body.error;
      if (!isObject(error) || error.code !== "rate_limited" || !optionalText(error, "message")) return undefined;
      const limit = error.limit;
      return { resetAfterMs: isObject(limit)
        ? Math.max(epochDelay(limit.resetMs, 1, now) ?? 0, epochDelay(limit.reset, 1000, now) ?? 0) : undefined };
    }
  }
}
