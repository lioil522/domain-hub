/** Compose cancellation and a bounded request deadline without requiring AbortSignal.any(). */
export function requestDeadline(parent?: AbortSignal, timeoutMs = 15000) {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  if (parent?.aborted) cancel();
  else parent?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("请求超时", "TimeoutError")), timeoutMs);
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); parent?.removeEventListener("abort", cancel); },
  };
}
