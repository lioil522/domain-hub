import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(path.join(root, "package.json"));
const { Miniflare, convertV4MiniflareOptions, Response: MiniflareResponse } = require("miniflare");
const { build } = require("esbuild");
const key = "isolated-runtime-smoke-test-key";
const setupToken = "isolated-runtime-smoke-setup-token";
const request = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
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

const base = process.platform === "win32" && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Temp/opencode") : tmpdir();
await mkdir(base, { recursive: true });
// Only this isolated test wrapper exposes a tick endpoint, never the app bundle.
// Keep the module in memory: workerd rejects module paths that escape its
// starting directory, which is exactly what an absolute temp path can become.
const harnessOutput = await build({ stdin: { contents: `import worker from "./dist-worker/wrangler-dry-run/index.js";
  export default { async fetch(request, env, ctx) {
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
  compatibilityDate: date, d1Databases: ["DB"], bindings: { AES_KEY: key, SETUP_TOKEN: setupToken },
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
  console.log("[runtime-smoke] isolated workerd/D1 and Node/SQLite passed");
} finally {
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 10000);
  await exited; clearTimeout(force);
}
