import type { ApiFetch } from "../../../api/client";
import { requestDeadline } from "../../../api/request-deadline";

/** Scanner reads error responses as data so Retry-After survives malformed proxy bodies. */
export async function scannerJsonRequest(apiFetch: ApiFetch, url: string, options: RequestInit, parent?: AbortSignal, timeoutMs = 15000) {
  if (parent?.aborted) throw new DOMException("扫描已取消", "AbortError");
  const deadline = requestDeadline(parent, timeoutMs);
  try {
    const response = await apiFetch(url, { ...options, signal: deadline.signal });
    const payload: unknown = await response.json().catch(() => null);
    if (deadline.signal.aborted) throw deadline.signal.reason;
    return { response, payload };
  } finally {
    deadline.dispose();
  }
}
