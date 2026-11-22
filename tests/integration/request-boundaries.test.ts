import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import worker, { fetchWithRequestSecurity } from "../../src/index";
import { nodeNetworkPolicy, nodeRequestSecurity } from "../../server/request-security";
import { normalizeIp, parseOrigin, workerRequestSecurity } from "../../src/middleware/request-security";
import { testDatabase, TEST_AES_KEY, TEST_PASSWORD } from "../helpers/database";
import type { Bindings } from "../../src/routes/types";
import { Hono } from "hono";
import { apiCors } from "../../src/middleware/cors";
import type { AppEnv } from "../../src/routes/types";
import { loopbackFetch } from "../helpers/loopback-fetch.mjs";

const SETUP = "isolated-owner-setup-token-for-boundary-tests";
const context = { waitUntil(promise: Promise<unknown>) { void promise.catch(() => {}); }, props: {} } as unknown as ExecutionContext;
const setupBody = JSON.stringify({ username: "boundary-admin", password: TEST_PASSWORD });
const setupHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${SETUP}` };
const call = (db: D1Database, init: RequestInit = {}, extra: Partial<Bindings> = {}, route = "/api/auth/status") =>
  worker.fetch(new Request(`https://app.example${route}`, init), { DB: db, AES_KEY: TEST_AES_KEY, SETUP_TOKEN: SETUP, ...extra }, context);
const input = (headers: HeadersInit = {}) => new Request("http://internal.example/api/auth/status", { headers });

test("IP parsing canonicalizes IPv6/mapped IPv4 without accepting malformed addresses", () => {
  assert.equal(normalizeIp("2001:0DB8:0:0:0:0:0:1"), "2001:db8::1");
  assert.equal(normalizeIp("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeIp("::ffff:7f00:1"), "127.0.0.1");
  for (const bad of ["999.1.1.1", "127.1", "0127.0.0.1", "1.2.3.4:5", "fe80::1%eth0", "[::1]", "1.2.3.4,5.6.7.8", "abc", ":::"]) {
    assert.equal(normalizeIp(bad), null, bad);
  }
});
test("origins require exact HTTP(S) origins, not wildcards, opaque origins or URLs with paths", () => {
  assert.equal(parseOrigin("https://APP.example:443/"), "https://app.example");
  assert.equal(parseOrigin("http://localhost:5173"), "http://localhost:5173");
  for (const bad of ["*", "null", "https://user:pass@app.example", "https://app.example/api", "https://app.example?x", "https://app.example#x", "file:///tmp", "https://app.example\\evil"]) {
    assert.equal(parseOrigin(bad), null, bad);
  }
});
test("Worker ingress trusts only the edge IP and does not fall back to XFF or X-Real-IP", () => {
  const headers = { "X-Forwarded-For": "1.2.3.4", "X-Real-IP": "5.6.7.8" };
  assert.equal(workerRequestSecurity(input(headers)).clientIp, "unknown");
  assert.equal(workerRequestSecurity(input({ ...headers, "CF-Connecting-IP": "2001:0db8::1" })).clientIp, "2001:db8::1");
  assert.equal(workerRequestSecurity(input({ ...headers, "CF-Connecting-IP": "not-an-ip" })).clientIp, "unknown");
});
test("Node defaults to socket IP and ignores all forwarded identity and origin headers", () => {
  const request = input({ "CF-Connecting-IP": "1.2.3.4", "X-Real-IP": "5.6.7.8", "X-Forwarded-For": "9.9.9.9",
    "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https", Forwarded: "for=1.2.3.4;host=evil.example;proto=https" });
  assert.deepEqual(nodeRequestSecurity(request, "::ffff:127.0.0.1", nodeNetworkPolicy()), { clientIp: "127.0.0.1", origin: "http://internal.example" });
  assert.equal(nodeRequestSecurity(request, undefined, nodeNetworkPolicy()).clientIp, "unknown");
});
test("trusted proxy chains are walked from the peer to the first untrusted hop", () => {
  const policy = nodeNetworkPolicy("127.0.0.1,10.0.0.0/8,2001:db8:1::/48", "https://public.example");
  const request = input({ "X-Forwarded-For": "1.2.3.4,198.51.100.7,10.0.0.2" });
  assert.deepEqual(nodeRequestSecurity(request, "127.0.0.1", policy), { clientIp: "198.51.100.7", origin: "https://public.example" });
  assert.equal(nodeRequestSecurity(request, "198.51.100.1", policy).clientIp, "198.51.100.1");
  assert.equal(nodeRequestSecurity(input({ "X-Forwarded-For": "198.51.100.7,2001:db8:1::9" }), "2001:db8:1::1", policy).clientIp, "198.51.100.7");
  assert.equal(nodeRequestSecurity(input({ "X-Forwarded-For": "198.51.100.7" }), "::ffff:127.0.0.1", policy).clientIp, "198.51.100.7");
});
test("malformed or oversized forwarding chains fail back to the connected peer", () => {
  const policy = nodeNetworkPolicy("127.0.0.1");
  for (const header of ["1.2.3.4,unknown", "1.2.3.4,", "1.2.3.4:80", Array(33).fill("1.2.3.4").join(","), "1".repeat(4097)]) {
    assert.equal(nodeRequestSecurity(input({ "X-Forwarded-For": header }), "127.0.0.1", policy).clientIp, "127.0.0.1");
  }
});
test("invalid proxy and public-origin configuration fails closed rather than trusting everyone", () => {
  for (const value of ["*", "loopback", "127.0.0.1/-1", "127.0.0.1/33", "::1/129", "127.0.0.1/8/2", "127.0.0.1/", Array(65).fill("127.0.0.1").join(",")]) {
    assert.throws(() => nodeNetworkPolicy(value));
  }
  assert.throws(() => nodeNetworkPolicy("", "https://public.example/path"));
});
test("default CORS permits same-origin/no-Origin but rejects foreign and opaque Origins before DB access", async t => {
  const { d1 } = await testDatabase(t);
  for (const headers of [{}, { Origin: "https://app.example" }]) {
    const response = await call(d1, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "Origin" in headers ? headers.Origin : null);
    assert.ok(response.headers.get("Vary")?.includes("Origin"));
  }
  let queries = 0;
  const blocked = new Proxy(d1, { get(target, property) {
    if (property === "prepare") return () => { queries++; throw new Error("Foreign Origin reached DB"); };
    return Reflect.get(target, property);
  } });
  for (const origin of ["https://evil.example", "null", "https://app.example.evil", "https://app.example/path", ""]) {
    assert.equal((await call(blocked, { headers: { Origin: origin } })).status, 403);
  }
  assert.equal((await call(blocked, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal(queries, 0);
});
test("CORS explicit origins remain additive and reject wildcard/invalid configuration", async t => {
  const { d1 } = await testDatabase(t);
  const extra = { ALLOWED_ORIGIN: "https://frontend.example/, http://localhost:5173" };
  for (const origin of ["https://app.example", "https://frontend.example", "http://localhost:5173"]) {
    const response = await call(d1, { headers: { Origin: origin } }, extra);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
    assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
  }
  for (const allowed of ["*", "null", "https://frontend.example/path"]) {
    assert.equal((await call(d1, {}, { ALLOWED_ORIGIN: allowed })).status, 503);
  }
});
test("PATCH preflight has correct CORS/Vary headers, no DB calls, and rejects unsupported controls", async t => {
  const { d1 } = await testDatabase(t);
  let queries = 0;
  const observed = new Proxy(d1, { get(target, property) {
    if (property === "prepare") return () => { queries++; throw new Error("Preflight reached DB"); };
    return Reflect.get(target, property);
  } });
  const headers = { Origin: "https://app.example", "Access-Control-Request-Method": "PATCH",
    "Access-Control-Request-Headers": "authorization, Content-Type" };
  const good = await call(observed, { method: "OPTIONS", headers });
  assert.equal(good.status, 204);
  assert.ok(good.headers.get("Access-Control-Allow-Methods")?.includes("PATCH"));
  assert.ok(good.headers.get("Vary")?.includes("Access-Control-Request-Headers"));
  assert.ok(good.headers.get("Vary")?.includes("Access-Control-Request-Method"));
  for (const changes of [{ Origin: "https://evil.example" }, { "Access-Control-Request-Method": "TRACE" },
    { "Access-Control-Request-Headers": "X-Untrusted" }]) {
    const rejected = await call(observed, { method: "OPTIONS", headers: { ...headers, ...changes } });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("Access-Control-Allow-Origin"), null);
  }
  assert.equal(queries, 0);
});
test("CORS preserves downstream Vary fields and attaches headers to authenticated PATCH/error responses", async t => {
  const { d1, manager } = await testDatabase(t);
  const app = new Hono<AppEnv>();
  app.use("/api/*", apiCors);
  app.get("/api/vary", c => { c.header("Vary", "Accept-Encoding"); return c.text("ok"); });
  const response = await app.fetch(new Request("https://app.example/api/vary", { headers: { Origin: "https://app.example" } }),
    { DB: d1, REQUEST_SECURITY: { clientIp: "unknown", origin: "https://app.example" } });
  assert.ok(response.headers.get("Vary")?.includes("Accept-Encoding"));
  assert.ok(response.headers.get("Vary")?.includes("Origin"));
  const token = await manager.createSession();
  const patch = await call(d1, { method: "PATCH", headers: { Origin: "https://frontend.example", Authorization: `Bearer ${token}`,
    "Content-Type": "application/json" }, body: "{}" }, { ALLOWED_ORIGIN: "https://frontend.example" }, "/api/actions/does-not-exist");
  assert.equal(patch.headers.get("Access-Control-Allow-Origin"), "https://frontend.example");
  assert.ok(patch.status >= 400, "Missing resource must retain its error status");
  assert.ok(patch.headers.get("Vary")?.includes("Origin"));
});
test("setup without a valid configured owner token remains locked and does not create an account", async t => {
  const { d1, manager } = await testDatabase(t);
  for (const token of [undefined, "", "short", " ".repeat(32)]) {
    const response = await call(d1, { method: "POST", headers: setupHeaders, body: setupBody }, { SETUP_TOKEN: token }, "/api/auth/setup");
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes(SETUP));
  }
  assert.equal((await manager.getAuthConfig()).initialized, false);
  assert.equal(await manager.getSetting("auth_setup_claim"), null);
  assert.equal((await manager.allRaw<{ n: number }>("SELECT COUNT(*) n FROM settings WHERE key LIKE 'sess_%'"))[0].n, 0);
});
test("owner setup authorizes before parsing/claiming credentials and cannot be replayed", async t => {
  const { d1, manager } = await testDatabase(t);
  for (const authorization of ["", "Bearer wrong-token", `Basic ${SETUP}`]) {
    assert.equal((await call(d1, { method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization },
      body: setupBody }, {}, "/api/auth/setup")).status, 401);
  }
  assert.equal((await manager.getAuthConfig()).initialized, false);
  assert.equal((await call(d1, { method: "POST", headers: { ...setupHeaders, Origin: "https://evil.example" }, body: setupBody }, {}, "/api/auth/setup")).status, 403);
  assert.equal((await call(d1, { method: "POST", headers: { ...setupHeaders, "Content-Type": "text/plain" }, body: setupBody }, {}, "/api/auth/setup")).status, 415);
  const response = await call(d1, { method: "POST", headers: setupHeaders, body: setupBody }, {}, "/api/auth/setup");
  assert.equal(response.status, 200);
  assert.ok((await response.json() as { session_token: string }).session_token);
  assert.equal((await call(d1, { method: "POST", headers: setupHeaders, body: setupBody }, {}, "/api/auth/setup")).status, 403);
});
test("setup guesses are rate limited but cannot lock out the valid deployment owner", async t => {
  const { d1, manager } = await testDatabase(t);
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await call(d1, { method: "POST", headers: { "Content-Type": "application/json",
      "X-Forwarded-For": `203.0.113.${attempt + 1}` }, body: setupBody }, {}, "/api/auth/setup");
    assert.equal(response.status, attempt < 5 ? 401 : 429);
  }
  assert.equal(await manager.getSetting("auth_setup_claim"), null);
  assert.equal((await call(d1, { method: "POST", headers: setupHeaders, body: setupBody }, {}, "/api/auth/setup")).status, 200);
});
test("runtime context is request scoped and Worker entry cannot inherit forged adapter metadata", async t => {
  const { d1, manager } = await testDatabase(t);
  await manager.setPassword("admin", TEST_PASSWORD);
  for (let i = 0; i < 6; i++) {
    const response = await call(d1, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }) },
    { REQUEST_SECURITY: { clientIp: `203.0.113.${i}`, origin: "https://evil.example" } }, "/api/auth/login");
    assert.equal(response.status, i < 5 ? 401 : 429);
  }
  const request = new Request("https://app.example/api/auth/login", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "wrong" }) });
  assert.equal((await fetchWithRequestSecurity(request, { DB: d1, AES_KEY: TEST_AES_KEY }, context,
    { clientIp: "198.51.100.8", origin: "https://app.example" })).status, 401);
});

async function nodeServer(t: TestContext, extra: Record<string, string> = {}) {
  const base = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA!, "Temp/opencode") : tmpdir();
  const dir = mkdtempSync(path.join(base, "domain-hub-request-boundaries-"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["DB_PATH", "SCHEMA_FILE", "DEFAULT_API_KEY", "DEFAULT_API_SECRET", "DEFAULT_API_ALIAS",
    "ADMIN_TOKEN", "WEBHOOK_URL", "WEBHOOK_TYPE", "ALLOWED_ORIGIN", "TRUSTED_PROXIES", "PUBLIC_ORIGIN"]) delete env[name];
  Object.assign(env, { DATA_DIR: dir, AES_KEY: TEST_AES_KEY, SETUP_TOKEN: SETUP, HOST: "127.0.0.1", PORT: "0", DISABLE_CRON: "1" }, extra);
  const child = spawn(process.execPath, ["dist-node/server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 9000);
    await exited; clearTimeout(timer);
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Node boundary startup timeout")); }, 15000);
    const capture = (bytes: Buffer) => {
      output = (output + bytes).slice(-65536);
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(output)); });
  });
  assert.ok(!output.includes(SETUP) && !output.includes(TEST_AES_KEY));
  return (route: string, init: RequestInit = {}) => loopbackFetch(`http://127.0.0.1:${port}${route}`, { ...init, signal: AbortSignal.timeout(15000) });
}
test("real Node ingress cannot evade login limits by rotating forged proxy headers", async t => {
  const fetcher = await nodeServer(t);
  assert.equal((await fetcher("/api/auth/setup", { method: "POST", headers: setupHeaders, body: setupBody })).status, 200);
  for (let i = 0; i < 6; i++) {
    const response = await fetcher("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json",
      "CF-Connecting-IP": `203.0.113.${i}`, "X-Real-IP": `198.51.100.${i}`, "X-Forwarded-For": `192.0.2.${i}` },
    body: JSON.stringify({ username: "boundary-admin", password: "wrong" }) });
    assert.equal(response.status, i < 5 ? 401 : 429);
  }
});
test("real Node trusted proxy honors public HTTPS Origin and stops at the actual untrusted client", async t => {
  const fetcher = await nodeServer(t, { TRUSTED_PROXIES: "127.0.0.1", PUBLIC_ORIGIN: "https://public.example" });
  assert.equal((await fetcher("/api/auth/setup", { method: "POST", headers: { ...setupHeaders, Origin: "https://public.example" }, body: setupBody })).status, 200);
  assert.equal((await fetcher("/api/auth/status", { headers: { Origin: "https://forged.example", "X-Forwarded-Host": "forged.example", "X-Forwarded-Proto": "https" } })).status, 403);
  for (let i = 0; i < 6; i++) {
    const response = await fetcher("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json",
      "X-Forwarded-For": `192.0.2.${i},198.51.100.7` }, body: JSON.stringify({ username: "boundary-admin", password: "wrong" }) });
    assert.equal(response.status, i < 5 ? 401 : 429);
  }
  assert.equal((await fetcher("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.8" },
    body: JSON.stringify({ username: "boundary-admin", password: "wrong" }) })).status, 401);
});
