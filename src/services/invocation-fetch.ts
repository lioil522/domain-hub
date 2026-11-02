import { AppError } from "../errors";
import { InvocationBudget, InvocationBudgetError, type InvocationCounter } from "./invocation-budget";

/** Explicit dependency, no global fetch replacement or cross-request mutable state.
 * Strict mode counts every GET/HEAD redirect hop; never replays a mutation.
 * Legacy observation preserves fetch behavior and marks automatic redirects as
 * opaque: its counter is NOT evidence of an exact platform subrequest total.
 */
export async function invocationFetch(url: string, init: RequestInit = {}, counter?: InvocationCounter): Promise<Response> {
  if (!counter) return fetch(url, init);
  if (!counter.strict) {
    try { counter.consume("external"); }
    catch (error) { throw error instanceof InvocationBudgetError ? error.withRequestOutcome(false) : error; }
    if ((init.redirect ?? "follow") === "follow" && counter instanceof InvocationBudget) counter.markOpaqueRedirects();
    return fetch(url, init);
  }
  const method = (init.method ?? "GET").toUpperCase();
  const follow = (init.redirect ?? "follow") === "follow";
  let current = new URL(url);
  let headers = new Headers(init.headers);
  for (let hop = 0; ; hop++) {
    if (init.signal?.aborted) throw init.signal.reason ?? new Error("Request cancelled before dispatch");
    try { counter.consume("external"); }
    catch (error) { throw error instanceof InvocationBudgetError ? error.withRequestOutcome(hop === 0 ? false : "unknown") : error; }
    const response = await fetch(current.href, { ...init, headers, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status) || init.redirect === "manual") return response;
    const location = response.headers.get("Location");
    if (!location) return response;
    try {
      if (!follow || !["GET", "HEAD"].includes(method) || hop >= 5) {
        throw new AppError("上游重定向未跟随；写操作不会重复发送", 502, "upstream_redirect_rejected");
      }
      const next = new URL(location, current);
      if (next.protocol !== "https:" || next.username || next.password) throw new AppError("不安全的上游重定向", 502, "upstream_redirect_rejected");
      if (next.origin !== current.origin) {
        headers = new Headers(headers);
        headers.delete("authorization");
        headers.delete("cookie");
        // API-key headers are provider-specific; never forward ANY custom header.
        headers = new Headers([...headers].filter(([name]) => ["accept", "user-agent"].includes(name.toLowerCase())));
      }
      current = next;
    } finally {
      if (response.body) await response.body.cancel().catch(() => {});
    }
  }
}
