import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loopbackFetch } from "../tests/helpers/loopback-fetch.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(path.join(root, "package.json"));
const { Miniflare, convertV4MiniflareOptions, Response: MiniflareResponse } = require("miniflare");
const { build } = require("esbuild");
const key = "isolated-runtime-smoke-test-key";
const setupToken = "isolated-runtime-smoke-setup-token";
const request = (url, init = {}) => loopbackFetch(url, { ...init, signal: AbortSignal.timeout(15000) });
async function authentication(fetcher) {
  assert.equal((await fetcher("/api/accounts")).status, 401);
  assert.equal((await fetcher("/api/auth/status", { headers: { Origin: "https://untrusted-smoke.invalid" } })).status, 403);
  const denied = await fetcher("/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "runtime-smoke", password: "isolated-runtime-password" }) });
  assert.equal(denied.status, 401);
  const setup = await fetcher("/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${setupToken}` },
    body: JSON.stringify({ username: "runtime-smoke", password: "isolated-runtime-password" }) });
  assert.equal(setup.status, 200, await setup.clone().text());
  const token = (await setup.json()).session_token;
  assert.ok(token);
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetcher("/api/accounts", { headers })).status, 200);
  const domains = await fetcher("/api/domains", { headers });
  assert.equal(domains.status, 200);
  assert.deepEqual((await domains.json()).domains, []);
  assert.equal((await fetcher("/api/notifications", { headers })).status, 200);
  return headers;
}
async function summaryCacheSmoke(fetcher, headers) {
  const endpoint = "/api/domains/summary?timezone_offset=0";
  const cold = await fetcher(endpoint, { headers });
  assert.equal(cold.status, 200, await cold.clone().text());
  assert.equal(cold.headers.get("X-Catalog-Summary-Cache"), "miss");
  const before = (await cold.json()).summary;
  const hot = await fetcher(endpoint, { headers });
  assert.equal(hot.status, 200);
  assert.equal(hot.headers.get("X-Catalog-Summary-Cache"), "hit");
  assert.equal(hot.headers.get("Cache-Control"), "private, no-store");
  const group = await fetcher("/api/custom-groups/batch", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ groups: [{ alias: "summary-cache-runtime" }] }),
  });
  assert.equal(group.status, 200, await group.clone().text());
  const accountList = await (await fetcher("/api/accounts", { headers })).json();
  const id = accountList.accounts.find(account => account.alias === "summary-cache-runtime").id;
  const domain = await fetcher(`/api/custom-groups/${id}/domains`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ full_domain: "summary-cache-runtime.example.com", expires_at: "" }),
  });
  assert.equal(domain.status, 200, await domain.clone().text());
  const changed = await fetcher(endpoint, { headers });
  assert.equal(changed.status, 200, await changed.clone().text());
  assert.equal(changed.headers.get("X-Catalog-Summary-Cache"), "miss");
  const after = (await changed.json()).summary;
  assert.equal(after.stats.total, before.stats.total + 1);
  assert.equal(after.stats.accounts, before.stats.accounts + 1);
  const forced = await fetcher(`${endpoint}&refresh=1`, { headers });
  assert.equal(forced.status, 200, await forced.clone().text());
  assert.equal(forced.headers.get("X-Catalog-Summary-Cache"), "bypass");
  console.log("[runtime-smoke] summary cache hit, transactional invalidation and explicit bypass passed");
}
async function cachedDnsSearchSmoke(fetcher, headers, run) {
  const id = 900001, keyword = "runtime-cache-token-only";
  await run("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(900001,'search runtime','isolated-search','plain:c2VjcmV0','cloudflare')");
  await run(`INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at)
    VALUES(900001,900001,'','example.net','search-runtime.example.net','已解析','2035-01-01')`);
  await run("INSERT INTO cache(key,value,expires_at) VALUES(?,?,?)",
    [`api_cache:dns:${id}`, JSON.stringify([{ id: "search-record", type: "TXT", name: "_verify", content: keyword }]), Math.floor(Date.now() / 1000) + 3600]);
  const endpoint = `/api/domains/search?search=${keyword}&search_in=all`;
  const result = await fetcher(endpoint, { headers });
  assert.equal(result.status, 200, await result.clone().text());
  const group = (await result.json()).result.groups.cloudflare;
  assert.equal(group.total, 1);
  assert.equal(group.items[0].id, id);
  assert.equal(group.items[0].dns_match.preview, keyword);
  const legacy = await fetcher(`/api/search?q=${keyword}`, { headers });
  assert.equal(legacy.status, 200, await legacy.clone().text());
  const hit = (await legacy.json()).results.find(row => row.type === "dns");
  assert.equal(hit.metadata.domainId, id);
  assert.equal(hit.provider, "cloudflare");
  const page = await fetcher(`/api/domains/page?provider=cloudflare&search_in=dns&search=${keyword}&limit=1`, { headers });
  assert.equal(page.status, 200, await page.clone().text());
  assert.equal((await page.json()).domains[0].id, id);
  await run("UPDATE cache SET value=? WHERE key=?", [
    JSON.stringify([{ id: "search-record", type: "TXT", name: "_verify", content: "runtime-cache-new-value" }]), `api_cache:dns:${id}`,
  ]);
  assert.equal((await (await fetcher(endpoint, { headers })).json()).result.groups.cloudflare.total, 0);
  console.log("[runtime-smoke] cached DNS-only content search, source routing, paging and changed-cache reads passed");
}

const base = process.platform === "win32" && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Temp/opencode") : tmpdir();
await mkdir(base, { recursive: true });
// Only this isolated wrapper exposes tick/stats test paths, never the app bundle.
// Keep the module in memory: workerd rejects module paths that escape its
// starting directory, which is exactly what an absolute temp path can become.
const harnessOutput = await build({ stdin: { contents: `import worker from "./dist-worker/wrangler-dry-run/index.js";
  import {computeDashboardStats} from "./shared/dashboard-stats";
  import {semanticFixture,selectionFixture} from "./tests/helpers/catalog-semantic-fixture";
  import {normalizeDomainKey} from "./shared/domain-keys";
  import {CatalogProjectionPrototype} from "./tests/prototypes/catalog-projection";
  import {measureCapture,installCapture,seedCaptureFixture,claimDirty,ackDirty} from "./tests/prototypes/catalog-write-capture";
  import {captureProjectionInput} from "./tests/prototypes/catalog-projection-capture";
  import {DatabaseManager} from "./src/db";
  import {DomainCatalogRepository} from "./src/repositories/domain-catalog-repository";
  import {DomainCatalogService} from "./src/services/domain-catalog-service";
  import {seedSnapshotFixture} from "./tests/helpers/snapshot-write-fixture";
  import {exercisePageCheckpoint} from "./tests/helpers/queued-cf-page-smoke";
  function validateRecent(input,recent) {
    const first=new Map();
    const sources=[
      [input.domains,"DNSHE"],[input.cfZones,"Cloudflare"],[input.dpDomains,"DigitalPlat"],
      [input.multiProviderDomains.dnspod,"DNSPod"],[input.multiProviderDomains.alidns,"阿里云 DNS"],
      [input.multiProviderDomains.huaweicloud,"华为云 DNS"],[input.multiProviderDomains.vercel,"Vercel"]
    ];
    for(const [rows,source] of sources) for(const row of rows) {
      const key=normalizeDomainKey(row.full_domain);
      if(key&&row.created_at&&!first.has(key))
        first.set(key,{full_domain:row.full_domain,created_at:row.created_at,source,alias:row.account_alias});
    }
    if(recent.length!==Math.min(6,first.size)) throw new Error("Recent registration candidate count changed");
    const seen=new Set();
    for(const row of recent) {
      const key=normalizeDomainKey(row.full_domain);
      if(seen.has(key)||JSON.stringify(row)!==JSON.stringify(first.get(key)))
        throw new Error("Recent registration lost its first source or produced an invalid candidate");
      seen.add(key);
    }
  }
  async function statsDigest(fixture,seeds,omitRecent=false) {
    const parts=[];
    for(let seed=1;seed<=seeds;seed++) for(const offset of [-480,0,330]) {
      const input=fixture(seed),result=computeDashboardStats(input,Date.parse("2026-11-23T00:00:00Z"),20,offset);
      validateRecent(input,result.recent);
      const {recent,...stable}=result;
      parts.push(JSON.stringify(omitRecent?stable:result));
    }
    const bytes=new TextEncoder().encode(parts.join(""));
    const digest=await crypto.subtle.digest("SHA-256",bytes);
    return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,"0")).join("");
  }
  export default { async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/__test_page_checkpoint") {
      return Response.json(await exercisePageCheckpoint(env.SNAPSHOT_DB));
    }
    if (new URL(request.url).pathname === "/__test_snapshot_write") {
      const manager=new DatabaseManager(env.SNAPSHOT_DB);
      if (!await manager.ensureTables()) throw new Error("Snapshot fixture unavailable");
      await seedSnapshotFixture(env.SNAPSHOT_DB,100);
      await manager.executeRaw("UPDATE sync_rows SET payload=json_set(payload,'$.expires_at','2028-01-01') WHERE domain_id=1");
      const queue=manager.syncQueue(), work=(await queue.jobs("test"))[0];
      await queue.writeDomains(work,{phase:"renew",total:100});
      const result=await manager.firstRaw("SELECT COUNT(*) n,SUM(updated_at='2000-01-01 00:00:00') stale,SUM(expires_at='2028-01-01') changed FROM domains_cache");
      return Response.json({...result,phase:JSON.parse((await queue.jobs("test"))[0].cursor).phase});
    }
    if (new URL(request.url).pathname === "/__test_capture") {
      if (!await new DatabaseManager(env.CAPTURE_DB).ensureTables()) throw new Error("Capture fixture schema unavailable");
      return Response.json(await measureCapture(env.CAPTURE_DB,100,true));
    }
    if (new URL(request.url).pathname === "/__test_dirty") {
      const db=env.DIRTY_DB;
      if (!await new DatabaseManager(db).ensureTables()) throw new Error("Dirty fixture schema unavailable");
      await seedCaptureFixture(db,10);
      await installCapture(db,"dirty");
      const update=date=>db.prepare("UPDATE domains_cache SET expires_at=? WHERE id=1").bind(date).run();
      await update("2027-02-01");
      const [a,b]=await Promise.all([claimDirty(db,0),claimDirty(db,0)]);
      const first=a.keys.length?a:b;
      await update("2027-03-01");
      const second=await claimDirty(db,1);
      const stale=await ackDirty(db,1,first), accepted=await ackDirty(db,1,second);
      return Response.json({first:a.keys.length+b.keys.length,stale:stale.removed,accepted:accepted.removed});
    }
    if (new URL(request.url).pathname === "/__test_projection") {
      const now=Date.parse("2026-11-24T00:00:00Z");
      const manager=new DatabaseManager(env.DB),captured=await captureProjectionInput(manager,now);
      const reference=(await new DomainCatalogService(new DomainCatalogRepository(manager)).summary(now,0)).stats;
      const staged=await new CatalogProjectionPrototype(env.DB).stage(captured.input,{
        validatedAt:now,offset:0,revision:captured.revision,sourceValidUntil:captured.sourceValidUntil
      });
      const result=await new CatalogProjectionPrototype(env.DB).read(staged.generation,now,0);
      if(JSON.stringify(result.stats)!==JSON.stringify(reference)) throw new Error("Real D1 projection stats differ");
      let cases=0;
      for(const seed of [1,3,18]) for(const offset of [-480,0,330]) {
        const input=selectionFixture(seed),projection=new CatalogProjectionPrototype(env.DB);
        const manifest=await projection.stage(input,{validatedAt:now,offset});
        const actual=await projection.read(manifest.generation,now,offset);
        const expected=computeDashboardStats(input,now,20,offset);
        validateRecent(input,actual.stats.recent);
        const {recent:a,...astable}=actual.stats,{recent:b,...bstable}=expected;
        if(JSON.stringify(astable)!==JSON.stringify(bstable)) throw new Error("D1 projection corpus counts/order differ");
        if(actual.recentMode==="sql-top-six"&&JSON.stringify(a)!==JSON.stringify(b)) throw new Error("D1 finite recent selection differs");
        const fold=new CatalogProjectionPrototype(env.DB,"folded");
        const built=await fold.stage(input,{validatedAt:now,offset});
        const later=now+120001,merged=await fold.read(built.generation,later,offset);
        validateRecent(input,merged.stats.recent);
        const {recent:mr,...ms}=merged.stats,{recent:er,...es}=computeDashboardStats(input,later,20,offset);
        if(JSON.stringify(ms)!==JSON.stringify(es)||(merged.recentMode==="sql-top-six"&&JSON.stringify(mr)!==JSON.stringify(er)))
          throw new Error("D1 folded projection/time comparison differs");
        cases++;
      }
      return Response.json({equivalent:true,cases,rows:result.metrics.returnedRows});
    }
    if (new URL(request.url).pathname === "/__test_stats") {
      const input=semanticFixture(1);
      input.domains=Array.from({length:10},(_,i)=>({full_domain:"invalid-"+i+".example",expires_at:"0000-00-00",
        created_at:"invalid",account_alias:"first-owner"}));
      input.cfZones=[{...input.domains[0],created_at:"2026-11-22",account_alias:"later-owner"}];
      input.dpDomains=[];input.customDomains=[];input.cfExpiryMap={};
      input.multiProviderDomains={dnspod:[],alidns:[],huaweicloud:[],vercel:[]};
      const invalidRecent=computeDashboardStats(input,Date.parse("2026-11-23T00:00:00Z"),20,0).recent;
      return Response.json({smallStable:await statsDigest(semanticFixture,100,true),
        large:await statsDigest(selectionFixture,30),invalidRecent});
    }
    if (new URL(request.url).pathname === "/__test_tick") {
      const pending = [];
      await worker.scheduled({cron:"* * * * *"}, env, {waitUntil(job){pending.push(job)}});
      await Promise.all(pending);
      return new Response("tick complete");
    }
    return worker.fetch(request,env,ctx);
  }};`, resolveDir: root }, bundle: true, platform: "neutral", target: "es2022", format: "esm",
  write: false });
const harnessScript = harnessOutput.outputFiles[0].text;
assert.ok(harnessScript && !/^\s*(import|export)\b.*\bfrom\s+["']\./m.test(harnessScript),
  "Inline workerd harness must be a self-contained module");
const config = await readFile(path.join(root, "wrangler.toml"), "utf8");
const date = config.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
assert.ok(date, "Runtime smoke must use the configured compatibility date");
let workerDeliveries = 0;
let mockError = "";
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: harnessScript,
  compatibilityDate: date, d1Databases: ["DB", "CAPTURE_DB", "DIRTY_DB", "SNAPSHOT_DB"], bindings: { AES_KEY: key, SETUP_TOKEN: setupToken },
  outboundService: async request => {
    try {
      assert.equal(new URL(request.url).hostname, "notification-smoke.invalid", "Runtime smoke must never contact a real provider");
      assert.match(request.headers.get("Idempotency-Key") || "", /^[a-f0-9]{64}$/);
      assert.ok((await request.json()).text.includes("域名到期提醒"));
      workerDeliveries++;
      return new MiniflareResponse("OK");
    } catch (error) { mockError = error.message; throw error; }
  },
}));
try {
  const fetcher = (url, init) => mf.dispatchFetch(`http://localhost${url}`, init);
  const headers = await authentication(fetcher);
  assert.equal((await fetcher("/api/settings", { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ webhook_url: "https://notification-smoke.invalid/hook", webhook_type: "custom" }) })).status, 200);
  const sqlite = await mf.getD1Database("DB");
  await sqlite.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'runtime','isolated','legacy','custom')").run();
  await sqlite.prepare("INSERT INTO custom_domains(group_id,full_domain,expires_at) VALUES(1,'isolated.example.com',?)")
    .bind(new Date(Date.now() + 86400000).toISOString()).run();
  assert.equal((await fetcher("/__test_tick")).status, 200);
  assert.equal((await fetcher("/__test_tick")).status, 200);
  const deliveries = await (await fetcher("/api/notifications", { headers })).json();
  assert.equal(deliveries.notifications.length, 1);
  assert.equal(deliveries.notifications[0].status, "sent", JSON.stringify({ deliveries, workerDeliveries, mockError }));
  assert.equal(workerDeliveries, 1);
  assert.equal((await fetcher("/__test_tick")).status, 200);
  assert.equal(workerDeliveries, 1, "Confirmed delivery cannot be repeated on another tick");
  console.log("[runtime-smoke] workerd expiry/outbox production, delivery and dedupe passed");
  // Isolated legacy-v5 fixture only: production never exposes these test writes.
  // Force the actual workerd/D1 migration path with an existing conflicting row.
  await sqlite.prepare("DROP INDEX idx_custom_domains_unassigned_unique").run();
  await sqlite.prepare("DELETE FROM domain_hub_schema_migrations WHERE version=6").run();
  await sqlite.prepare("ALTER TABLE custom_domains ADD COLUMN runtime_blob BLOB").run();
  await sqlite.prepare("ALTER TABLE custom_domains ADD COLUMN runtime_real REAL").run();
  await sqlite.prepare("INSERT INTO custom_domains(group_id,full_domain,expires_at,remark,runtime_blob,runtime_real) VALUES(1,'isolated.example.com','2035-01-01','runtime archived original',x'00ff',1.2345678901234567)").run();
  assert.equal((await fetcher("/api/auth/status")).status, 200);
  assert.equal((await sqlite.prepare("SELECT COUNT(*) n FROM custom_domains WHERE group_id=1 AND full_domain='isolated.example.com'").first()).n, 1);
  const archived = await fetcher("/api/custom-groups/domain-conflicts", { headers });
  assert.equal(archived.status, 200);
  const original = (await archived.json()).archives[0].payload.columns;
  assert.equal(original.remark.value, "runtime archived original");
  assert.equal(original.expires_at.value, "2035-01-01");
  assert.deepEqual(original.runtime_blob, { storage: "blob", value: "00FF" });
  assert.equal(Number(original.runtime_real.value), 1.2345678901234567);
  console.log("[runtime-smoke] workerd/D1 v5 duplicate archive and unique migration passed");
  await summaryCacheSmoke(fetcher, headers);
  await cachedDnsSearchSmoke(fetcher, headers, (sql, args = []) => sqlite.prepare(sql).bind(...args).run());
  assert.equal(workerDeliveries, 1, "Search must not cause an upstream delivery or provider request");
  const statsCorpus = await fetcher("/__test_stats");
  assert.equal(statsCorpus.status, 200, await statsCorpus.clone().text());
  assert.deepEqual(await statsCorpus.json(), {
    smallStable: "410783978ba809c5cb0a38e52db555675df46f13a0f091b336eea2392533853b",
    large: "fbb2dcbb88d3a928e6a33980b952ed1b9a3efd0c141e9edede8954feceef4167",
    invalidRecent: Array.from({ length: 6 }, (_, i) => ({ full_domain: `invalid-${i}.example`,
      created_at: "invalid", source: "DNSHE", alias: "first-owner" })),
  });
  console.log("[runtime-smoke] workerd 390-case stats digests, legacy NaN comparator, first sources and candidate validity passed");
  const projection = await fetcher("/__test_projection");
  assert.equal(projection.status, 200, await projection.clone().text());
  const projectionBody = await projection.json();
  assert.equal(projectionBody.equivalent, true);
  assert.equal(projectionBody.cases, 9);
  assert.equal(projectionBody.rows, 4);
  console.log("[runtime-smoke] isolated workerd/D1 JSON and folded projection, real repository capture and 9 offset/source cases passed");
  const capture = await fetcher("/__test_capture");
  assert.equal(capture.status, 200, await capture.clone().text());
  const costs = await capture.json();
  assert.equal(costs.syncReplay.events, 30);
  assert.equal(costs.syncReplay.changes, 20);
  assert.equal(costs.repeatReplay.events, 0);
  assert.equal(costs.dateReplay.events, 1);
  assert.equal(costs.cascadeReplay.events, 102);
  assert.equal(costs.cascadeReplay.changes, 100);
  console.log("[runtime-smoke] isolated workerd/D1 change journal and dependency write accounting passed");
  const dirty = await fetcher("/__test_dirty");
  assert.equal(dirty.status, 200, await dirty.clone().text());
  assert.deepEqual(await dirty.json(), { first: 2, stale: 0, accepted: 2 });
  console.log("[runtime-smoke] isolated workerd/D1 dirty-key claim and re-dirty fence passed");
  const snapshotWrite = await fetcher("/__test_snapshot_write");
  assert.equal(snapshotWrite.status, 200, await snapshotWrite.clone().text());
  assert.deepEqual(await snapshotWrite.json(), { n: 100, stale: 0, changed: 1, phase: "renew" });
  console.log("[runtime-smoke] workerd/D1 snapshot payload, observation times and atomic checkpoint passed");
  const queuePage = await fetcher("/__test_page_checkpoint");
  assert.equal(queuePage.status, 200, await queuePage.clone().text());
  assert.deepEqual(await queuePage.json(), { phase: "done", total: 1, page: 3 });
  console.log("[runtime-smoke] workerd/D1 CF page, outer job cursor, rollback and retry passed");
}
finally { await mf.dispose(); }

const data = await mkdtemp(path.join(base, "domain-hub-runtime-smoke-"));
const env = { ...process.env, DATA_DIR: data, AES_KEY: key, SETUP_TOKEN: setupToken, HOST: "127.0.0.1", PORT: "0",
  STATIC_DIR: path.join(root, "frontend/dist"), DISABLE_CRON: "1" };
for (const name of ["DB_PATH", "SCHEMA_FILE", "DEFAULT_API_KEY", "DEFAULT_API_SECRET", "DEFAULT_API_ALIAS",
  "ADMIN_TOKEN", "WEBHOOK_URL", "WEBHOOK_TYPE", "ALLOWED_ORIGIN", "TRUSTED_PROXIES", "PUBLIC_ORIGIN"]) delete env[name];
const child = spawn(process.execPath, [path.join(root, "dist-node/server.mjs")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
const exited = new Promise(resolve => child.on("exit", code => resolve(code)));
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Node runtime startup timed out: ${output}`)), 15000);
  child.on("error", error => { clearTimeout(timer); reject(error); });
  child.on("exit", code => { clearTimeout(timer); reject(new Error(`Early Node exit ${code}: ${output}`)); });
  child.stdout.on("data", bytes => {
    output = (output + bytes).slice(-65536);
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) { clearTimeout(timer); resolve(Number(match[1])); }
  });
  child.stderr.on("data", bytes => { output = (output + bytes).slice(-65536); });
});
try {
  const port = await ready, url = `http://127.0.0.1:${port}`;
  assert.equal((await request(`${url}/healthz`)).status, 200);
  assert.equal((await request(`${url}/`)).status, 200);
  const fetcher = (pathname, init) => request(`${url}${pathname}`, init);
  const headers = await authentication(fetcher);
  await summaryCacheSmoke(fetcher, headers);
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(path.join(data, "domain-hub.db"));
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000");
    await cachedDnsSearchSmoke(fetcher, headers, async (sql, args = []) => sqlite.prepare(sql).run(...args));
  } finally { sqlite.close(); }
  console.log("[runtime-smoke] isolated workerd/D1 and Node/SQLite passed");
} finally {
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 10000);
  await exited; clearTimeout(force);
}
