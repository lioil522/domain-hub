import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(path.join(root, "package.json"));
const { build } = require("esbuild"), { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const base = process.platform === "win32" && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp/opencode") : tmpdir();
await mkdir(base, { recursive: true });
const out = await mkdtemp(path.join(base, "domain-hub-projection-performance-"));
const sizes = (process.env.PERF_SIZES || "1000,10000,50000").split(",").map(Number);
const repeats = Number(process.env.PERF_REPEATS || 3);
assert.ok(sizes.every(n => Number.isSafeInteger(n) && n >= 100 && n + Math.floor(n / 8) <= 100000));
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
const schema = await readFile(path.join(root, "schema.sql"), "utf8"), config = await readFile(path.join(root, "wrangler.toml"), "utf8");
const compatibilityDate = config.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
assert.ok(compatibilityDate);
const module = await build({ entryPoints: [path.join(root, "scripts/performance/projection-harness.ts")],
  bundle: true, platform: "neutral", target: "es2022", format: "esm", write: false });
const worker = await build({ stdin: { contents: 'export {default} from "./scripts/performance/projection-harness";', resolveDir: root },
  bundle: true, platform: "neutral", target: "es2022", format: "esm", write: false });
const adapter = await build({ stdin: { contents: 'export {createD1FromSqlite} from "./server/d1-sqlite";', resolveDir: root },
  bundle: true, platform: "node", target: "node22", format: "esm", write: false });
await writeFile(path.join(out, "harness.mjs"), module.outputFiles[0].text);
await writeFile(path.join(out, "adapter.mjs"), adapter.outputFiles[0].text);
const { run } = await import(pathToFileURL(path.join(out, "harness.mjs")).href);
const { createD1FromSqlite } = await import(pathToFileURL(path.join(out, "adapter.mjs")).href);
function fixture(n) {
  return `
    INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES
      (1,'fixture DNSHE','fake-1','fake','dnshe'),(2,'fixture CF','fake-2','fake','cloudflare'),
      (3,'fixture DP','fake-3','fake','digitalplat'),(4,'fixture DNSPod','fake-4','fake','dnspod'),
      (5,'fixture Ali','fake-5','fake','alidns'),(6,'fixture HW','fake-6','fake','huaweicloud'),
      (7,'fixture Vercel','fake-7','fake','vercel'),(8,'fixture manual','fake-8','fake','custom');
    WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<${n})
    INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at,created_at,has_dns)
    SELECT i,1+i%7,'','example.net',
      CASE WHEN i%100=0 THEN 'xn--0zwm56d-'||i||'.example.net' WHEN i%100=1 THEN '测试-'||i||'.example.net'
      ELSE 'item-'||(CASE WHEN i%20=0 THEN i-1 ELSE i END)||'.example.net' END,
      CASE WHEN i%31=0 THEN '已过期' ELSE '已解析' END,
      CASE WHEN i%11=0 THEN '0000-00-00' ELSE strftime('%Y-%m-%dT12:00:00Z','2026-11-24',(i%450-20)||' days') END,
      strftime('%Y-%m-%dT00:00:00Z','2026-11-24',(-i%365)||' days'),i%2 FROM seq;
    WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<${Math.floor(n / 8)})
    INSERT INTO custom_domains(id,group_id,full_domain,expires_at) SELECT i,8,'item-'||(i*8)||'.example.net','2027-03-01' FROM seq;
    INSERT INTO domain_date_overrides(account_id,full_domain,expires_at,updated_at)
    SELECT account_id,full_domain,'2027-04-01','2026-11-24T00:00:00Z' FROM domains_cache WHERE id%97=0;
    INSERT INTO settings(key,value) VALUES('catalog_summary_revision','isolated-projection-fixture');
  `;
}
const report = { node: process.version, platform: process.platform, compatibilityDate, sizes, repeats,
  sourceDigest: createHash("sha256").update(module.outputFiles[0].text).digest("hex"),
  disclaimer: "Isolated fixed-input/fixed-offset prototype, not production incremental processing. Wall includes local D1 transport. Node CPU includes native SQLite. Reported rows/duration are emulator/adapter metadata, not production billing. No CPU sampling or peak memory acceptance.", runs: [] };
console.log(`PROJECTION_OUTPUT=${out}`);
const hashes = new Map();
for (const n of sizes) for (const runtime of ["node", "workerd"]) {
  let mf, sqlite, db;
  try {
    if (runtime === "node") {
      sqlite = new DatabaseSync(":memory:"); sqlite.exec(schema); sqlite.exec(fixture(n)); db = createD1FromSqlite(sqlite);
    } else {
      mf = new Miniflare(convertV4MiniflareOptions({ name: "projection-perf", modules: true, script: worker.outputFiles[0].text,
        compatibilityDate, d1Databases: ["DB"], outboundService() { throw new Error("Projection probe forbids upstream"); } }));
      db = await mf.getD1Database("DB");
      for (const source of [schema, fixture(n)]) {
        const statements = source.replace(/^\s*--[^\r\n]*/gm, "").split(";").map(sql => sql.trim()).filter(Boolean);
        for (let i = 0; i < statements.length; i += 40) await db.batch(statements.slice(i, i + 40).map(sql => db.prepare(sql)));
      }
    }
    const invoke = async (action, generation = "") => {
      if (runtime === "node") return run(db, action, generation);
      const response = await mf.dispatchFetch(`http://localhost/${action}?generation=${generation}`);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    await invoke("reference");
    for (let repeat = 0; repeat < repeats; repeat++) {
      let generation, expected;
      for (const action of ["reference", "stage", "read"]) {
        const cpu = process.cpuUsage(), start = performance.now(), value = await invoke(action, generation);
        const wallMs = performance.now() - start, consumed = process.cpuUsage(cpu);
        if (action === "reference") expected = value.stats;
        if (action === "stage") generation = value.manifest.generation;
        if (action === "read") assert.deepEqual(value.stats, expected);
        const hash = value.stats ? createHash("sha256").update(JSON.stringify(value.stats)).digest("hex") : undefined;
        if (hash) {
          if (hashes.has(n)) assert.equal(hash, hashes.get(n), `Cross-runtime/repeat projection result mismatch at ${n}`);
          else hashes.set(n, hash);
        }
        const record = { n, runtime, action, repeat, wallMs,
          ...(runtime === "node" ? { processCpuMs: (consumed.user + consumed.system) / 1000 } : {}),
          ...(value.metrics ? { metrics: value.metrics } : {}),
          ...(action === "stage" ? { pages: value.manifest.pages, sourceRows: value.manifest.rows, encodedPageBytes: value.manifest.encoded_bytes } : {}),
          ...(value.capture ? { capture: value.capture } : {}),
          ...(value.stats ? { responseBytes: Buffer.byteLength(JSON.stringify(value.stats)),
            hash } : {}) };
        report.runs.push(record); console.log(JSON.stringify(record));
      }
    }
  } finally { if (mf) await mf.dispose(); sqlite?.close(); }
}
await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(`PROJECTION_REPORT=${path.join(out, "report.json")}`);
