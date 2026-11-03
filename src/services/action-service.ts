import { ActionRepository, type StoredAction } from "../repositories/action-repository";
import { isActionType, type ActionType } from "../actions/action-types";

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
}
