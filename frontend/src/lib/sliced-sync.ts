import { apiJson, ApiRequestError } from "../api/request";
import { readSessionToken, type ApiFetch } from "../api/client";

export interface SliceState {
   accountId: number; taskId?: string; status: string; phase?: string; continuation?: boolean;
   retry_after_ms?: number; last_completed_at?: number | null; error?: string | null; eligible?: boolean; provider?: string;
    alias?: string; updated_at?: number; list_stage?: string; domain_count?: number; list_pages?: number; dns_completed?: number;
    version?: number;
    executing?: boolean;
    advancing?: boolean; client_error?: string;
    budget_yield?: boolean;
}
export interface SlicePlan { success: boolean; plans: SliceState[]; nextAfter: number | null; enabled: boolean }
interface Lifecycle { session: string | null; stopped?: () => boolean; signal?: AbortSignal; requestTimeoutMs?: number }
const active = (options: Lifecycle) => canAdvanceSync(readSessionToken(), options.session, typeof document === "undefined" || document.visibilityState === "visible", Boolean(options.signal?.aborted || options.stopped?.()));
// Includes provider admission (up to 65s) and transport (20s), but not an
// unbounded browser wait. Timeout never implies the server/remote write stopped.
async function sliceJson<T extends object>(apiFetch: ApiFetch, path: string, body: unknown, options: Lifecycle) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => { controller.abort(); reject(new ApiRequestError("同步未确认完成，断点保留；不会自动重发上游操作")); };
    timer = setTimeout(cancel, options.requestTimeoutMs ?? 100000);
    options.signal?.addEventListener("abort", cancel, { once: true });
  });
  if (options.signal?.aborted) cancel();
  try { return await Promise.race([apiJson<T>(apiFetch, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal }), aborted]); }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); }
}
export function canAdvanceSync(session: string | null, expected: string | null, visible: boolean, stopped: boolean) {
  return Boolean(expected && session === expected && visible && !stopped);
}
export function validateSliceState(value: SliceState, accountId: number): SliceState {
  if (!value || value.accountId !== accountId || !["queued", "running", "paused", "blocked", "completed", "cancelled", "invalidated"].includes(value.status) ||
      typeof value.taskId !== "string" || !value.taskId || value.taskId.length > 128 || typeof value.continuation !== "boolean" ||
      value.budget_yield !== undefined && (typeof value.budget_yield !== "boolean" || value.budget_yield && (value.status !== "paused" || !value.continuation)) ||
     !Number.isSafeInteger(value.retry_after_ms) || value.retry_after_ms! < 0) throw new Error("无法确认分片同步状态");
  return value;
}
export async function advanceAccount(apiFetch: ApiFetch, accountId: number, options: {
   manual: boolean; session: string | null; stopped?: () => boolean; signal?: AbortSignal; requestTimeoutMs?: number; onState?: (state: SliceState) => void;
   taskId?: string; retryDeadline?: number; initialState?: SliceState; onPending?: () => void;
}) {
   let taskId = options.taskId;
    let current = options.initialState;
    let budgetYields = 0;
   const retryDeadline = options.retryDeadline ?? Date.now() + 120000;
   for (let slice = 0; slice < 500; slice++) {
     if (!active(options)) return false;
     if (current?.retry_after_ms && current.retry_after_ms > 0) {
        // Manual intent can wait through a known cooldown with login sync off.
        // An explicitly confirmed budget pause can also resume an enabled page
        // stream. Hidden/logout stops NEW slices; no automatic setting changes.
       // HTTP errors/unknown outcomes are never retried by this loop.
        if ((!options.manual && !current.budget_yield) || Date.now() + current.retry_after_ms > retryDeadline) return false;
       const until = Date.now() + current.retry_after_ms;
       while (Date.now() < until) {
         if (!active(options)) return false;
         await new Promise<void>(resolve => {
           const finish = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", finish); resolve(); };
           const timer = setTimeout(finish, Math.min(1000, Math.max(1, until - Date.now())));
           options.signal?.addEventListener("abort", finish, { once: true });
           if (options.signal?.aborted) finish();
         });
       }
       if (!active(options)) return false;
     }
     options.onPending?.();
     const data = await sliceJson<SliceState & { success: boolean; message?: string }>(apiFetch, `/api/accounts/${accountId}/sync-step`, { manual: options.manual, taskId }, options);
    if (!active(options)) return false;
    if (!data.success) throw new Error(data.message || "分片同步失败");
     const state = validateSliceState(data, accountId); taskId = state.taskId; current = state;
     options.onState?.(state);
     if (state.status === "completed") return true;
     // Fresh requests can recover invocation-local exhaustion, not a permanently
     // impossible slice. Never spin for 500 identical budget failures.
      if (state.budget_yield) budgetYields++;
      else if (state.status === "queued") budgetYields = 0;
     if (budgetYields >= 3) throw new Error("连续三个分片预算不足，已停止自动推进；断点保留，请检查预算日志");
    // Do not sleep through a cooled key: the next account can proceed independently.
      if (!state.continuation || !options.manual && state.retry_after_ms! > 0 && !state.budget_yield) return false;
  }
  return false;
}
export async function advancePlan(apiFetch: ApiFetch, options: Lifecycle & { manual: boolean; localOnly?: boolean; provider?: string; accountIds?: number[]; retryWaitMs?: number; onState?: (state: SliceState) => void; onError?: (accountId: number | null, message: string) => void; onCompleted?: (state: SliceState) => void | Promise<void> }) {
    let after = 0, complete = true;
    let failedPlan = false;
    const running = new Set<Promise<void>>(), failures: string[] = [];
    // One global pool, not 25 additional streams per page. Hold only one pending
    // page; finished slots admit its accounts while a slow earlier stream runs.
    // All 25 occupied slots still apply backpressure (never widen concurrency).
    const lifecycle = { ...options, stopped: () => failedPlan || Boolean(options.stopped?.()) };
   const retryDeadline = Date.now() + (options.retryWaitMs ?? 120000);
   const report = (state: SliceState) => {
     if (!active(options)) return;
     options.onState?.(state);
     if (options.manual && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("domain-hub:sync-state", { detail: { state, session: options.session } }));
   };
   try { do {
    if (!active(options)) return false;
    const plan = await sliceJson<SlicePlan>(apiFetch, "/api/sync/plan", { manual: options.manual, provider: options.provider, accountIds: options.accountIds, after }, options);
    if (!active(options)) return false;
    if (!plan.success || !Array.isArray(plan.plans) || plan.plans.length > 25 || plan.nextAfter !== null && (!Number.isSafeInteger(plan.nextAfter) || plan.nextAfter <= after)) throw new Error("同步计划响应无效");
    let previous = after;
    for (const state of plan.plans) {
       if (!state || !Number.isSafeInteger(state.accountId) || state.accountId <= previous || typeof state.eligible !== "boolean" || !["stale", "queued", "running", "paused", "blocked", "completed", "cancelled", "invalidated"].includes(state.status) || options.accountIds && !options.accountIds.includes(state.accountId) ||
         state.budget_yield !== undefined && (typeof state.budget_yield !== "boolean" || state.budget_yield && (state.status !== "paused" || !state.continuation))) throw new Error("同步计划账号无效");
       if (state.retry_after_ms !== undefined && (!Number.isSafeInteger(state.retry_after_ms) || state.retry_after_ms < 0)) throw new Error("同步计划等待时间无效");
       previous = state.accountId;
    }
    if (plan.nextAfter !== null && (plan.plans.length !== 25 || plan.nextAfter !== previous)) throw new Error("同步计划分页无效");
     for (const state of plan.plans) report(state);
      for (const state of plan.plans) {
        if (!active(options)) return false;
        if (options.localOnly) continue;
        if (!state.eligible) { if (state.continuation) complete = false; continue; }
        if (!options.manual && state.retry_after_ms && state.retry_after_ms > 0 && !state.budget_yield) { complete = false; continue; }
        while (running.size >= 25 && active(options)) await Promise.race(running);
        if (!active(options)) return false;
        const stream = (async () => {
        let latest = state;
        try {
          const done = await advanceAccount(apiFetch, state.accountId, { ...lifecycle, retryDeadline,
            taskId: state.continuation ? state.taskId : undefined, initialState: state.continuation ? state : undefined,
           onPending: () => report({ ...latest, advancing: true, client_error: undefined }),
           onState: next => { latest = { ...state, ...next, advancing: false, client_error: undefined }; report(latest); } });
         if (!done) complete = false;
         if (!done) report({ ...latest, advancing: false });
          if (done && active(lifecycle)) await options.onCompleted?.(latest);
       } catch (error) {
         complete = false;
          if (!active(lifecycle)) return;
         const message = error instanceof Error ? error.message : "同步推进失败，断点已保留";
         report({ ...latest, advancing: false, client_error: message });
         options.onError?.(state.accountId, message);
          if (failures.length < 25) failures.push(`账号 ${state.accountId}：${message}`);
        }
        })();
        const tracked = stream.finally(() => running.delete(tracked));
        running.add(tracked);
      }
      if (!active(options)) return false;
     if (plan.nextAfter === null) break;
     after = plan.nextAfter;
   } while (true); }
   catch (error) { failedPlan = true; if (!active(options)) return false; throw error; }
   finally { await Promise.allSettled(running); }
   if (!active(options)) return false;
   if (failures.length && !options.onError) throw new Error(failures.join("；").slice(0, 1600));
   return complete;
}
