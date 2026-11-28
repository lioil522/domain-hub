import type { DatabaseManager } from "../db";
import { CloudflareClient, mapZoneToUpstream } from "../cloudflare";
import { CF_ZONE_ROUNDS_PER_RUN } from "../cron/cf-helpers";
import type { CloudflareJobCheckpoint, CloudflareProgress } from "../db/dao/cloudflare-sync-dao";

/** Shared by manual sync and Cron. Each committed page is resumable across invocations. */
export async function syncCloudflareSlice(
  db: DatabaseManager,
  accountId: number,
  client: CloudflareClient,
  maxPages = CF_ZONE_ROUNDS_PER_RUN,
  planJob?: CloudflareJobCheckpoint,
): Promise<CloudflareProgress> {
  const lease = await db.claimCloudflareSync(accountId, client.credentialFingerprint);
  try {
    for (let round = 0; round < Math.max(1, Math.min(50, Math.floor(maxPages))); round++) {
      const page = await client.listZones({ startPage: lease.nextPage, maxPages: 1 });
      await db.commitCloudflareSyncPage(accountId, lease, page.zones.map(mapZoneToUpstream), page, planJob);
      if (!page.hasMore) return { completed: true, totalSynced: lease.totalSynced, nextPage: lease.nextPage };
    }
    return { completed: false, totalSynced: lease.totalSynced, nextPage: lease.nextPage };
  } finally {
    await db.releaseCloudflareSync(accountId, lease);
  }
}
