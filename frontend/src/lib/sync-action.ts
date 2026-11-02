import { actionsApi } from "../api/endpoints/actions";
import { readSessionToken, type ApiFetch } from "../api/client";
import type { ApiResponse } from "../types/api";
import { advancePlan } from "./sliced-sync";

export interface SyncAction {
  id: string;
  status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
  error?: string | null;
}

export class ActionWaitError extends Error {
  constructor(readonly code: "timeout" | "session_changed" | "invalid_response", message: string) {
    super(message);
  }
}

export async function waitForSyncAction(apiFetch: ApiFetch, id: string, options: {
  timeoutMs?: number;
  intervalMs?: number;
  session?: string | null;
} = {}): Promise<SyncAction> {
  const session = options.session === undefined ? readSessionToken() : options.session;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const checkSession = () => {
    if (readSessionToken() !== session) throw new ActionWaitError("session_changed", "会话已变化，已停止等待原同步任务");
  };
  while (Date.now() < deadline) {
    checkSession();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let data;
    try {
      data = await Promise.race([
        actionsApi.get(apiFetch, id, { signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ActionWaitError("timeout", "等待同步结果超时，未确认完成；任务可能已中断，请查看日志后再同步"));
          }, Math.min(10_000, Math.max(1, deadline - Date.now())));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    checkSession();
    const action = data.action;
    if (!data.success || !action || action.id !== id || !["queued", "running", "completed", "partial", "failed", "cancelled"].includes(action.status)) {
      throw new ActionWaitError("invalid_response", "无法确认同步任务状态，请检查前后端版本及日志");
    }
    if (action.status !== "running" && action.status !== "queued") return action;
    await new Promise(resolve => setTimeout(resolve, Math.min(options.intervalMs ?? 1500, Math.max(0, deadline - Date.now()))));
  }
  checkSession();
  throw new ActionWaitError("timeout", "等待同步结果超时，未确认完成；任务可能已中断，请查看日志后再同步");
}

type Toast = (level: "success" | "info" | "warning" | "error", message: string) => void;

// Refresh successful cache writes even after partial/failed work, but never infer completion from them.
export async function finishSyncAction(apiFetch: ApiFetch, data: ApiResponse, refresh: () => void | Promise<unknown>, showToast: Toast,
  session: string | null = readSessionToken()): Promise<void> {
  if (readSessionToken() !== session) return;
  const refreshView = async () => {
    try { await refresh(); return true; }
    catch (error) {
      if (readSessionToken() === session) showToast("error", `刷新列表失败：${error instanceof Error ? error.message : "未知错误"}`);
      return false;
    }
  };
  if (!data.success) {
    showToast("error", data.message || "同步任务启动失败");
    return;
  }
  if (data.skipped) {
    showToast("info", data.message || "无需同步");
    return;
  }
  if (data.syncWarning) {
    showToast("warning", data.syncWarning);
    await refreshView();
    return;
  }
  if (data.syncPlan) {
     showToast("info", "独立账号正在同步；已知限流最多等待 2 分钟继续原断点。切到后台/关闭页面暂停，不含续期");
    try {
      const done = await advancePlan(apiFetch, { session, manual: true, provider: data.provider, accountIds: data.account_ids });
      if (readSessionToken() !== session) return;
      await refreshView();
       showToast(done ? "success" : "warning", done ? "同步完成" : "同步已暂停或暂缓，并非服务端排队；断点已保留，请保持页面可见并再次点击继续，或在操作记录中取消");
    } catch (e) { if (readSessionToken() === session) { showToast("warning", e instanceof Error ? e.message : "同步未完成"); await refreshView(); } }
    return;
  }
  if (!data.actionId) {
    showToast("warning", "同步请求已接受，但后端未返回任务 ID，无法确认完成；请升级后端或查看日志");
    await refreshView();
    return;
  }
  showToast("info", "同步任务已启动，正在等待结果…");
  try {
    const action = await waitForSyncAction(apiFetch, data.actionId, { session });
    if (readSessionToken() !== session) return;
    if (!(await refreshView())) return;
    if (readSessionToken() !== session) return;
    if (action.status === "completed") showToast("success", "同步完成");
    else if (action.status === "partial") showToast("warning", `同步部分完成：${action.error || "请查看日志并重试未完成部分"}`);
    else if (action.status === "cancelled") showToast("warning", "同步任务已标记取消；已发出的上游请求可能仍会完成");
    else showToast("error", `同步失败：${action.error || "请查看日志"}`);
  } catch (error) {
    if (readSessionToken() !== session) return;
    showToast(error instanceof ActionWaitError ? "warning" : "error", error instanceof Error ? error.message : "无法获取同步结果");
    await refreshView();
  }
}

export type WaitForAccountDomainSync = (
  accountIds: number[], label: string, actionId?: string, providerLookup?: (id: number) => string | undefined,
  session?: string | null, syncWarning?: string
) => Promise<void>;
