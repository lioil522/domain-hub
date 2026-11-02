import { apiJson } from "../api/request";
import { readSessionToken, type ApiFetch } from "../api/client";
import type { AppLog } from "../types/log";

export class LogFeedStoppedError extends Error {
  constructor() { super("日志读取已停止"); this.name = "LogFeedStoppedError"; }
}

export function mergeLogFeed(current: AppLog[], incoming: AppLog[]) {
  const rows = new Map(current.map(log => [log.id, log]));
  for (const log of incoming) rows.set(log.id, log);
  return [...rows.values()].sort((a, b) => b.id - a.id).slice(0, 100);
}

/** One bounded local read per update. A full refresh fences any older delta. */
export function createLogFeed(apiFetch: ApiFetch, session: string | null, callbacks: { full: (logs: AppLog[]) => void; delta: (logs: AppLog[]) => void; loading: (value: boolean) => void }, timeoutMs = 10000) {
  let cursor = 0, generation = 0, stopped = false;
  let flight: { controller: AbortController; promise: Promise<void> } | undefined;
  const active = () => !stopped && Boolean(session) && readSessionToken() === session;
  const load = (full: boolean, signal?: AbortSignal) => {
    if (!active() || signal?.aborted) return Promise.resolve();
    if (!full && flight) return flight.promise;
    if (full) { generation++; flight?.controller.abort(); }
    const version = generation, after = full ? undefined : cursor;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (full) callbacks.loading(true);
    const entry = { controller, promise: Promise.resolve() };
    entry.promise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancelled = () => {};
      try {
        const data = await Promise.race([
          apiJson<{ success: boolean; logs: AppLog[]; nextCursor: number }>(apiFetch, `/api/logs${after === undefined ? "" : `?after_id=${after}`}`, { signal: controller.signal }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("读取日志超时")); controller.abort(); }, timeoutMs); }),
          new Promise<never>((_, reject) => { cancelled = () => reject(new LogFeedStoppedError()); controller.signal.addEventListener("abort", cancelled, { once: true }); if (controller.signal.aborted) cancelled(); }),
        ]);
        if (!active() || controller.signal.aborted || generation !== version) return;
        if (!data.success || !Array.isArray(data.logs) || data.logs.length > 100 || data.logs.some(log => !Number.isSafeInteger(log.id) || log.id <= 0 || after !== undefined && log.id <= after) || new Set(data.logs.map(log => log.id)).size !== data.logs.length || data.nextCursor !== Math.max(after ?? 0, ...data.logs.map(log => log.id))) throw new Error("日志增量响应无效");
        cursor = data.nextCursor;
        if (full) callbacks.full(mergeLogFeed([], data.logs)); else if (data.logs.length) callbacks.delta(data.logs);
      } finally {
        clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", cancelled);
        if (flight === entry) { flight = undefined; if (full && active()) callbacks.loading(false); }
      }
    })();
    flight = entry;
    return entry.promise;
  };
  return {
    start: () => { stopped = false; },
    full: () => load(true),
    tail: (signal?: AbortSignal) => load(false, signal),
    settle: async (signal?: AbortSignal) => { try { await flight?.promise; } catch { /* Final read can recover a cancelled in-flight delta. */ } await load(false, signal); },
    stop: () => { stopped = true; generation++; flight?.controller.abort(); },
  };
}

export function shouldStreamLogs(session: string | null, onLogPage: boolean, visible: boolean, activity: boolean) {
  return Boolean(session && onLogPage && visible && activity);
}

/** Start only for real activity; no interval or read exists while idle. */
export function startLogPolling(read: (signal: AbortSignal) => Promise<void>, intervalMs = 1500) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    if (controller.signal.aborted) return;
    try { await read(controller.signal); } catch { /* Keep the last good feed; bounded active polling can recover. */ }
    if (!controller.signal.aborted) timer = setTimeout(() => void run(), intervalMs);
  };
  void run();
  return () => { controller.abort(); clearTimeout(timer); };
}
