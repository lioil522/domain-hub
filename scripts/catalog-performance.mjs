import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Session } from "node:inspector";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { loopbackFetch } from "../tests/helpers/loopback-fetch.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(path.join(root, "package.json"));
const { build } = require("esbuild"), { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const base = process.platform === "win32" && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp/opencode") : tmpdir();
await mkdir(base, { recursive: true });
const out = await mkdtemp(path.join(base, "domain-hub-catalog-performance-"));
const sizes = (process.env.PERF_SIZES || "1000,10000,50000").split(",").map(Number);
assert.ok(sizes.every(n => Number.isSafeInteger(n) && n >= 100 && n <= 100000));
const repeats = Number(process.env.PERF_REPEATS || 3);
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
const schema = await readFile(path.join(root, "schema.sql"), "utf8");
const config = await readFile(path.join(root, "wrangler.toml"), "utf8");
const compatibilityDate = config.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
assert.ok(compatibilityDate);
const entry = path.join(root, "scripts/performance/catalog-harness.ts");
const bundled = await build({ entryPoints: [entry], bundle: true, platform: "neutral", format: "esm", target: "es2022", write: false });
const workerBundle = await build({ stdin: { contents: 'export {default} from "./scripts/performance/catalog-harness";', resolveDir: root },
  bundle: true, platform: "neutral", format: "esm", target: "es2022", write: false });
await writeFile(path.join(out, "harness.mjs"), bundled.outputFiles[0].text);
const nodeEntry = await build({ stdin: { contents: 'export {createD1FromSqlite} from "./server/d1-sqlite";', resolveDir: root },
  bundle: true, platform: "node", format: "esm", target: "node22", write: false });
await writeFile(path.join(out, "adapter.mjs"), nodeEntry.outputFiles[0].text);
const { run } = await import(pathToFileURL(path.join(out, "harness.mjs")).href);
const { createD1FromSqlite } = await import(pathToFileURL(path.join(out, "adapter.mjs")).href);

function fixture(n) {
  return `
    INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES
    (1,'fixture DNSHE','fake-1','fake','dnshe'),(2,'fixture CF','fake-2','fake','cloudflare'),
    (3,'fixture DP','fake-3','fake','digitalplat'),(4,'fixture DNSPod','fake-4','fake','dnspod'),
    (5,'fixture Ali','fake-5','fake','alidns'),(6,'fixture HW','fake-6','fake','huaweicloud'),
    (7,'fixture Vercel','fake-7','fake','vercel'),(8,'fixture custom','fake-8','fake','custom');
    WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<${n})
    INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at,created_at,has_dns,updated_at)
    SELECT i,1+(i%7),'','example.net',
      CASE WHEN i%100=0 THEN 'xn--0zwm56d-'||i||'.example.net' WHEN i%100=1 THEN '测试-'||i||'.example.net'
        ELSE 'item-'||(CASE WHEN i%20=0 THEN i-1 ELSE i END)||'.example.net' END,
      CASE WHEN i%31=0 THEN '已过期' ELSE '已解析' END,
      CASE WHEN i%11=0 THEN '0000-00-00' ELSE strftime('%Y-%m-%dT12:00:00Z','2026-11-23',(i%450-20)||' days') END,
      strftime('%Y-%m-%dT00:00:00Z','2026-11-23',(-i%365)||' days'),i%2,'2026-11-23T00:00:00Z' FROM seq;
    WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<${Math.floor(n / 8)})
    INSERT INTO custom_domains(id,group_id,full_domain,expires_at)
    SELECT i,8,'item-'||(i*8)||'.example.net','2027-03-01' FROM seq;
    INSERT INTO cache(key,value,expires_at)
    SELECT 'api_cache:dns:'||id,json_array(json_object('id',id,'type','TXT','name','_verify',
      'content',CASE WHEN id=${n - n % 10} THEN 'cache-token-last' ELSE 'cache-value-'||id END)),2000000000
    FROM domains_cache WHERE id%10=0;
    INSERT INTO domain_date_overrides(account_id,full_domain,expires_at,updated_at)
    SELECT account_id,full_domain,'2027-04-01','2026-11-23T00:00:00Z' FROM domains_cache WHERE id%97=0;
    INSERT INTO settings(key,value) VALUES('catalog_summary_revision','isolated-perf-fixture');
  `;
}
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function profileStats(profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame.functionName || "(anonymous)"]));
  const totals = new Map(); let sampledActiveUs = 0;
  for (let i = 0; i < (profile.samples || []).length; i++) {
    const name = nodes.get(profile.samples[i]), us = profile.timeDeltas?.[i] || 0;
    totals.set(name, (totals.get(name) || 0) + us);
    if (!["(idle)", "(program)", "(root)"].includes(name)) sampledActiveUs += us;
  }
  return { sampledActiveMs: sampledActiveUs / 1000, windowMs: (profile.endTime - profile.startTime) / 1000,
    top: [...totals].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([frame, us]) => ({ frame, ms: us / 1000 })) };
}
function allocationStats(profile) {
  const frames = new Map(); let sampledBytes = 0;
  const visit = node => {
    const bytes = node.selfSize || 0, name = node.callFrame.functionName || "(anonymous)";
    sampledBytes += bytes; frames.set(name, (frames.get(name) || 0) + bytes);
    for (const child of node.children || []) visit(child);
  };
  visit(profile.head);
  return { sampledAllocatedBytes: sampledBytes,
    allocationTop: [...frames].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([frame, bytes]) => ({ frame, bytes })) };
}
async function connect(url) {
  assert.equal(new URL(url).hostname, "127.0.0.1", "Inspector must be our literal loopback target");
  const ws = new WebSocket(url), pending = new Map(); let id = 0;
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data), item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
  });
  return {
    post(method, params = {}) {
      return new Promise((resolve, reject) => {
        const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error(`Inspector timeout: ${method}`)); }, 30000);
        pending.set(next, { resolve, reject, timer }); ws.send(JSON.stringify({ id: next, method, params }));
      });
    },
    close() { ws.close(); },
  };
}
const scenarios = ["cold", "warm", "force", "ascii-sparse", "ascii-wide", "unicode", "dns-sparse", "dns-wide", "all", "page", "legacy"];
const selectedScenarios = process.env.PERF_SCENARIOS ? process.env.PERF_SCENARIOS.split(",") : scenarios;
assert.ok(selectedScenarios.length && selectedScenarios.every(item => scenarios.includes(item)));
const allocations = process.env.PERF_ALLOCATIONS === "1";
const report = { node: process.version, platform: process.platform, compatibilityDate, sizes, repeats,
  scenarios: selectedScenarios, allocations,
  sourceDigest: digest(bundled.outputFiles[0].text),
  disclaimer: "Isolated service harness, not auth/API E2E or production billed CPU. Returned rows are not D1 rows_read. Heap is before/after, not peak; Node includes this orchestrator. Timings are unprofiled; CPU/allocation profiles are separate invocations. Sampled allocations include collected objects, not peak or retained heap. Sampled active excludes idle/program/root but timeDeltas can include waits attributed to frames; it is NOT a CPU-time estimator.", runs: [] };
console.log(`PERF_OUTPUT=${out}`);
const hashes = new Map();
for (const n of sizes) {
  for (const runtime of ["node", "workerd"]) {
    let mf, sqlite, db, inspector;
    try {
      if (runtime === "node") {
        sqlite = new DatabaseSync(":memory:"); sqlite.exec(schema); sqlite.exec(fixture(n)); db = createD1FromSqlite(sqlite);
        const session = new Session(); session.connect();
        inspector = { post: (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result))),
          close: () => session.disconnect() };
      } else {
        mf = new Miniflare(convertV4MiniflareOptions({ name: "catalog-perf", modules: true, script: workerBundle.outputFiles[0].text,
          compatibilityDate, inspectorPort: 0, d1Databases: ["DB"],
          outboundService() { throw new Error("Benchmark must never contact upstream"); } }));
        db = await mf.getD1Database("DB");
        // D1 exec parses newline-delimited statements, not arbitrary SQL files.
        for (const source of [schema, fixture(n)]) {
          const statements = source.replace(/^\s*--[^\r\n]*/gm, "").split(";").map(sql => sql.trim()).filter(Boolean);
          for (let i = 0; i < statements.length; i += 40) await db.batch(statements.slice(i, i + 40).map(sql => db.prepare(sql)));
        }
        // Initialize the module before opening its inspector.
        await mf.dispatchFetch("http://localhost/ascii-sparse");
        const url = await mf.getInspectorURL(), listing = new URL("/json/list", url); listing.protocol = "http:";
        const targets = await (await loopbackFetch(listing)).json();
        const target = targets.find(item => item.id === "core:user:catalog-perf");
        assert.ok(target, "Our exact workerd target was not found"); inspector = await connect(target.webSocketDebuggerUrl);
      }
      await inspector.post("Profiler.enable"); await inspector.post("Profiler.setSamplingInterval", { interval: 100 });
      for (const scenario of selectedScenarios) {
        // Warm JIT on the same code path before measured repeated runs. Cold
        // refers to the persisted summary cache, NOT module compilation.
        const invoke = async () => runtime === "node" ? run(db, scenario) : (await mf.dispatchFetch(`http://localhost/${scenario}`)).json();
        await invoke();
        for (let repeat = 0; repeat < repeats; repeat++) {
          if (scenario === "cold") await db.prepare("DELETE FROM cache WHERE key LIKE 'catalog_summary:%'").run();
          const before = await inspector.post("Runtime.getHeapUsage");
          const cpu = process.cpuUsage(), started = performance.now();
          const result = await invoke(), wallMs = performance.now() - started;
          const nodeCpu = process.cpuUsage(cpu);
          const after = await inspector.post("Runtime.getHeapUsage");
          let profile, allocationProfile;
          if (runtime === "workerd") {
            if (scenario === "cold") await db.prepare("DELETE FROM cache WHERE key LIKE 'catalog_summary:%'").run();
            await inspector.post("Profiler.start");
            await invoke();
            ({ profile } = await inspector.post("Profiler.stop"));
          }
          if (allocations) {
            if (scenario === "cold") await db.prepare("DELETE FROM cache WHERE key LIKE 'catalog_summary:%'").run();
            await inspector.post("HeapProfiler.startSampling", { samplingInterval: 32768,
              includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
            await invoke();
            ({ profile: allocationProfile } = await inspector.post("HeapProfiler.stopSampling"));
          }
          const hash = digest(result.result), key = `${n}:${scenario}`;
          if (hashes.has(key)) assert.equal(hash, hashes.get(key), `Runtime/repeat semantic mismatch: ${key}`);
          else hashes.set(key, hash);
          const record = { n, runtime, scenario, repeat, wallMs,
            ...(runtime === "node" ? { processCpuMs: (nodeCpu.user + nodeCpu.system) / 1000 } : {}),
            returnedRows: result.sql.reduce((sum, item) => sum + item.returned, 0), queries: result.sql.length,
            hash, heapBefore: before.usedSize, heapAfter: after.usedSize, ...(profile ? profileStats(profile) : {}),
            ...(allocationProfile ? allocationStats(allocationProfile) : {}) };
          report.runs.push(record);
          if (profile) await writeFile(path.join(out, `${n}-${runtime}-${scenario}-${repeat}.cpuprofile`), JSON.stringify(profile));
          if (allocationProfile) await writeFile(path.join(out, `${n}-${runtime}-${scenario}-${repeat}.heapprofile`), JSON.stringify(allocationProfile));
          console.log(JSON.stringify(record));
        }
      }
    } finally { inspector?.close(); if (mf) await mf.dispose(); sqlite?.close(); }
  }
}
await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
if (process.env.PERF_COMPARE) {
  const baseline = JSON.parse(await readFile(process.env.PERF_COMPARE, "utf8"));
  assert.equal(report.node, baseline.node);
  assert.equal(report.platform, baseline.platform);
  assert.equal(report.compatibilityDate, baseline.compatibilityDate);
  for (const record of report.runs) {
    const before = baseline.runs.find(item => item.n === record.n && item.runtime === record.runtime &&
      item.scenario === record.scenario && item.repeat === record.repeat);
    assert.ok(before, "Matching baseline run missing");
    assert.equal(record.hash, before.hash, `Changed result: ${record.n}/${record.runtime}/${record.scenario}`);
  }
  console.log(`BASELINE_SEMANTIC_MATCHES=${report.runs.length}/${report.runs.length}`);
}
console.log(`PERF_REPORT=${path.join(out, "report.json")}`);
