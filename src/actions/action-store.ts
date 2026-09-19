import { ActionRepository, type StoredAction } from "../repositories/action-repository";

/** Persistence-only store used by the ActionManager; business transitions stay in ActionService. */
export class ActionStore {
  constructor(private readonly repository: ActionRepository) {}
  create(action: StoredAction) { return this.repository.create(action); }
  update(id: string, patch: Partial<StoredAction>) { return this.repository.update(id, patch); }
  get(id: string) { return this.repository.get(id); }
  list(limit = 50) { return this.repository.list(limit); }
}
