import "../helpers/block-outbound";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ProviderApiError } from "../../src/errors/provider-api-error";
import { requestProviderText, parseRetryAfter, PROVIDER_TIMEOUT_MS, PROVIDER_MAX_RESPONSE_BYTES } from "../../src/providers/provider-request";
import { DNSHEClient } from "../../src/dnshe";
import { HuaweiCloudClient, HuaweiApiError } from "../../src/huaweicloud";
import { transportProviders, transportFixture, transportErrorBody, transportEmptyDomains, dpExisting, type TransportProvider } from "../helpers/provider-transport";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const blockedFetch = globalThis.fetch;
const typed = (provider: string, code?: string, status?: number) => (error: unknown) => {
  assert.ok(error instanceof ProviderApiError);
  assert.equal(error.provider, provider);
  if (code) assert.equal(error.error_code, code);
  if (status !== undefined) assert.equal(error.status, status);
  assert.ok(error.code.startsWith("upstream_"));
  return true;
};

function mockFetch(t: TestContext, implementation: typeof fetch) {
  globalThis.fetch = implementation;
  // Multiple replacements in one test must all restore the forbidden baseline,
  // not an earlier fixture (node:test cleanup hooks run in registration order).
  t.after(() => { globalThis.fetch = blockedFetch; });
}

function writeFetch(t: TestContext, provider: TransportProvider, reply: () => Promise<Response> | Response) {
  const methods: string[] = [];
  mockFetch(t, async (_input, init) => {
    const method = init?.method || "GET";
    methods.push(method);
    if (provider === "digitalplat" && method === "GET") return Response.json({ success: true, data: [dpExisting] });
    return reply();
  });
  return () => assert.deepEqual(methods, provider === "digitalplat" ? ["GET", "POST"] : ["POST"]);
}

for (const provider of transportProviders) {
  test(`${provider}: header deadline aborts real client reads and writes without a retry`, async t => {
    let signal: AbortSignal | null | undefined;
    let calls = 0;
    mockFetch(t, async (_input, init) => { signal = init?.signal; calls++; return new Promise(() => {}); });
    await assert.rejects(transportFixture(provider, { timeoutMs: 35 }).read(), typed(provider, "request_timeout"));
    assert.equal(signal?.aborted, true);
    assert.equal(calls, 1);
    const check = writeFetch(t, provider, () => new Promise(() => {}));
    await assert.rejects(transportFixture(provider, { timeoutMs: 35 }).write(), typed(provider, "request_timeout"));
    check();
  });

  test(`${provider}: same deadline covers slow body and cancels the reader`, async t => {
    let cancelled = 0;
    const slow = () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("{")); }, cancel() { cancelled++; },
    }));
    mockFetch(t, async () => slow());
    await assert.rejects(transportFixture(provider, { timeoutMs: 35 }).read(), typed(provider, "request_timeout"));
    const check = writeFetch(t, provider, slow);
    await assert.rejects(transportFixture(provider, { timeoutMs: 35 }).write(), typed(provider, "request_timeout"));
    check();
    assert.equal(cancelled, 2);
  });

  test(`${provider}: split UTF-8 codepoints and complete empty lists remain valid`, async t => {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...transportEmptyDomains(provider), message: "你好😀" }));
    mockFetch(t, async () => new Response(new ReadableStream({ start(c) {
      for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
      c.close();
    } })));
    const result = await transportFixture(provider).read();
    assert.deepEqual(Array.isArray(result) ? result : provider === "dnshe" ? result.subdomains : result.zones, []);
  });

  for (const [name, reply, code] of [
    ["streamed size cap", () => new Response("x".repeat(301)), "response_too_large"],
    ["declared size cap", () => new Response("{}", { headers: { "Content-Length": "301" } }), "response_too_large"],
    ["invalid UTF-8", () => new Response(Uint8Array.of(0xff)), "invalid_response"],
    ["truncated UTF-8", () => new Response(Uint8Array.of(0xe4, 0xb8)), "invalid_response"],
    ["non-JSON", () => new Response("<html>challenge</html>", { status: 409 }), provider === "alidns" ? "invalid_response" : "non_json_response"],
    ["network failure", () => { throw new TypeError("https://fixture.invalid?secret=DO_NOT_LEAK"); }, "transport_error"],
    ["broken body", () => new Response(new ReadableStream({ start(c) { c.error(new Error("DO_NOT_LEAK")); } })), "transport_error"],
  ] as const) {
    test(`${provider}: ${name} never causes a second mutation`, async t => {
      const check = writeFetch(t, provider, reply);
      await assert.rejects(transportFixture(provider, { maxResponseBytes: 300 }).write(), error => {
        typed(provider, code)(error);
        assert.doesNotMatch((error as Error).message, /DO_NOT_LEAK|https:\/\//);
        return true;
      });
      check();
    });
  }

  for (const status of [200, 401, 403, 429, 500]) {
    test(`${provider}: HTTP ${status} business errors retain status/code/Retry-After`, async t => {
      const reply = () => Response.json(transportErrorBody(provider, "fixture_denied", "Conflict is not permission to retry"),
        { status, headers: { "Retry-After": "3" } });
      mockFetch(t, async () => reply());
      const checkError = (error: unknown) => {
        typed(provider, "fixture_denied", status)(error);
        const upstream = error as ProviderApiError;
        assert.equal(upstream.retryAfterMs, 3000);
        assert.equal(upstream.statusCode, status === 401 || status === 200 || status === 500 ? 502 : status);
        if (provider === "huaweicloud") {
          assert.ok(error instanceof HuaweiApiError);
          assert.equal(error.httpStatus, status);
          assert.equal(error.code, "upstream_fixture_denied");
          assert.equal(error.rawMessage, "Conflict is not permission to retry");
        }
        return true;
      };
      await assert.rejects(transportFixture(provider).read(), checkError);
      // Huawei explicitly supports conflict merge on 200/400 only; avoid a real
      // conflict phrase in the successful-HTTP fixture for the write assertion.
      const check = writeFetch(t, provider, () => Response.json(transportErrorBody(provider), { status, headers: { "Retry-After": "3" } }));
      await assert.rejects(transportFixture(provider).write(), typed(provider, "fixture_denied", status));
      check();
    });
  }
}

test("Retry-After is strict, finite and supports delta/date/zero/past", () => {
  assert.equal(PROVIDER_TIMEOUT_MS, 20_000);
  assert.equal(PROVIDER_MAX_RESPONSE_BYTES, 4 * 1024 * 1024);
  const now = Date.parse("Sat, 31 Oct 2026 00:00:00 GMT");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter(" 2 ", now), 2000);
  assert.equal(parseRetryAfter("Sat, 31 Oct 2026 00:00:03 GMT", now), 3000);
  assert.equal(parseRetryAfter("Fri, 30 Oct 2026 00:00:00 GMT", now), 0);
  for (const value of [null, "", "-1", "1.5", "NaN", "Infinity", "99999999999999999999", "2026-10-31", "Sun, 31 Oct 2026 00:00:00 GMT", "Tue, 31 Feb 2026 00:00:00 GMT"]) {
    assert.equal(parseRetryAfter(value, now), undefined, String(value));
  }
});

test("helper cleans timers/listeners/reader locks on success and size failure", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const caller = new AbortController();
  const added = t.mock.method(caller.signal, "addEventListener");
  const removed = t.mock.method(caller.signal, "removeEventListener");
  let signal: AbortSignal | null | undefined;
  let body: ReadableStream<Uint8Array>;
  mockFetch(t, async (_input, init) => {
    signal = init?.signal;
    body = new ReadableStream({ start(c) { c.enqueue(Uint8Array.of(65)); c.close(); } });
    return new Response(body);
  });
  assert.equal((await requestProviderText("fixture", "https://fixture.invalid", { signal: caller.signal }, { timeoutMs: 10 })).text, "A");
  assert.equal(body!.locked, false);
  assert.equal(added.mock.callCount(), 1);
  assert.equal(removed.mock.callCount(), 1);
  assert.equal(added.mock.calls[0].arguments[1], removed.mock.calls[0].arguments[1]);
  t.mock.timers.tick(100);
  caller.abort();
  assert.equal(signal?.aborted, false);
  let cancelled = 0;
  body = new ReadableStream({ cancel() { cancelled++; } });
  mockFetch(t, async () => new Response(body, { headers: { "Content-Length": "11" } }));
  await assert.rejects(requestProviderText("fixture", "https://fixture.invalid", {}, { maxResponseBytes: 10 }), typed("fixture", "response_too_large"));
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test("caller cancellation works before fetch and during a pending body", async t => {
  const caller = new AbortController();
  caller.abort();
  let calls = 0;
  mockFetch(t, async () => { calls++; return Response.json({}); });
  await assert.rejects(requestProviderText("fixture", "https://fixture.invalid", { signal: caller.signal }), typed("fixture", "request_cancelled"));
  assert.equal(calls, 0);
  const second = new AbortController();
  let cancelled = 0;
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const body = new ReadableStream<Uint8Array>({ pull() { started(); return new Promise(() => {}); }, cancel() { cancelled++; } });
  mockFetch(t, async () => new Response(body));
  const pending = requestProviderText("fixture", "https://fixture.invalid", { signal: second.signal });
  await reading;
  second.abort();
  await assert.rejects(pending, typed("fixture", "request_cancelled"));
  await sleep(0);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test("late non-cooperative fetch is cancelled without an unhandled rejection", async t => {
  let resolve!: (response: Response) => void;
  let cancelled = 0;
  mockFetch(t, () => new Promise<Response>(r => { resolve = r; }));
  await assert.rejects(requestProviderText("fixture", "https://fixture.invalid", {}, { timeoutMs: 15 }), typed("fixture", "request_timeout"));
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  resolve(new Response(body));
  await sleep(0);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test("DNSHE starts the request deadline after budget reservation and shares 429 cooldown", async t => {
  let release!: () => void;
  let calls = 0;
  const blocks: number[] = [];
  mockFetch(t, async () => { calls++; return Response.json({ success: true }); });
  const budget = { reserve: () => new Promise<void>(r => { release = r; }), block: async (ms: number) => { blocks.push(ms); } };
  const pending = new DNSHEClient("fixture", "fixture", budget, { timeoutMs: 15 }).getQuota();
  await sleep(30);
  assert.equal(calls, 0);
  release();
  await pending;
  budget.reserve = async () => {};
  for (const reply of [() => Response.json({ success: false, error_code: "rate_limited" }, { status: 429, headers: { "Retry-After": "2" } }),
    () => new Response("not json", { status: 429, headers: { "Retry-After": "2" } }),
    () => new Response(new ReadableStream({}), { status: 429, headers: { "Retry-After": "2" } })]) {
    mockFetch(t, async () => reply());
    await assert.rejects(new DNSHEClient("fixture", "fixture", budget, { timeoutMs: 15 }).getQuota(), typed("dnshe", undefined, 429));
  }
  assert.deepEqual(blocks, [2000, 2000, 2000]);
});

test("Huawei GET probes share one total deadline; timeout never probes another host", async t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const hosts: string[] = [];
  mockFetch(t, async (input) => {
    hosts.push(new URL(String(input)).host);
    if (hosts.length === 1) { now += 60; throw new TypeError("fixture network"); }
    return new Promise(() => {});
  });
  const originalTimer = globalThis.setTimeout;
  const timer = t.mock.method(globalThis, "setTimeout", (...args) => originalTimer(...args));
  await assert.rejects(new HuaweiCloudClient("deadline-fixture", "fixture", undefined, { timeoutMs: 80 }).listDomains(), typed("huaweicloud", "request_timeout"));
  assert.deepEqual(hosts, ["dns.myhuaweicloud.com", "dns.cn-north-4.myhuaweicloud.com"]);
  assert.deepEqual(timer.mock.calls.map(c => c.arguments[1]), [80, 20]);
});

test("Huawei retains GET 404 fallback but never resends a failed write to another host", async t => {
  let calls = 0;
  mockFetch(t, async () => ++calls === 1 ? Response.json({ error_code: "not_published", error_msg: "not published" }, { status: 404 })
    : Response.json(transportEmptyDomains("huaweicloud")));
  assert.deepEqual(await new HuaweiCloudClient("read-404-fixture", "fixture").listDomains(), []);
  assert.equal(calls, 2);
  for (const status of [404, 403, 429]) {
    calls = 0;
    mockFetch(t, async () => { calls++; return Response.json(transportErrorBody("huaweicloud", "DNS.0312", "record set exists conflict"), { status }); });
    await assert.rejects(new HuaweiCloudClient(`write-${status}-fixture`, "fixture").createDnsRecord({ zoneId: "zone-1", zoneName: "fixture.example", type: "A", name: "www", content: "192.0.2.2" }), typed("huaweicloud", "DNS.0312", status));
    assert.equal(calls, 1);
  }
});

test("DigitalPlat only readable explicit unsuccessful HTTP 409 permits PATCH", async t => {
  for (const body of ["<html>Conflict</html>", "{", "null", "{}", '{"success":true}', '{"success":false}', '{"success":false,"error":{}}']) {
    const check = writeFetch(t, "digitalplat", () => new Response(body, { status: 409 }));
    await assert.rejects(transportFixture("digitalplat").write(), typed("digitalplat", undefined, 409));
    check();
  }
  const methods: string[] = [];
  mockFetch(t, async (_input, init) => {
    methods.push(init?.method || "GET");
    if (init?.method === "POST") return Response.json({ success: false, error: "Record already exists (409 Conflict)" }, { status: 409 });
    if (init?.method === "PATCH") {
      assert.equal(new Headers(init.headers).get("If-Match"), dpExisting.etag);
      assert.deepEqual(JSON.parse(String(init.body)).values, ["192.0.2.1", "192.0.2.2"]);
      return Response.json({ success: true });
    }
    return Response.json({ success: true, data: [dpExisting] });
  });
  assert.equal((await transportFixture("digitalplat").write()).success, true);
  assert.deepEqual(methods, ["GET", "POST", "PATCH"]);
});

test("DigitalPlat oversized, slow or invalid-UTF8 HTTP 409 never permits a PATCH", async t => {
  for (const reply of [
    () => new Response(JSON.stringify({ success: false, error: "conflict".repeat(100) }), { status: 409 }),
    () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"success":false,')); } }), { status: 409 }),
    () => new Response(Uint8Array.of(0xff), { status: 409 }),
  ]) {
    const check = writeFetch(t, "digitalplat", reply);
    await assert.rejects(transportFixture("digitalplat", { timeoutMs: 20, maxResponseBytes: 300 }).write(), typed("digitalplat", undefined, 409));
    check();
  }
});

test("invalid request limits fail before fetch and fixtures restore the outbound blocker", async () => {
  await assert.rejects(fetch("https://fixture.invalid"), /outbound fetch is forbidden/);
  for (const limits of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 2_147_483_648 }, { maxResponseBytes: -1 }]) {
    await assert.rejects(requestProviderText("fixture", "https://fixture.invalid", {}, limits), /Invalid provider request limits/);
  }
});

test("header time and body time share one deadline instead of resetting it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let deliver!: () => void;
  const headers = new Promise<void>(resolve => { deliver = resolve; });
  let cancelled = 0;
  mockFetch(t, async () => { await headers; return new Response(new ReadableStream({ cancel() { cancelled++; } })); });
  const pending = requestProviderText("fixture", "https://fixture.invalid", {}, { timeoutMs: 35 });
  t.mock.timers.tick(25);
  deliver();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(10);
  await assert.rejects(pending, typed("fixture", "request_timeout"));
  assert.equal(cancelled, 1);
});

test("default streamed cap is 4 MiB, and EOF/204 release resources", async t => {
  mockFetch(t, async () => new Response(new Uint8Array(PROVIDER_MAX_RESPONSE_BYTES + 1)));
  await assert.rejects(requestProviderText("fixture", "https://fixture.invalid", {}), typed("fixture", "response_too_large"));
  mockFetch(t, async () => new Response(null, { status: 204 }));
  assert.equal((await requestProviderText("fixture", "https://fixture.invalid", {})).text, "");
  await new HuaweiCloudClient("204-fixture", "fixture").deleteDnsRecord("zone-1", "record-1");
  const { client } = transportFixture("vercel");
  await client.deleteDnsRecord("fixture.example", "record-1");
});
