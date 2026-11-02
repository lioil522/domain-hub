import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const { outputFiles: [worker] } = await build({ entryPoints: ["tests/workers/runtime-fixture.ts"], bundle: true,
  platform: "neutral", target: "es2022", format: "esm", write: false });
// Use the same wire fixtures without executing any production client in Node.
const { outputFiles: [fixtures] } = await build({ stdin: {
   contents: 'export { transportProviders, transportEmptyDomains, transportErrorBody, dpExisting, businessRateLimits } from "./tests/helpers/provider-transport";',
  resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", target: "node22", format: "esm", write: false });
const { transportProviders, transportEmptyDomains, transportErrorBody, dpExisting, businessRateLimits } = await import(`data:text/javascript;base64,${Buffer.from(fixtures.text).toString("base64")}`);
const compatibilityDate = readFileSync("wrangler.toml", "utf8").match(/^compatibility_date\s*=\s*"([\d-]+)"/m)?.[1];
assert.ok(compatibilityDate);

test("workerd: real fetch/body/crypto transport contracts for all seven clients, local outbound only", async t => {
  let active;
  let attempts = [];
  const pendingTimers = new Set();
  const expectedHost = { dnshe: "api005.dnshe.com", cloudflare: "api.cloudflare.com", dnspod: "dnspod.tencentcloudapi.com",
    alidns: "alidns.aliyuncs.com", huaweicloud: "dns.myhuaweicloud.com", vercel: "api.vercel.com", digitalplat: "domain-api.digitalplat.org" };
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: worker.text,
    compatibilityDate, cf: false, host: "127.0.0.1", port: 0,
    d1Databases: ["DB"], bindings: { AES_KEY: "offline-test-key", ADMIN_TOKEN: "offline-admin" },
    outboundService: async request => {
      if (!active || new URL(request.url).host !== expectedHost[active.provider]) {
        throw new Error("unexpected outbound request is forbidden");
      }
      const { provider, mode, write } = active;
      attempts.push(request.method);
      if (write && provider === "digitalplat" && request.method === "GET") return Response.json({ success: true, data: [dpExisting] });
      if (mode === "good") {
        const bytes = new TextEncoder().encode(JSON.stringify({ ...transportEmptyDomains(provider), message: "你好😀" }));
        return new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } }));
      }
      if (mode === "late-headers") {
        return new Promise(resolve => {
          const timer = setTimeout(() => { pendingTimers.delete(timer); resolve(Response.json(transportEmptyDomains(provider))); }, 180);
          pendingTimers.add(timer);
        });
      }
      if (mode === "slow-body") {
        return new Response(new ReadableStream({ start(c) {
          c.enqueue(new TextEncoder().encode("{"));
          const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            try { c.close(); } catch { /* deadline already cancelled */ }
          }, 180);
          pendingTimers.add(timer);
        } }));
      }
      if (mode === "oversized") return new Response("x".repeat(301));
      if (mode === "bad-utf8") return new Response(Uint8Array.of(0xff));
      if (mode === "non-json") return new Response("<html>challenge</html>", { status: 429, headers: { "Retry-After": "3" } });
      return Response.json(transportErrorBody(provider), { status: Number(mode), headers: { "Retry-After": "3" } });
    },
  }));
  t.after(async () => { await mf.dispose(); for (const timer of pendingTimers) clearTimeout(timer); });
  const call = async (provider, mode, write = false) => {
    active = { provider, mode, write };
    attempts = [];
    const response = await mf.dispatchFetch(`http://localhost/fixture/transport?provider=${provider}&write=${write ? 1 : 0}&timeout=70&cap=300`);
    return { status: response.status, body: await response.json() };
  };
  for (const provider of transportProviders) {
    await t.test(provider, async () => {
      assert.deepEqual(await call(provider, "good"), { status: 200, body: { success: true } });
      for (const [mode, code, status] of [["late-headers", "request_timeout", 502], ["slow-body", "request_timeout", 502],
        ["oversized", "response_too_large", 502], ["bad-utf8", "invalid_response", 502],
        ["non-json", provider === "alidns" ? "invalid_response" : "non_json_response", 429],
        ["401", "fixture_denied", 502], ["403", "fixture_denied", 403], ["429", "fixture_denied", 429], ["200", "fixture_denied", 502]]) {
        for (const write of [false, true]) {
          const result = await call(provider, mode, write);
          assert.equal(result.status, status, `${provider} ${mode} write=${write}: ${JSON.stringify(result.body)}`);
          assert.equal(result.body.error_code, code);
          assert.equal(result.body.provider, provider);
          assert.equal(result.body.code, `upstream_${code}`);
          if (["non-json", "429", "401", "403", "200"].includes(mode)) assert.equal(result.body.retryAfterMs, 3000);
          const wireMethods = provider === "dnspod" || provider === "alidns" || write ? ["POST"] : ["GET"];
          assert.deepEqual(attempts, provider === "digitalplat" && write ? ["GET", "POST"] : wireMethods);
        }
      }
    });
  }
});

test("workerd/D1: all seven real transports persist HTML 429 cooldown across requests", async t => {
  let active;
  let calls = 0;
  const expectedHost = { dnshe: "api005.dnshe.com", cloudflare: "api.cloudflare.com", dnspod: "dnspod.tencentcloudapi.com",
    alidns: "alidns.aliyuncs.com", huaweicloud: "dns.myhuaweicloud.com", vercel: "api.vercel.com", digitalplat: "domain-api.digitalplat.org" };
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: worker.text,
    compatibilityDate, cf: false, host: "127.0.0.1", port: 0,
    d1Databases: ["DB"], bindings: { AES_KEY: "offline-test-key", ADMIN_TOKEN: "offline-admin" },
    outboundService: request => {
      if (!active || new URL(request.url).host !== expectedHost[active]) throw new Error("unexpected outbound request is forbidden");
      calls++;
      return new Response("<html>rate limited</html>", { status: 429, headers: { "Retry-After": "60" } });
    },
  }));
  t.after(() => mf.dispose());
  for (const provider of transportProviders) await t.test(provider, async () => {
    active = provider;
    const path = `http://localhost/fixture/transport?provider=${provider}&scheduled=1&timeout=1000`;
    const first = await mf.dispatchFetch(path);
    assert.equal(first.status, 429);
    assert.equal((await first.json()).error_code, provider === "alidns" ? "invalid_response" : "non_json_response");
    const before = calls;
    const second = await mf.dispatchFetch(`${path}&write=1`);
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error_code, "scheduler_cooldown");
    assert.equal(calls, before, "later write never reaches the upstream");
  });
  assert.equal(calls, 7);
});

test("workerd: documented business codes retain upstream statuses and persist shared D1 cooldown", async t => {
  let active;
  let calls = 0;
  const hosts = { dnshe: "api005.dnshe.com", dnspod: "dnspod.tencentcloudapi.com", alidns: "alidns.aliyuncs.com",
    huaweicloud: "dns.myhuaweicloud.com", vercel: "api.vercel.com" };
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: worker.text,
    compatibilityDate, cf: false, host: "127.0.0.1", port: 0,
    d1Databases: ["DB"], bindings: { AES_KEY: "offline-test-key", ADMIN_TOKEN: "offline-admin" },
    outboundService: request => {
      if (!active || new URL(request.url).host !== hosts[active.provider]) throw new Error("unexpected outbound request is forbidden");
      calls++;
      if (active.xml) return new Response(`<Error><Code>${active.code}</Code><Message>fixture throttling</Message></Error>`, { status: 400, headers: { "Retry-After": "60" } });
      return Response.json(transportErrorBody(active.provider, active.code), { status: active.provider === "alidns" ? 400 : 200, headers: { "Retry-After": "60" } });
    },
  }));
  t.after(() => mf.dispose());
  for (const item of businessRateLimits) await t.test(`${item.provider}/${item.code}`, async () => {
    active = item;
    // Test every code with real fetch/crypto and no scheduler, on both read and write.
    for (const write of [false, true]) {
      const before = calls;
      const response = await mf.dispatchFetch(`http://localhost/fixture/transport?provider=${item.provider}&timeout=1000&write=${write ? 1 : 0}`);
      const body = await response.json();
      assert.equal(response.status, 429);
      assert.equal(body.status, item.provider === "alidns" ? 400 : 200);
      assert.equal(body.error_code, item.code);
      assert.equal(body.rateLimited, true);
      assert.equal(body.retryAfterMs, 60_000);
      assert.equal(calls, before + 1);
    }
  });
  const unique = businessRateLimits.filter((item, index, all) => all.findIndex(v => v.provider === item.provider) === index);
  for (const item of unique) await t.test(`${item.provider}/shared-D1`, async () => {
    active = { ...item, xml: item.provider === "alidns" };
    const path = `http://localhost/fixture/transport?provider=${item.provider}&scheduled=1&timeout=1000`;
    const before = calls;
    const first = await mf.dispatchFetch(`${path}&write=1`);
    assert.equal(first.status, 429);
    assert.equal((await first.json()).error_code, item.code);
    const second = await mf.dispatchFetch(path);
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error_code, "scheduler_cooldown");
    assert.equal(calls, before + 1);
  });
});

test("workerd/D1: resource quotas and unconfirmed/approximate business codes never persist rate cooldown", async t => {
  let active;
  let calls = 0;
  const cases = [
    { provider: "dnshe", code: "quota_exceeded" },
    { provider: "dnspod", code: "LimitExceeded.DomainCountLimit" },
    { provider: "alidns", code: "Throttling.API" },
    { provider: "huaweicloud", code: "DNS.0021" },
    { provider: "vercel", code: "too_many_requests" },
    { provider: "cloudflare", code: "1015" },
    { provider: "digitalplat", code: "rate_limited" },
  ];
  const hosts = { dnshe: "api005.dnshe.com", cloudflare: "api.cloudflare.com", dnspod: "dnspod.tencentcloudapi.com",
    alidns: "alidns.aliyuncs.com", huaweicloud: "dns.myhuaweicloud.com", vercel: "api.vercel.com", digitalplat: "domain-api.digitalplat.org" };
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: worker.text,
    compatibilityDate, cf: false, host: "127.0.0.1", port: 0,
    d1Databases: ["DB"], bindings: { AES_KEY: "offline-test-key", ADMIN_TOKEN: "offline-admin" },
    outboundService: request => {
      if (!active || new URL(request.url).host !== hosts[active.provider]) throw new Error("unexpected outbound request is forbidden");
      calls++;
      return Response.json(active.good ? transportEmptyDomains(active.provider)
        : transportErrorBody(active.provider, active.code, "rate limit; too many requests"));
    },
  }));
  t.after(() => mf.dispose());
  for (const item of cases) await t.test(`${item.provider}/${item.code}`, async () => {
    active = item;
    const path = `http://localhost/fixture/transport?provider=${item.provider}&scheduled=1&timeout=1000`;
    const first = await mf.dispatchFetch(path);
    const body = await first.json();
    assert.equal(first.status, 502);
    assert.equal(body.error_code, item.code);
    assert.equal(body.rateLimited, false);
    active = { ...item, good: true };
    const before = calls;
    const second = await mf.dispatchFetch(path);
    assert.equal(second.status, 200, "negative code must not block the next upstream request");
    assert.equal(calls, before + 1);
  });
});

test("workerd/D1: coordination timers bound real SQL boundaries without cancelling late writes or retrying DNS", async t => {
  let mode;
  let calls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: worker.text,
    compatibilityDate, cf: false, host: "127.0.0.1", port: 0,
    d1Databases: ["DB"], bindings: { AES_KEY: "offline-test-key", ADMIN_TOKEN: "offline-admin" },
    outboundService: request => {
      const host = new URL(request.url).host;
      if (host !== (mode.startsWith("budget") ? "api005.dnshe.com" : "api.cloudflare.com")) throw new Error("unexpected outbound forbidden");
      calls++;
      if (mode === "release-error") return new Response(Uint8Array.of(0xff));
      if (mode.startsWith("block")) return new Response("rate limit", { status: 429 });
      if (mode === "budget-block") return Response.json({ success: false, error_code: "rate_limit_exceeded" });
      return Response.json({ success: true, result: { id: "rr-1" } });
    },
  }));
  t.after(() => mf.dispose());
  for (const scenario of ["claim-before", "claim-after", "claim-reject", "release", "release-error", "block", "block-reject", "budget-reserve", "budget-block"]) {
    await t.test(scenario, async () => {
      mode = scenario;
      const before = calls;
      const response = await mf.dispatchFetch(`http://localhost/fixture/coordination-deadline?mode=${mode}`);
      const body = await response.json();
      assert.equal(response.status, 502);
      assert.equal(body.code, mode === "release-error" ? "invalid_response" : mode.startsWith("budget") ? "budget_timeout" : "scheduler_timeout");
      assert.equal(body.calls, 1, "one SQL attempt at the hung boundary, never another claim");
      const sent = !(mode.startsWith("claim") || mode === "budget-reserve");
      assert.equal(calls - before, sent ? 1 : 0);
      assert.equal(body.before, mode === "claim-after" || mode.startsWith("release") ? 1 : 0);
      assert.equal(body.after, mode === "claim-after" || mode.startsWith("release") ? 1 : 0, "old release cannot delete replacement owner");
      if (mode !== "release-error") assert.equal(body.details.details.request_sent, sent ? "unknown" : false);
      if (mode.startsWith("block") || mode === "budget-block") {
        assert.equal(body.details.details.cooldown_persisted, "unknown");
        assert.equal(body.blocked, mode === "block-reject" ? 0 : 1, "late SQL may persist cooldown after rejection");
      }
      assert.equal(JSON.stringify(body).includes("secret-late-sql"), false);
    });
  }
});
