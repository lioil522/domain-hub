import assert from "node:assert/strict";
import test from "node:test";
import { sendTelegramNotification, sendWebhookNotification } from "../../src/cron/notification";

const originalFetch = globalThis.fetch;

function mockFetch(response: Response | (() => Promise<Response>)) {
  globalThis.fetch = (async () =>
    typeof response === "function" ? await response() : response
  ) as typeof fetch;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("Telegram HTTP/network failures are returned to the caller", async () => {
  mockFetch(() => Promise.reject(new Error("network unavailable")));

  const result = await sendTelegramNotification("token", "chat", "hello");

  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /无法连接 Telegram API：network unavailable/);
});

test("Telegram API ok=false is treated as a failed delivery", async () => {
  mockFetch(new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden" }), { status: 200 }));

  const result = await sendTelegramNotification("token", "chat", "hello");

  assert.equal(result.ok, false);
  assert.equal(result.status, 200);
  assert.match(result.detail ?? "", /Telegram API 403/);
});

test("Telegram successful API response is reported as success", async () => {
  mockFetch(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));

  const result = await sendTelegramNotification("token", "chat", "hello");

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
});
for (const body of ["proxy says OK", "{broken", "null", "[]", '{"ok":true}', '{"ok":"true","result":{"message_id":1}}']) {
  test(`Telegram cannot accept an unverifiable 200 body: ${body}`, async () => {
    mockFetch(new Response(body));
    const result = await sendTelegramNotification("token", "chat", "hello");
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, true);
  });
}
test("Telegram parses complete JSON before truncating any diagnostic text", async () => {
  mockFetch(Response.json({ ok: false, padding: "x".repeat(2000), error_code: 403, description: "Forbidden" }));
  const result = await sendTelegramNotification("token", "chat", "hello");
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(result.code, "telegram_403");
});
test("Telegram Retry-After respects both HTTP and API delay values", async () => {
  mockFetch(Response.json({ ok: false, error_code: 429, parameters: { retry_after: 120 } }, { status: 429, headers: { "Retry-After": "60" } }));
  const result = await sendTelegramNotification("token", "chat", "hello");
  assert.equal(result.retryable, true);
  assert.equal(result.retryAfterMs, 120000);
});
test("notification response body is bounded and cancelled when too large", async () => {
  let cancelled = false;
  mockFetch(new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(65537)); },
    cancel() { cancelled = true; },
  })));
  const result = await sendTelegramNotification("token", "chat", "hello");
  assert.equal(result.ok, false);
  assert.equal(cancelled, true);
});
test("body read errors never turn into successful Telegram deliveries", async () => {
  mockFetch(new Response(new ReadableStream({ start(controller) { controller.error(new Error("body failed")); } })));
  assert.equal((await sendTelegramNotification("token", "chat", "hello")).ok, false);
});
for (const [type, valid] of [
  ["dingtalk", { errcode: 0 }], ["wecom", { errcode: 0 }], ["feishu", { code: 0 }], ["serverchan", { code: 0, data: { errno: 0 } }],
] as const) {
  test(`${type} requires a numeric platform success acknowledgement`, async () => {
    for (const body of ["OK", "{}", '{"errcode":"0","code":"0"}', '{"errcode":1,"code":1}']) {
      mockFetch(new Response(body));
      assert.equal((await sendWebhookNotification("https://example.test/hook", "hello", type)).ok, false);
    }
    mockFetch(Response.json(valid));
    assert.equal((await sendWebhookNotification("https://example.test/hook", "hello", type)).ok, true);
  });
}
test("legacy Feishu success schema is supported but contradictory fields fail", async () => {
  mockFetch(Response.json({ StatusCode: 0 }));
  assert.equal((await sendWebhookNotification("https://example.test/hook", "hello", "feishu")).ok, true);
  mockFetch(Response.json({ code: 0, StatusCode: 1 }));
  assert.equal((await sendWebhookNotification("https://example.test/hook", "hello", "feishu")).ok, false);
});
test("custom webhook explicitly accepts non-JSON 2xx and carries the stable idempotency key", async () => {
  let headers: Headers | undefined;
  globalThis.fetch = async (_url, init) => { headers = new Headers(init?.headers); assert.equal(init?.redirect, "manual"); return new Response("OK"); };
  assert.equal((await sendWebhookNotification("https://example.test/hook", "hello", "custom", undefined, "stable-key")).ok, true);
  assert.equal(headers?.get("Idempotency-Key"), "stable-key");
});
test("notification diagnostics redact destinations and credentials", async () => {
  mockFetch(() => Promise.reject(new Error("failed https://api.telegram.org/botsecret-bot/sendMessage secret-bot private-chat")));
  const result = await sendTelegramNotification("secret-bot", "private-chat", "hello");
  assert.ok(!result.detail?.includes("secret-bot"));
  assert.ok(!result.detail?.includes("private-chat"));
});
test("abort while consuming a stalled body fails and cancels the response stream", async () => {
  const controller = new AbortController();
  let started!: () => void, cancelled = false;
  const ready = new Promise<void>(resolve => { started = resolve; });
  mockFetch(async () => { started(); return new Response(new ReadableStream({ cancel() { cancelled = true; } })); });
  const sending = sendTelegramNotification("token", "chat", "hello", controller.signal);
  await ready;
  controller.abort();
  assert.equal((await sending).ok, false);
  assert.equal(cancelled, true);
});
test("notification redirects are terminal and are not followed with the secret payload", async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++; assert.equal(init?.redirect, "manual");
    return new Response("", { status: 302, headers: { Location: "https://other.example.test/" } });
  };
  const result = await sendWebhookNotification("https://example.test/private-key", "hello", "custom");
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
});
