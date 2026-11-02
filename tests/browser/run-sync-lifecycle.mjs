import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomInt } from "node:crypto";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

// Optional browser gate: existing Chrome only, no dependency install, real
// credentials, provider requests or use of the user's normal browser profile.
const chrome = process.env.CHROME_PATH ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
assert.ok(existsSync(chrome), "Set CHROME_PATH to an installed Chrome/Chromium executable");
const temp = process.platform === "win32" && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp/opencode") : os.tmpdir();
const directory = mkdtempSync(path.join(temp, "sync-lifecycle-browser-"));
const bundle = await build({ entryPoints: ["tests/browser/sync-lifecycle.tsx"], bundle: true, platform: "browser", format: "iife", write: false,
  alias: { react: "./frontend/node_modules/react", "react-dom": "./frontend/node_modules/react-dom" }, define: { "process.env.NODE_ENV": '"development"', "import.meta.env": "{}" } });
const server = createServer((request, response) => {
  response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'none'; style-src 'unsafe-inline'");
  if (request.url === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].text); }
  else if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><title>Offline sync lifecycle</title><script src="/fixture.js" defer></script>'); }
  else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
// Chromium's random debug port may be on Fetch's forbidden-port list (e.g.
// 6669). Reserve a free port in a safe range rather than disabling that policy.
const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(randomInt(20000, 60000), "127.0.0.1", resolve); });
const debugPort = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const child = spawn(chrome, ["--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${directory}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--no-proxy-server", "about:blank"], { stdio: "ignore" });
let socket;
const blocked = [], pending = new Map(); let serial = 0;
function call(method, params = {}) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
try {
  const deadline = Date.now() + 15000;
  let pages;
  while (!pages) {
    assert.ok(child.exitCode === null && Date.now() < deadline, "Chrome did not start");
    try { pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { const task = pending.get(message.id); if (task) { pending.delete(message.id); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); } }
    if (message.method === "Fetch.requestPaused") {
      const { requestId, request } = message.params;
      const allowed = request.url === `${origin}/` || request.url === `${origin}/fixture.js`;
      if (!allowed) blocked.push(request.url);
      void call(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" }).catch(() => {});
    }
  };
  await call("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await call("Page.enable"); await call("Runtime.enable"); await call("Page.navigate", { url: origin });
  const readyDeadline = Date.now() + 10000;
  while (!(await call("Runtime.evaluate", { expression: "typeof window.runLifecycleSuite === 'function'", returnByValue: true })).result.value) {
    assert.ok(Date.now() < readyDeadline, "browser fixture failed to load"); await new Promise(resolve => setTimeout(resolve, 25));
  }
  const result = await call("Runtime.evaluate", { expression: "window.runLifecycleSuite()", awaitPromise: true, returnByValue: true });
  assert.equal(result.exceptionDetails, undefined, "browser fixture threw");
  const results = result.result.value;
  const version = await call("Browser.getVersion");
  writeFileSync(path.join(directory, "receipt.json"), JSON.stringify({ capturedAt: new Date().toISOString(), browser: version.product, results, blocked,
    syntheticVisibility: true, realReactEffects: true, realProviderRequests: 0, originalDataAccessed: false }, null, 2));
  for (const row of results) console.log(`${row.passed ? "PASS" : "FAIL"} ${row.name}${row.error ? `: ${row.error}` : ""}`);
  console.log(`Browser receipt: ${path.join(directory, "receipt.json")}`);
  assert.equal(results.length, 13); assert.ok(results.every(row => row.passed), "browser lifecycle gate failed");
} finally {
  // Only this spawned, isolated browser is closed. Keep its receipt/profile.
  if (socket?.readyState === WebSocket.OPEN) { await call("Browser.close").catch(() => {}); socket.close(); }
  if (child.exitCode === null) child.kill();
  for (const task of pending.values()) task.reject(new Error("browser closed"));
  await new Promise(resolve => server.close(resolve));
}
