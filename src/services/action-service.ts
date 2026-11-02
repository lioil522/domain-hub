import { ActionRepository, type StoredAction } from "../repositories/action-repository";
import { isActionType, isActionStatus } from "../actions/action-types";

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
    if (patch.status !== undefined && !isActionStatus(patch.status)) throw new Error("Invalid action status");
    if (patch.progress !== undefined && (!Number.isFinite(patch.progress) || patch.progress < 0 || patch.progress > 100)) throw new Error("Progress must be between 0 and 100");
    if (patch.status && !["running", "queued"].includes(patch.status)) {
      patch = { ...patch, finished_at: new Date().toISOString() };
    }
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

  async settleSync(id: string, result: import("./sync-result").SyncSummary, metadata: object) {
    return this.update(id, {
      status: result.status, progress: result.status === "completed" ? 100 : 0,
      error: result.status === "completed" ? null : result.accounts.flatMap(a => a.issues.map(i => `[账号 ${a.accountId}] ${i.message}`)).join("；"),
      metadata: { ...metadata, result },
    });
  }

  async cancel(id: string) {
    return this.update(id, { status: "cancelled", finished_at: new Date().toISOString() });
  }
}
