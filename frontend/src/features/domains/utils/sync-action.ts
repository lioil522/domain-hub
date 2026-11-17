import type { ApiFetch } from "../../../api/client";
import { apiJson } from "../../../api/request";
import { requestDeadline } from "../../../api/request-deadline";

export type SyncAction = {
  id: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  error?: string | null;
  metadata?: unknown;
};
type Toast = (kind: "success" | "error" | "info" | "warning", message: string) => void;
export type WaitForAccountSync = (ids: number[], label: string, baseline?: Map<number, string>,
  providerLookup?: (id: number) => string | undefined, actionId?: string) => Promise<void>;

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function waitForSyncAction(apiFetch: ApiFetch, id: string,
  options: { timeoutMs?: number; signal?: AbortSignal; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  const now = options.now || Date.now;
  const deadline = now() + (options.timeoutMs ?? 120000);
  while (!options.signal?.aborted) {
    const request = requestDeadline(options.signal);
    let response;
    try { response = await apiJson<{ action: SyncAction }>(apiFetch, `/api/actions/${encodeURIComponent(id)}`, { signal: request.signal }); }
    finally { request.dispose(); }
    const action = response.action;
    if (!action || action.id !== id || !["queued", "running", "paused", "completed", "failed", "cancelled"].includes(action.status)) throw new Error("同步任务状态响应无效");
    if (!["queued", "running"].includes(action.status)) return action;
    if (now() >= deadline) return { ...action, status: "pending" as const };
    await (options.sleep || ((ms: number) => wait(ms, options.signal)))(Math.min(1500, Math.max(0, deadline - now())));
  }
  throw new DOMException("同步等待已取消", "AbortError");
}

export function notifyActionRefresh() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("action:refresh"));
}

/** Started, paused and timed out are never presented as successfully completed. */
export async function observeSyncAction(apiFetch: ApiFetch, id: unknown, showToast: Toast) {
  notifyActionRefresh();
  if (typeof id !== "string" || !id) { showToast("info", "请求已处理，服务端未提供可核验的同步任务"); return; }
  showToast("info", "同步任务已启动，正在等待实际执行结果");
  const action = await waitForSyncAction(apiFetch, id);
  notifyActionRefresh();
  if (action.status === "completed") showToast("success", "同步完成");
  else if (action.status === "failed") showToast("error", action.error || "同步失败，请查看逐账号执行结果");
  else if (action.status === "paused") showToast("warning", "分片已保存，尚未全量完成；请再次点击同步继续");
  else if (action.status === "cancelled") showToast("warning", "同步任务已取消；已提交的数据不会回滚");
  else showToast("info", "同步尚未完成，请继续查看操作中心；未将超时当作成功");
  return action;
}
