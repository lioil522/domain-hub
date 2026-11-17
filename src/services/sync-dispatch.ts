import type { DatabaseManager } from "../db";
import type { SyncWorkOptions } from "../db/dao/sync-work-dao";
import { runOneSyncSlice, type SyncRunOptions } from "./sync-work-runner";
import type { WebhookType } from "../cron/notification";

export interface SyncDispatchEnv {
  WEBHOOK_URL?: string; WEBHOOK_TYPE?: string;
  SYNC_QUEUE?: { send(message: { kind: "sync_tick" }, options: { delaySeconds: number }): Promise<unknown> };
}
export function syncRunOptions(env: SyncDispatchEnv): SyncRunOptions {
  return { webhookUrl: env.WEBHOOK_URL, webhookType: env.WEBHOOK_TYPE as WebhookType | undefined,
    schedule: env.SYNC_QUEUE ? async delaySeconds => { await env.SYNC_QUEUE!.send({ kind: "sync_tick" }, { delaySeconds }); } : undefined };
}
export function kickSyncWork(db: DatabaseManager, waitUntil: (task: Promise<unknown>) => void, env: SyncDispatchEnv = {}) {
  waitUntil(runOneSyncSlice(db, syncRunOptions(env)).catch(error => console.error("同步切片暂未推进，将由周期执行器恢复", error)));
}
export async function enqueueSyncAction(db: DatabaseManager, options: SyncWorkOptions,
  waitUntil: (task: Promise<unknown>) => void, env: SyncDispatchEnv = {}) {
  const id = await db.syncQueue().enqueue(options);
  kickSyncWork(db, waitUntil, env);
  return id;
}
