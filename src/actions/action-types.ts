export const ACTION_TYPES = [
  "sync",
  "renew",
  "batch-delete",
  "batch-create",
  "dns-update",
  "scanner",
  "backup",
  "restore",
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export interface Action {
  id: string;
  type: ActionType;
  status: ActionStatus;
  progress: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  metadata?: unknown;
}

export function isActionType(value: unknown): value is ActionType {
  return typeof value === "string" && (ACTION_TYPES as readonly string[]).includes(value);
}

export function isActionStatus(value: unknown): value is ActionStatus {
  return typeof value === "string" && (ACTION_STATUSES as readonly string[]).includes(value);
}
