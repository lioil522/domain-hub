import { ActionRepository, type StoredAction } from "../repositories/action-repository";
import { isActionType, type ActionType } from "../actions/action-types";
import type { AccountSyncSummary } from "./sync-results";

export class ActionService {
  constructor(private readonly repository: ActionRepository) {}

  async start(type: string, metadata?: unknown): Promise<StoredAction> {
    if (!isActionType(type)) throw new Error(`Invalid action type: ${type}`);
    const now = new Date().toISOString();
    const action: StoredAction = { id: crypto.randomUUID(), type, status: "running", progress: 0, started_at: now, finished_at: null, error: null, metadata };
    await this.repository.create(action);
    return action;
  }

  async update(id: string, patch: Partial<StoredAction>): Promise<StoredAction> {
    await this.repository.update(id, patch);
    const action = await this.repository.get(id);
    if (!action) throw new Error(`Action ${id} not found`);
    return action;
  }

  get(id: string) { return this.repository.get(id); }
  list(limit = 50) { return this.repository.list(limit); }

  async complete(id: string) {
    return this.update(id, { status: "completed", progress: 100, finished_at: new Date().toISOString() });
  }

  async fail(id: string, error: string) {
    return this.update(id, { status: "failed", error, finished_at: new Date().toISOString() });
  }

  async cancel(id: string) {
    return this.update(id, { status: "cancelled", finished_at: new Date().toISOString() });
  }

  async updateSyncProgress(id: string, metadata: unknown, progress: number) {
    return this.repository.updateActive(id, { status: "running", metadata, progress: Math.min(99, progress) });
  }

  async finishSync(id: string, summary: AccountSyncSummary, metadata: Record<string, unknown>) {
    const total = summary.results.length || 1;
    const failed = summary.failed > 0 || !!summary.error;
    const status = failed ? "failed" : summary.paused > 0 ? "paused" : "completed";
    await this.repository.updateActive(id, {
      status, progress: status === "completed" ? 100 : Math.round(100 * (summary.completed + summary.skipped) / total),
      error: failed ? summary.error || `${summary.failed} 个账号同步失败；请查看逐账号结果` : null,
      metadata: { ...metadata, summary }, finished_at: new Date().toISOString(),
    });
    return this.get(id);
  }

  async failActive(id: string, error: string, metadata: Record<string, unknown>) {
    const current = await this.get(id);
    if (!current) return;
    await this.repository.updateActive(id, { status: "failed", progress: current.progress, error,
      metadata: { ...metadata, previous: current.metadata }, finished_at: new Date().toISOString() });
  }
}
