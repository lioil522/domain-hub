/**
 * 账号分批与轮转游标模块
 *
 * NOTE: 配合 Cloudflare Worker 免费计划 50 次子请求硬限，将全部账号拆分为环状批次滚动执行。
 */

import type { DatabaseManager } from "../db";

export const SYNC_ACCOUNT_BATCH_SIZE = 5;
export const ACCOUNT_CURSOR_KEY = "sync:cursor:accounts";

export interface AccountCursor {
  lastId: number;
  rounds: number;
}

export async function readAccountCursor(dbManager: DatabaseManager): Promise<AccountCursor> {
  const fallback: AccountCursor = { lastId: 0, rounds: 0 };
  try {
    const raw = await dbManager.getCache(ACCOUNT_CURSOR_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<AccountCursor>;
    const lastId = Number(parsed?.lastId);
    const rounds = Number(parsed?.rounds);
    return {
      lastId: Number.isFinite(lastId) && lastId > 0 ? Math.floor(lastId) : 0,
      rounds: Number.isFinite(rounds) && rounds > 0 ? Math.floor(rounds) : 0,
    };
  } catch {
    return fallback;
  }
}

export function pickAccountBatch<T extends { id: number }>(
  accounts: T[],
  cursor: AccountCursor,
  batchSize: number
): { batch: T[]; nextCursor: AccountCursor } {
  if (accounts.length === 0) {
    return { batch: [], nextCursor: cursor };
  }
  let start = 0;
  let wrapped = false;
  if (cursor.lastId > 0) {
    const idx = accounts.findIndex((a) => a.id > cursor.lastId);
    if (idx === -1) {
      start = 0;
      wrapped = true;
    } else {
      start = idx;
    }
  }
  const size = Math.min(batchSize, accounts.length);
  const batch: T[] = [];
  for (let i = 0; i < size; i++) {
    batch.push(accounts[(start + i) % accounts.length]);
  }
  const last = batch[batch.length - 1];
  return {
    batch,
    nextCursor: {
      lastId: last ? last.id : cursor.lastId,
      rounds: cursor.rounds + (wrapped ? 1 : 0),
    },
  };
}
