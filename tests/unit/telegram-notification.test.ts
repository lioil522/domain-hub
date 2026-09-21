import assert from "node:assert/strict";
import test from "node:test";
import { sendTelegramNotification } from "../../src/cron/notification";

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
