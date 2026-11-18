import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(path.join(root, "package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const key = "isolated-runtime-smoke-test-key";
const request = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
async function authentication(fetcher) {
  assert.equal((await fetcher("/api/accounts")).status, 401);
  const setup = await fetcher("/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "runtime-smoke", password: "isolated-runtime-password" }) });
  assert.equal(setup.status, 200, await setup.clone().text());
  const token = (await setup.json()).session_token;
  assert.ok(token);
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetcher("/api/accounts", { headers })).status, 200);
  const domains = await fetcher("/api/domains", { headers });
  assert.equal(domains.status, 200);
  assert.deepEqual((await domains.json()).domains, []);
}

const config = await readFile(path.join(root, "wrangler.toml"), "utf8");
const date = config.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1];
assert.ok(date, "Runtime smoke must use the configured compatibility date");
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, scriptPath: path.join(root, "dist-worker/wrangler-dry-run/index.js"),
  compatibilityDate: date, d1Databases: ["DB"], bindings: { AES_KEY: key },
}));
try { await authentication((url, init) => mf.dispatchFetch(`http://localhost${url}`, init)); }
finally { await mf.dispose(); }

const base = process.platform === "win32" && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Temp/opencode") : tmpdir();
await mkdir(base, { recursive: true });
const data = await mkdtemp(path.join(base, "domain-hub-runtime-smoke-"));
const env = { ...process.env, DATA_DIR: data, AES_KEY: key, HOST: "127.0.0.1", PORT: "0",
  STATIC_DIR: path.join(root, "frontend/dist"), DISABLE_CRON: "1" };
for (const name of ["DB_PATH", "SCHEMA_FILE", "DEFAULT_API_KEY", "DEFAULT_API_SECRET", "DEFAULT_API_ALIAS",
  "ADMIN_TOKEN", "WEBHOOK_URL", "WEBHOOK_TYPE", "ALLOWED_ORIGIN"]) delete env[name];
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
  await authentication((pathname, init) => request(`${url}${pathname}`, init));
  console.log("[runtime-smoke] isolated workerd/D1 and Node/SQLite passed");
} finally {
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 10000);
  await exited; clearTimeout(force);
}
