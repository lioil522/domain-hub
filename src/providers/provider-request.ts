import { ProviderApiError } from "../errors/provider-api-error";
import type { ProviderRequestScheduler } from "../services/provider-request-scheduler";
import { recognizeProviderRateLimit } from "./provider-rate-limit";
import { AppError } from "../errors";
import type { InvocationCounter } from "../services/invocation-budget";
import { invocationFetch } from "../services/invocation-fetch";

export const PROVIDER_TIMEOUT_MS = 20_000;
export const PROVIDER_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface ProviderRequestLimits {
  timeoutMs?: number;
  maxResponseBytes?: number;
  scheduler?: ProviderRequestScheduler;
  budget?: InvocationCounter;
  /** Invocation-owned write fence, checked after admission and before fetch. */
  beforeDispatch?: () => Promise<void>;
}

export interface ProviderTextResponse {
  response: Response;
  text: string;
  retryAfterMs?: number;
  rateLimited?: boolean;
}

/** RFC Retry-After: accept delta seconds or an HTTP date, never NaN/Infinity. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const input = value.trim();
  if (/^\d+$/.test(input)) {
    const milliseconds = Number(input) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  // Do not let Date.parse interpret negative numbers or decimals as calendar dates.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(input)) return undefined;
  const date = Date.parse(input);
  return Number.isFinite(date) && new Date(date).toUTCString() === input ? Math.max(0, date - now) : undefined;
}

/** One attempt, one deadline through the body, bounded buffering, no URL/credential diagnostics. */
export async function requestProviderText(provider: string, url: string, init: RequestInit,
  limits: ProviderRequestLimits = {}): Promise<ProviderTextResponse> {
  const timeoutMs = limits.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const maxBytes = limits.maxResponseBytes ?? PROVIDER_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Invalid provider request limits");
  }
  if (!limits.scheduler) return readProviderText(provider, url, init, limits, timeoutMs, maxBytes);
  if (init.signal?.aborted) throw new ProviderApiError(provider, 502, "request_cancelled", `${provider} 请求已取消；本次请求未发送`);
  const lease = await limits.scheduler.acquire(timeoutMs, init.signal);
  let failed = false;
  try {
    return await readProviderText(provider, url, init, limits, timeoutMs, maxBytes, lease.assertReady);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await lease?.release(); }
    catch (error) {
      // Preserve the primary error (especially unknown mutation outcomes). A failed
      // release leaves the permit occupied until expiry; do not retry the request.
      if (!failed) throw error;
    }
  }
}

async function readProviderText(provider: string, url: string, init: RequestInit,
  limits: ProviderRequestLimits, timeoutMs: number, maxBytes: number, assertReady?: () => void): Promise<ProviderTextResponse> {
  const controller = new AbortController();
  let timedOut = false;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  let retryAfterMs: number | undefined;
  let rateLimited = false;
  const cancelReader = () => {
    try { if (reader) void reader.cancel().catch(() => {}); } catch { /* best-effort cleanup */ }
  };
  const failure = (code: string, message: string) => new ProviderApiError(provider,
    response && (!response.ok || rateLimited) ? response.status : 502, code, message,
    limits.scheduler?.scope ? { scope: limits.scheduler.scope } : undefined, retryAfterMs, rateLimited);
  const abortFailure = () => failure(timedOut ? "request_timeout" : "request_cancelled",
    `${provider} ${timedOut ? "请求超时" : "请求已取消"}；写入结果可能尚未确认，请先刷新核对，不会自动重试`);
  const relayAbort = () => controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { reject(abortFailure()); cancelReader(); };
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  init.signal?.addEventListener("abort", relayAbort, { once: true });
  if (init.signal?.aborted) relayAbort();

  const read = async (): Promise<ProviderTextResponse> => {
    if (controller.signal.aborted) throw abortFailure();
    await limits.beforeDispatch?.();
    if (controller.signal.aborted) throw abortFailure();
    assertReady?.();
    response = await invocationFetch(url, { ...init, signal: controller.signal,
      ...(limits.budget?.strict ? { redirect: init.redirect ?? "error" } : {}) }, limits.budget);
    retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
    // A non-cooperative fetch fixture may resolve after the caller's deadline.
    if (controller.signal.aborted) {
      if (response.body) void response.body.cancel().catch(() => {});
      throw abortFailure();
    }
    // Persist cooldown at headers, before trusting/reading even an HTML or slow body.
    if (response.status === 429 && limits.scheduler) await limits.scheduler.block(retryAfterMs ?? 60_000);
    if (controller.signal.aborted) {
      if (response.body) void response.body.cancel().catch(() => {});
      throw abortFailure();
    }
    if (response.body) reader = response.body.getReader();
    const length = response.headers.get("Content-Length");
    if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
      throw failure("response_too_large", `${provider} 响应超过安全大小限制，未采用该响应`);
    }
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
      let text = "";
      let bytes = 0;
      while (reader) {
        const chunk = await reader.read();
        if (controller.signal.aborted) throw abortFailure();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw failure("response_too_large", `${provider} 响应超过安全大小限制，未采用该响应`);
        try { text += decoder.decode(chunk.value, { stream: true }); }
        catch { throw failure("invalid_response", `${provider} 响应不是有效的 UTF-8`); }
      }
      try { text += decoder.decode(); }
      catch { throw failure("invalid_response", `${provider} 响应不是有效的 UTF-8`); }
      if (controller.signal.aborted) throw abortFailure();
      const rate = recognizeProviderRateLimit(provider, text);
      if (rate) {
        rateLimited = true;
        retryAfterMs = Math.max(retryAfterMs ?? 60_000, rate.resetAfterMs ?? 0, 1000);
        await limits.scheduler?.block(retryAfterMs);
        if (controller.signal.aborted) throw abortFailure();
      }
      completed = true;
      return { response, text, retryAfterMs, rateLimited };
    } finally {
      // Also runs when a pending read settles after the deadline race.
      if (!completed) cancelReader();
      try { reader?.releaseLock(); } catch { /* pending cancellation */ }
    }
  };

  try {
    return await Promise.race([read(), aborted]);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (controller.signal.aborted) throw abortFailure();
    throw failure("transport_error", `${provider} 网络请求或响应读取失败；写入结果可能尚未确认，请先刷新核对，不会自动重试`);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", relayAbort);
    controller.signal.removeEventListener("abort", onAbort);
    if (!completed) cancelReader();
    try { reader?.releaseLock(); } catch { /* a cancelled read may still be settling */ }
    if (!completed && !reader && response?.body) void response.body.cancel().catch(() => {});
  }
}

export function parseProviderJson(provider: string, result: ProviderTextResponse): unknown {
  try { return JSON.parse(result.text); }
  catch {
    throw new ProviderApiError(provider, result.response.status, "non_json_response",
      `${provider} 返回非 JSON 或截断响应（HTTP ${result.response.status}），未采用该响应`, undefined, result.retryAfterMs);
  }
}
