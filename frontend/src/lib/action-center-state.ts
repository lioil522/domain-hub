import type { SyncAction } from "./sync-action";
import type { SliceState } from "./sliced-sync";

export interface ActionItem extends Partial<Omit<SliceState, "status" | "error">> {
  id: string; type: string; status: SyncAction["status"]; progress: number;
  sync_status?: string; error?: string | null; metadata?: unknown;
}

export function sliceProgress(state: Partial<SliceState>) {
  if (state.status === "completed") return 100;
  if (state.phase === "dns") return 60 + (state.domain_count && state.dns_completed !== undefined ? Math.min(25, 25 * state.dns_completed / state.domain_count) : 0);
  return state.phase === "list" ? state.list_stage === "publish" ? 45 : 10 : state.phase === "cleanup" || state.phase === "quota" ? 90 : 0;
}

export function mergeSyncActions(actions: ActionItem[], states: Record<number, SliceState>): ActionItem[] {
  const result = new Map(actions.map(item => [item.id, item]));
  let recentCompletions = 0;
  for (const state of Object.values(states).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))) {
    if (!state.accountId && state.client_error) {
      result.set("sync-status", { id: "sync-status", type: "sync", status: "partial", progress: 0, error: state.client_error });
      continue;
    }
    if (!state.accountId || !state.taskId && !state.advancing) continue;
    const id = state.taskId ?? `sync-account-${state.accountId}`;
    const previous = result.get(id);
    if (previous && previous.version !== undefined && state.version !== undefined && previous.version > state.version) {
      result.set(id, { ...previous, alias: state.alias ?? previous.alias });
      continue;
    }
    if (previous?.sync_status && !state.advancing && previous.version !== undefined && previous.version === state.version) {
      result.set(id, { ...previous, alias: state.alias ?? previous.alias, client_error: state.client_error,
        error: state.client_error || previous.error });
      continue;
    }
    if (!previous && !state.continuation && !state.advancing && !state.client_error) {
      if (state.status !== "completed" || !state.updated_at || Date.now() / 1000 - state.updated_at > 300 || recentCompletions >= 12) continue;
      recentCompletions++;
    }
    const status = state.status === "completed" ? "completed" : state.status === "cancelled" ? "cancelled" : state.status === "invalidated" ? "failed" : state.status === "paused" || state.status === "blocked" ? "partial" : state.advancing || state.status === "running" ? "running" : "queued";
    result.set(id, { ...previous, ...state, id, type: "sync", status, sync_status: state.status,
      progress: sliceProgress(state), error: state.client_error || state.error });
  }
  return [...result.values()].sort((a, b) => Number(isExecutingAction(b)) - Number(isExecutingAction(a)));
}

export function isExecutingAction(item: ActionItem, _syncEnabled = false) {
  if (item.type !== "sync" || !item.sync_status) return item.status === "queued" || item.status === "running";
  return Boolean(item.advancing || (item.executing ?? item.sync_status === "running"));
}
