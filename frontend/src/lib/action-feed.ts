import { readSessionToken, type ApiFetch } from "../api/client";
import { actionsApi } from "../api/endpoints/actions";
import type { ActionItem } from "./action-center-state";

/** Passive local task snapshots; cleanup/old sessions can never publish. */
export function createActionFeed(apiFetch: ApiFetch, session: string | null, publish: (items: ActionItem[]) => void, loading: (value: boolean) => void, timeoutMs = 10000) {
  let stopped = false, generation = 0, refreshPending = false;
  let flight: { controller: AbortController; promise: Promise<void> } | undefined;
  const active = () => !stopped && Boolean(session) && readSessionToken() === session && !document.hidden;
  const load = (refreshAfterFlight = false): Promise<void> => {
    if (!active()) return Promise.resolve();
    if (flight) { refreshPending ||= refreshAfterFlight; return flight.promise; }
    const version = generation, controller = new AbortController();
    const entry = { controller, promise: Promise.resolve() };
    loading(true);
    entry.promise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort = () => {};
      try {
        const response = await Promise.race([
          actionsApi.list(apiFetch, 12, { signal: controller.signal }),
          new Promise<never>((_, reject) => {
            abort = () => reject(new Error("任务状态读取已停止"));
            controller.signal.addEventListener("abort", abort, { once: true });
            if (controller.signal.aborted) abort();
            timer = setTimeout(() => controller.abort(), timeoutMs);
          }),
        ]);
        if (active() && !controller.signal.aborted && version === generation && response.success && Array.isArray(response.actions)) publish(response.actions);
      } catch { /* Auxiliary UI keeps its last good snapshot, never triggers upstream work. */ }
      finally {
        clearTimeout(timer); controller.signal.removeEventListener("abort", abort);
        if (flight === entry) {
          flight = undefined;
          if (active()) loading(false);
          if (refreshPending) { refreshPending = false; void load(); }
        }
      }
    })();
    flight = entry;
    return entry.promise;
  };
  return {
    load,
    start: () => { stopped = false; },
    stop: () => { stopped = true; generation++; refreshPending = false; const previous = flight; flight = undefined; previous?.controller.abort(); },
  };
}
