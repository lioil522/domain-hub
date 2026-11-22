import assert from "node:assert/strict";
import { test } from "node:test";
import { act, create } from "react-test-renderer";
import { useAuthSession } from "../src/features/auth/hooks/useAuthSession";
import { LoginPage } from "../src/features/auth/components/LoginPage";

const TOKEN = "isolated-frontend-owner-setup-token";
function storage(t) {
  const values = new Map();
  for (const name of ["sessionStorage", "localStorage"]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: {
      getItem: key => values.get(`${name}:${key}`) ?? null,
      setItem: (key, value) => values.set(`${name}:${key}`, value),
      removeItem: key => values.delete(`${name}:${key}`),
    } });
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : Reflect.deleteProperty(globalThis, name));
  }
  return values;
}
async function view(t, configured = true, reject = false) {
  const values = storage(t), calls = [];
  let auth, tree;
  function Harness() {
    auth = useAuthSession({ sessionToken: null, setSessionToken() {}, showToast() {}, backendUrl: "",
      apiFetch: async (route, init) => {
        calls.push({ route, init });
        if (route.endsWith("/status")) return Response.json({ success: true, initialized: false, setup_token_configured: configured });
        return reject
          ? Response.json({ success: false, error_code: "setup_unauthorized", message: "wrong token" }, { status: 401 })
          : Response.json({ success: true, session_token: "new-session" });
      } });
    return <LoginPage auth={auth} toast={null} />;
  }
  await act(async () => { tree = create(<Harness />); });
  t.after(async () => { await act(async () => tree.unmount()); });
  return { values, calls, tree, auth: () => auth };
}
test("setup UI blocks missing/unconfigured owner authorization before issuing requests", async t => {
  const loaded = await view(t, false);
  assert.equal(loaded.tree.root.findAllByType("button").find(button => button.props.type === "submit").props.disabled, true);
  await act(async () => loaded.auth().handleSetup());
  assert.equal(loaded.calls.filter(call => call.route.endsWith("/setup")).length, 0);
  assert.ok(loaded.auth().loginError.includes("SETUP_TOKEN"));
});
test("setup authorization stays only in memory, is sent in the header and cleared on success", async t => {
  const loaded = await view(t);
  await act(async () => {
    loaded.auth().setSetupUsername("admin");
    loaded.auth().setSetupPassword("test-password");
    loaded.auth().setSetupPassword2("test-password");
    loaded.auth().setSetupToken(TOKEN);
  });
  await act(async () => loaded.auth().handleSetup());
  const request = loaded.calls.find(call => call.route.endsWith("/setup"));
  assert.equal(new Headers(request.init.headers).get("Authorization"), `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(request.init.body), { username: "admin", password: "test-password" });
  assert.equal(loaded.auth().setupToken, "");
  assert.equal(loaded.auth().authInitialized, true);
  assert.ok([...loaded.values.values()].every(value => value !== TOKEN));
});
test("rejected setup preserves the uninitialized state without persisting its owner token", async t => {
  const loaded = await view(t, true, true);
  await act(async () => {
    loaded.auth().setSetupUsername("admin");
    loaded.auth().setSetupPassword("test-password");
    loaded.auth().setSetupPassword2("test-password");
    loaded.auth().setSetupToken(TOKEN);
  });
  await act(async () => loaded.auth().handleSetup());
  assert.equal(loaded.auth().authInitialized, false);
  assert.ok(loaded.auth().loginError.includes("wrong token"));
  assert.ok([...loaded.values.values()].every(value => value !== TOKEN));
});
