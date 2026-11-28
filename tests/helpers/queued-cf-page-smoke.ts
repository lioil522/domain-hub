import { DatabaseManager } from "../../src/db";
import type { CloudflareProgress } from "../../src/db/dao/cloudflare-sync-dao";

// Called only by the local workerd harness, on the snapshot fixture database.
export async function exercisePageCheckpoint(db: D1Database) {
  const manager = new DatabaseManager(db), queue = manager.syncQueue();
  await manager.executeRaw("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(3,'cf','fixture-cf','fake','cloudflare')");
  const action = await queue.enqueue({ label: "CF atomic checkpoint", accountIds: [3] });
  const work = await queue.claim();
  if (!work || work.action_id !== action) throw new Error("Fixture claim failed");
  await queue.bindAccount(work, await manager.readSyncAccount(3));
  await queue.begin(work, "cf");
  const lease = await manager.claimCloudflareSync(3, work.fingerprint);
  const plan = (p: CloudflareProgress) => queue.planCheckpoint(work, { phase: p.completed ? "done" : "cf", total: p.totalSynced, page: p.nextPage });
  const rows = [{ id: 800001, subdomain: "", rootdomain: "example", full_domain: "atomic.example", status: "active", expires_at: "" }];
  try {
    await manager.executeRaw(`CREATE TRIGGER fail_cf_page BEFORE UPDATE OF next_page ON cf_sync_state
      WHEN NEW.next_page>OLD.next_page BEGIN SELECT RAISE(ABORT,'injected CF checkpoint failure'); END`);
    try {
      await manager.commitCloudflareSyncPage(3, lease, rows, { hasMore: true, nextPage: 2 }, plan);
      throw new Error("CF checkpoint unexpectedly advanced");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("injected CF checkpoint failure")) throw error;
    }
    const persisted = (await queue.jobs(action))[0];
    if (JSON.parse(persisted.cursor).page !== 1 || persisted.cursor !== work.cursor || lease.nextPage !== 1 ||
      await manager.getDomainById(rows[0].id)) throw new Error("Partial CF page or outer checkpoint after failed D1 transaction");
    await manager.executeRaw("DROP TRIGGER fail_cf_page");
    await manager.commitCloudflareSyncPage(3, lease, rows, { hasMore: true, nextPage: 2 }, plan);
    await manager.commitCloudflareSyncPage(3, lease, [], { hasMore: false, nextPage: 3 }, plan);
    const saved = (await queue.jobs(action))[0].cursor;
    await manager.executeRaw("UPDATE accounts SET api_key='fixture-replacement' WHERE id=3");
    try {
      await queue.checkpoint(work, { phase: "stale" });
      throw new Error("Stale D1 credential checkpoint unexpectedly committed");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("租约")) throw error;
    }
    await manager.deleteAccount(3);
    const revoked = (await queue.jobs(action))[0];
    if (revoked.cursor !== saved || revoked.status !== "cancelled" || revoked.lease_token !== null)
      throw new Error("D1 deletion did not revoke the lease with its original checkpoint");
    return JSON.parse(saved) as { phase: string; page: number; total: number };
  } finally { await manager.releaseCloudflareSync(3, lease); }
}
