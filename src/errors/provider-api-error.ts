import { AppError } from "./index";

/** Provider status is not the panel's authentication status. */
export class ProviderApiError extends AppError {
  readonly provider: string;
  readonly status: number;
  readonly error_code: string;
  readonly retryAfterMs?: number;
  readonly rateLimited: boolean;
  constructor(provider: string, status: number, code: string, message: string, details?: unknown, retryAfterMs?: number, rateLimited = false) {
    super(message, rateLimited || status === 429 ? 429 : status >= 400 && status < 500 && status !== 401 ? status : 502,
      `upstream_${code}`, { provider, upstream_status: status, upstream_code: code, details, retry_after_ms: retryAfterMs,
        ...(rateLimited ? { rate_limited: true } : {}) });
    this.provider = provider;
    this.status = status;
    this.error_code = code;
    this.retryAfterMs = retryAfterMs;
    this.rateLimited = rateLimited;
  }
}

export function incompleteResponse(provider: string, message = "上游分页响应不完整，旧缓存保持不变") {
  return new ProviderApiError(provider, 502, "incomplete_response", message);
}
