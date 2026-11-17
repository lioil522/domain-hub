import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createApiFetch, SESSION_KEY } from "../../frontend/src/api/client";

function installStorage(t: TestContext) {
  const storage = new Map<string, string>();
  for (const property of ["sessionStorage", "localStorage"]) {
    const original = Object.getOwnPropertyDescriptor(globalThis, property);
    Object.defineProperty(globalThis, property, { configurable: true, value: {
      getItem: (key: string) => storage.get(`${property}:${key}`) ?? null,
      setItem: (key: string, value: string) => storage.set(`${property}:${key}`, value),
      removeItem: (key: string) => storage.delete(`${property}:${key}`),
    } });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, property, original);
      else Reflect.deleteProperty(globalThis, property);
    });
  }
  sessionStorage.setItem(SESSION_KEY, "local-session");
  return storage;
}

test("business 401 and 403 preserve sessions and leave the response body readable", async t => {
  installStorage(t);
  let expired = 0;
  const api = createApiFetch({ backendUrl: "/", onSessionExpired: () => expired++ });
  for (const [status, error_code] of [[401, "invalid_credentials"], [401, "invalid_2fa"], [403, "2fa_required"], [403, "forbidden"]] as const) {
    t.mock.method(globalThis, "fetch", async () => Response.json({ success: false, error_code }, { status }));
    const response = await api("/api/data/export");
    assert.equal((await response.json()).error_code, error_code);
    assert.equal(sessionStorage.getItem(SESSION_KEY), "local-session");
    assert.equal(expired, 0);
    t.mock.restoreAll();
  }
});

test("explicit session expiry clears both session stores exactly once", async t => {
  installStorage(t);
  localStorage.setItem(SESSION_KEY, "legacy-session");
  let expired = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: false, error_code: "session_expired" }, { status: 401 }));
  const api = createApiFetch({ backendUrl: "/", onSessionExpired: () => expired++ });
  await api("/api/accounts");
  assert.equal(sessionStorage.getItem(SESSION_KEY), null);
  assert.equal(localStorage.getItem(SESSION_KEY), null);
  assert.equal(expired, 1);
});

test("same-origin API works without a baked-in backend address", async t => {
  installStorage(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ success: true }));
  const api = createApiFetch({ backendUrl: "", onSessionExpired() {} });
  await api("/api/auth/status");
  assert.equal(fetch.mock.calls[0].arguments[0], "/api/auth/status");
});

test("explicit backend URL preserves request method, caller headers and Bearer token", async t => {
  installStorage(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ success: true }));
  const api = createApiFetch({ backendUrl: "https://backend.example/", onSessionExpired() {} });
  await api("/api/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, "https://backend.example/api/accounts");
  assert.equal(options?.method, "POST");
  assert.equal(new Headers(options?.headers).get("Content-Type"), "application/json");
  assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer local-session");
});

test("non-JSON authentication errors do not masquerade as session expiry", async t => {
  installStorage(t);
  t.mock.method(globalThis, "fetch", async () => new Response("<html>proxy error</html>", { status: 401 }));
  const api = createApiFetch({ backendUrl: "/", onSessionExpired() { assert.fail("Unexpected logout"); } });
  const response = await api("/api/accounts");
  assert.equal(await response.text(), "<html>proxy error</html>");
  assert.equal(sessionStorage.getItem(SESSION_KEY), "local-session");
});
