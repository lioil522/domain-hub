// Test-only entry point. Never included by the production Worker build.
import worker from "../../src/index";
import { DatabaseManager } from "../../src/db";
import type { Bindings } from "../../src/routes/types";
import { CloudflareClient, mapZoneToUpstream } from "../../src/cloudflare";
import { syncCloudflareZoneBatch } from "../../src/services/cloudflare-sync";
import { DnsheRequestBudget } from "../../src/services/dnshe-request-budget";
import { ProviderApiError } from "../../src/errors/provider-api-error";
import { SharedProviderRequestScheduler } from "../../src/services/provider-request-scheduler";
import { DnsheAccountRequestScheduler } from "../../src/services/dnshe-account-scheduler";
import { transportProviders, transportFixture, type TransportProvider } from "../helpers/provider-transport";
import { coordinationFault, deferred } from "../helpers/coordination-fault";
import { DNSHEClient } from "../../src/dnshe";
import { dnsheSyncClock } from "../helpers/dnshe-sync-fixture";
import { deepSyncAccountDomains, resyncAccountsInBackground } from "../helpers/legacy-account-sync";
import { runDailySyncAndRenewal } from "../../src/cron/jobs/daily-sync";

const zone = (id: number) => ({ id: `runtime-zone-${id}`, name: `zone${id}.example`, status: "active" });

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/fixture/")) return worker.fetch(request, env, ctx);
    if (path === "/fixture/transport") {
      const query = new URL(request.url).searchParams;
      const provider = query.get("provider") as TransportProvider;
      if (!transportProviders.includes(provider)) return new Response(null, { status: 400 });
      const scheduled = query.get("scheduled") === "1";
      if (scheduled && !(await new DatabaseManager(env.DB, env.AES_KEY).ensureTables())) throw new Error("fixture bootstrap failed");
      const limits = { timeoutMs: Number(query.get("timeout") || 1000), maxResponseBytes: Number(query.get("cap") || 4 * 1024 * 1024),
        ...(scheduled ? { scheduler: new SharedProviderRequestScheduler(env.DB, provider) } : {}) };
      const client = transportFixture(provider, limits);
      try {
        await (query.get("write") === "1" ? client.write() : client.read());
        return Response.json({ success: true });
      } catch (error) {
        if (!(error instanceof ProviderApiError)) throw error;
        return Response.json({ success: false, provider: error.provider, status: error.status, error_code: error.error_code,
          retryAfterMs: error.retryAfterMs, code: error.code, rateLimited: error.rateLimited }, { status: error.statusCode });
      }
    }
    const db = new DatabaseManager(env.DB, env.AES_KEY);
    if (!(await db.ensureTables())) throw new Error("fixture bootstrap failed");
    if (path === "/fixture/dnshe-lane") {
      const key = new URL(request.url).searchParams.get("key") || "runtime-key";
      const lane = new DnsheAccountRequestScheduler(env.DB, key);
      const lease = await lane.acquire(1000);
      lease.assertReady!();
      // Deliberately abandoned to verify isolation across separate invocations.
      return Response.json({ success: true });
    }
    if (path === "/fixture/dnshe-lease-state") {
      const query = new URL(request.url).searchParams;
      const mode = query.get("mode");
      let now = Number(query.get("now") ?? 1000);
      const waits: number[] = [];
      const controller = new AbortController();
      let claimType: string | null = null;
      const inspect = coordinationFault(env.DB, async (sql, method, execute) => {
        if (mode === "fail-cleanup" && (sql === "SELECT value FROM cache WHERE key=?" || method === "run")) throw new Error("offline failed boundary");
        const result = await execute();
        if (sql.startsWith("INSERT INTO cache(key,value,expires_at)")) claimType = await env.DB.prepare("SELECT json_type(value,'$.leaseUntil') AS type FROM cache WHERE key LIKE 'dnshe_queue:v1:%' AND key NOT LIKE '%:blocked'").first<string>("type");
        return result;
      });
      const lane = new DnsheAccountRequestScheduler(inspect, "runtime-recover", () => now, async ms => {
        waits.push(ms); now += ms; if (mode === "cancel") controller.abort();
      });
      try {
        const lease = await lane.acquire(1000, controller.signal); lease.assertReady!(); await lease.release();
        return Response.json({ code: "ok", now, waits, claimType });
      } catch (error) {
        if (!(error instanceof ProviderApiError)) throw error;
        return Response.json({ code: error.error_code, now, waits, claimType }, { status: error.statusCode });
      }
    }
    if (path === "/fixture/dnshe-window") {
      let now = 59_990;
      const starts: number[] = [];
      for (let i = 0; i < 31; i++) {
        const lane = new DnsheAccountRequestScheduler(env.DB, "runtime-window", () => now, async ms => { now += ms; });
        const lease = await lane.acquire(1000);
        lease.assertReady!();
        starts.push(now);
        await lease.release();
      }
      return Response.json({ starts });
    }
    if (path === "/fixture/dnshe-isolation") {
      const a = new DnsheAccountRequestScheduler(env.DB, "runtime-a");
      const b = new DnsheAccountRequestScheduler(env.DB, "runtime-b");
      await a.block(60_000);
      let code = "";
      try { await a.acquire(1000); } catch (error) { if (!(error instanceof ProviderApiError)) throw error; code = error.error_code; }
      const lease = await b.acquire(1000);
      lease.assertReady!();
      await lease.release();
      return Response.json({ code, independent: true });
    }
    if (path === "/fixture/dnshe-serial-sync") {
      const mode = new URL(request.url).searchParams.get("mode");
      const clock = dnsheSyncClock(env.DB);
      db.getClientForAccount = async () => ({ client: clock.makeClient(), alias: "fixture", provider: "dnshe" });
      db.refreshAccountQuotaCache = async () => { await clock.makeClient().getQuota(); };
      await db.setAppSetting("auto_renew", "0");
      if (mode === "cron-always") await db.setAppSetting("dns_records_cache_mode", "always");
      await clock.makeClient().getQuota();
      const result = mode === "deep" ? { status: "completed", total: await deepSyncAccountDomains(db, 1, clock.makeClient()) }
        : mode === "auto" ? await resyncAccountsInBackground(db, [1], "auto")
        : await runDailySyncAndRenewal(db, undefined, "custom", true);
      return Response.json({ result, maxPending: clock.maxPending, waits: clock.waits });
    }
    if (path === "/fixture/coordination-deadline") {
      const mode = new URL(request.url).searchParams.get("mode")!;
      await env.DB.prepare("DELETE FROM cache WHERE key LIKE 'provider_scheduler:%' OR key LIKE 'dnshe_budget:%'").run();
      const gate = deferred();
      const late = deferred();
      const cleaned = deferred();
      let calls = 0;
      let now = 1000;
      const fault = coordinationFault(env.DB, async (sql, method, execute) => {
        const target = mode.startsWith("claim") ? sql.startsWith("INSERT")
          : mode.startsWith("release") ? method === "run"
          : mode === "budget-reserve" ? sql.startsWith("INSERT")
          : mode === "budget-block" ? method === "batch" : sql.includes("MAX(CAST(cache.value");
        if (target) {
          calls++;
          const result = mode === "claim-after" ? await execute() : undefined;
          try { await gate.promise; return mode === "claim-after" ? result : await execute(); }
          finally { late.resolve(); }
        }
        const result = await execute();
        if (mode.startsWith("claim") && method === "run") cleaned.resolve();
        return result;
      });
      const scheduler = new SharedProviderRequestScheduler(fault, "cloudflare", () => now, 40);
      let failure: ProviderApiError | undefined;
      try {
        if (mode.startsWith("budget")) {
          const budget = new DnsheRequestBudget(fault, "fixture-key", 2100, () => now, async () => {}, 40);
          await new DNSHEClient("fixture-key", "secret", budget).createDnsRecord({ subdomain_id: 101, type: "A", name: "www", content: "192.0.2.2" });
        } else await transportFixture("cloudflare", { scheduler, timeoutMs: 1000 }).write();
      } catch (error) {
        if (!(error instanceof ProviderApiError)) throw error;
        failure = error;
      }
      if (!failure) throw new Error("deadline fixture unexpectedly succeeded");
      const before = await env.DB.prepare("SELECT count(*) AS n FROM cache WHERE key LIKE '%:slot:%'").first<{ n: number }>();
      let replacement;
      if (mode.startsWith("release") || mode === "claim-after") {
        now = 7000;
        replacement = await new SharedProviderRequestScheduler(env.DB, "cloudflare", () => now).acquire(1000);
      }
      if (mode.endsWith("reject")) gate.reject(new Error("secret-late-sql"));
      else gate.resolve();
      await late.promise;
      if (mode === "claim-before" || mode === "claim-after") await cleaned.promise;
      // Consume delayed continuation inside this request, not via waitUntil.
      await new Promise(resolve => setTimeout(resolve, 5));
      const after = await env.DB.prepare("SELECT count(*) AS n FROM cache WHERE key LIKE '%:slot:%'").first<{ n: number }>();
      const blocked = await env.DB.prepare("SELECT count(*) AS n FROM cache WHERE key LIKE '%:blocked'").first<{ n: number }>();
      await replacement?.release();
      return Response.json({ code: failure.error_code, details: failure.details, calls, before: before?.n, after: after?.n, blocked: blocked?.n }, { status: failure.statusCode });
    }
    if (path === "/fixture/scheduler-claim" || path === "/fixture/scheduler-block") {
      const scheduler = new SharedProviderRequestScheduler(env.DB, "cloudflare");
      try {
        if (path === "/fixture/scheduler-block") await scheduler.block(Number(new URL(request.url).searchParams.get("ms")));
        else await scheduler.acquire(20_000); // Deliberately abandoned for cross-request coordination tests.
        return Response.json({ success: true });
      } catch (error) {
        if (!(error instanceof ProviderApiError)) throw error;
        return Response.json({ code: error.error_code, retryAfterMs: error.retryAfterMs }, { status: error.statusCode });
      }
    }
    if (path === "/fixture/scheduler-stale-release") {
      let now = 1000;
      const make = () => new SharedProviderRequestScheduler(env.DB, "cloudflare", () => now);
      const old = await make().acquire(1000);
      now = 7000;
      const fresh = await make().acquire(1000);
      await old.release();
      const retained = await env.DB.prepare("SELECT value FROM cache WHERE key='provider_scheduler:v1:cloudflare:slot:0'").first();
      await fresh.release();
      return Response.json({ retained: Boolean(retained) });
    }
    if (path === "/fixture/password") {
      const config = await db.getAuthConfig();
      return Response.json({ username: config.username, one: await db.verifyPassword("password-one"), two: await db.verifyPassword("password-two") });
    }
    if (path === "/fixture/sync") {
      const client = new CloudflareClient("offline-token");
      client.listZones = async ({ startPage = 1 } = {}) => {
        const zones = Array.from({ length: 151 }, (_, i) => zone(i + 1)).slice((startPage - 1) * 50, startPage * 50);
        return { zones, hasMore: zones.length === 50, nextPage: startPage + 1 };
      };
      return Response.json(await syncCloudflareZoneBatch(db, 1, client));
    }
    if (path === "/fixture/commit") {
      await db.acquireSyncLease("fixture-lock", "owner");
      try {
        await db.commitSyncPage(1, [mapZoneToUpstream(zone(1))], "fixture-lock", "owner", "fixture-cursor", "next-page", 120);
        return Response.json({ committed: true });
      } catch { return Response.json({ committed: false }, { status: 503 }); }
    }
    if (path === "/fixture/expired-lease") {
      await db.executeRaw("INSERT OR REPLACE INTO cache(key,value,expires_at) VALUES('fixture-lock','owner',1)");
      try {
        await db.commitSyncPage(1, [mapZoneToUpstream(zone(1))], "fixture-lock", "owner", "fixture-cursor", "bad", 120);
        return Response.json({ committed: true });
      } catch { return Response.json({ committed: false }, { status: 409 }); }
    }
    if (path === "/fixture/budget") {
      const waits: number[] = [];
      const make = () => new DnsheRequestBudget(env.DB, "shared-key", 2100, () => 1000, async ms => { waits.push(ms); });
      const one = make();
      const two = make();
      await one.reserve();
      await two.reserve();
      let capped = false;
      try { await one.reserve(); } catch { capped = true; }
      await one.block(60_000);
      let cooldown = false;
      try { await two.reserve(); } catch { cooldown = true; }
      return Response.json({ waits, capped, cooldown });
    }
    return new Response(null, { status: 404 });
  },
};
