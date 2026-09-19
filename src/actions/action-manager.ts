import { ActionRepository } from "../repositories/action-repository";
import { ActionStore } from "./action-store";
import { ActionService } from "../services/action-service";

export function createActionManager(db: ConstructorParameters<typeof ActionRepository>[0]) {
  return new ActionService(new ActionRepository(db));
}

export function createActionStore(db: ConstructorParameters<typeof ActionRepository>[0]) {
  return new ActionStore(new ActionRepository(db));
}
