/**
 * Cloudflare Zone 游标与同步快路径辅助模块
 */

import type { DatabaseManager } from "../db";
import { CloudflareClient } from "../cloudflare";

export const CF_ZONE_PROBE_PAGES = 1;
export const CF_ZONE_ROUNDS_PER_RUN = 3;
export const CF_ZONE_CURSOR_TTL = 3 * 24 * 3600;
export const CF_EXPIRY_BUDGET = 100;
export const DNS_RECORDS_CACHE_MODE_KEY = "dns_records_cache_mode";

export function cfZoneCursorKey(accountId: number): string {
  return `cf_zone_cursor:${accountId}`;
}

export interface CfZoneCursor {
  startPage: number;
  syncedBefore: number;
}

export async function readCfZoneCursor(dbManager: DatabaseManager, key: string): Promise<CfZoneCursor> {
  const fallback: CfZoneCursor = { startPage: 1, syncedBefore: 0 };
  try {
    const raw = await dbManager.getCache(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<CfZoneCursor>;
    const startPage = Number(parsed?.startPage);
    const syncedBefore = Number(parsed?.syncedBefore);
    return {
      startPage: Number.isFinite(startPage) && startPage >= 1 ? Math.floor(startPage) : 1,
      syncedBefore: Number.isFinite(syncedBefore) && syncedBefore > 0 ? Math.floor(syncedBefore) : 0,
    };
  } catch {
    return fallback;
  }
}

/**
 * 收集本面板管理的 Cloudflare zone 全集（zone 名 → 归属账号名 + zone id），
 * 供 DNSHE 同步时做快路径判断。
 */
export async function collectManagedCfZones(
  dbManager: DatabaseManager
): Promise<Map<string, { alias: string; zoneId: string }>> {
  const zones = new Map<string, { alias: string; zoneId: string }>();
  try {
    const cfRows = await dbManager.getDomains("", "", undefined, "cloudflare");
    for (const row of cfRows) {
      const name = String(row.full_domain || "").trim().toLowerCase();
      if (!name) continue;
      if (!zones.has(name)) {
        zones.set(name, {
          alias: String(row.account_alias || `账号 ${row.account_id}`),
          zoneId: String(row.remote_id || ""),
        });
      }
    }
  } catch (e) {
    console.error("collectManagedCfZones failed, fallback to full dns_records fetch:", e);
  }
  return zones;
}

/**
 * 为「已确认委派到本面板某个 CF 账号」的域名解析出真实归属账号名与 zone id。
 */
export async function resolveCfZoneOwner(
  dbManager: DatabaseManager,
  accountId: number,
  host: string,
  cachedZoneCursor?: WeakMap<CloudflareClient, number>
): Promise<{ alias: string; zoneId: string } | null> {
  try {
    const { client, alias } = await dbManager.getClientForAccount(accountId);
    if (!(client instanceof CloudflareClient)) return null;

    let page = cachedZoneCursor?.get(client) ?? 1;
    for (let guard = 0; guard < 50; guard++) {
      const res = await client.listZones({ startPage: page, maxPages: 1 });
      const hit = res.zones.find((z) => String(z.name || "").trim().toLowerCase() === host);
      if (hit) {
        cachedZoneCursor?.set(client, page);
        return { alias, zoneId: String(hit.id || "") };
      }
      if (!res.hasMore) break;
      page = res.nextPage;
      cachedZoneCursor?.set(client, page);
    }
    return null;
  } catch (e) {
    console.error(`resolveCfZoneOwner failed for ${host}:`, e);
    return null;
  }
}
