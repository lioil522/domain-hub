import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useSilentSync } from "../../frontend/src/features/domains/hooks/useSilentSync";
import { advanceAccount, type SliceState } from "../../frontend/src/lib/sliced-sync";
import { SESSION_KEY, type ApiFetch } from "../../frontend/src/api/client";
import { useDataTransfer } from "../../frontend/src/features/data/hooks/useDataTransfer";

// Real Chromium + React effects; API responses, visibility and sessions are
// synthetic. This fixture never authenticates against a Domain Hub server.
const session = "offline-lifecycle";
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!predicate()) { check(performance.now() < deadline, "fixture condition timed out"); await tick(); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function response(accountId = 1, status = "completed", taskId = `saved-${accountId}`) {
  return Response.json({ success: true, accountId, taskId, status, continuation: status !== "completed", retry_after_ms: 0 });
}
const plan = (ids = [1]) => Response.json({ success: true, enabled: true, nextAfter: null,
  plans: ids.map(accountId => ({ accountId, eligible: true, status: "queued", taskId: `saved-${accountId}`, continuation: true, retry_after_ms: 0 })) });
function visibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
}
function mount(api: ApiFetch, enabled: boolean, complete: (provider?: string) => void, strict = false) {
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  function Capture({ token = session }: { token?: string }) {
    const states = useSilentSync(api, token, enabled, complete);
    return createElement("pre", null, JSON.stringify(states));
  }
  const render = (token = session) => flushSync(() => root.render(strict ? createElement(StrictMode, null, createElement(Capture, { token })) : createElement(Capture, { token })));
  render();
  return { render, unmount: () => { flushSync(() => root.unmount()); element.remove(); } };
}
function mountTransfer(apiFetch: ApiFetch) {
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element), toasts: string[] = []; let refreshes = 0;
  let value!: ReturnType<typeof useDataTransfer>;
  function Capture() {
    value = useDataTransfer({ apiFetch, accountInfo: { username: "offline", two_fa_enabled: false },
      showToast: (type, message) => { toasts.push(`${type}:${message}`); }, setActionLoading() {},
      fetchDomains: () => { refreshes++; }, fetchAccountInfo() {} });
    return null;
  }
  const render = () => flushSync(() => root.render(createElement(Capture)));
  render();
  return { get value() { return value; }, get refreshes() { return refreshes; }, toasts, render,
    change: (fn: () => void) => flushSync(fn), unmount: () => { flushSync(() => root.unmount()); element.remove(); } };
}
const backupFile = () => new File([JSON.stringify({ version: 1, data: { accounts: [] } })], "offline.json");
const previewResponse = () => Response.json({ success: true, diff: { totalAdd: 6, totalUpdate: 0, totalRemove: 0, totalConflicts: 0 } });
const importResponse = () => Response.json({ success: true, imported: { accounts: 6 } });

export async function runLifecycleSuite() {
  const results: { name: string; passed: boolean; error?: string }[] = [];
  async function run(name: string, body: (cleanup: (fn: () => void) => void) => Promise<void>) {
    const cleanup: (() => void)[] = [];
    sessionStorage.setItem(SESSION_KEY, session); visibility("visible");
    try { await body(fn => cleanup.push(fn)); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error instanceof Error ? error.message : "fixture failed" }); }
    finally { cleanup.reverse().forEach(fn => fn()); Reflect.deleteProperty(document, "visibilityState"); sessionStorage.clear(); await tick(); }
  }
  await run("disabled login sync stays local through StrictMode effect cleanup", async cleanup => {
    let plans = 0, steps = 0, completions = 0;
    const ui = mount(async url => { if (url === "/api/sync/plan") { plans++; return plan(); } steps++; return response(); }, false, () => { completions++; }, true);
    cleanup(ui.unmount); await until(() => plans === 2); await tick();
    check(steps === 0 && completions === 0, "disabled sync dispatched a slice");
  });
  await run("five independent account streams do not wait for a slow account", async cleanup => {
    const held = deferred<Response>(); const calls: number[] = []; let completions = 0;
    const ui = mount(async (url, init) => {
      if (url === "/api/sync/plan") return plan([1, 2, 3, 4, 5]);
      const id = Number(url.split("/")[3]); calls.push(id);
      check(JSON.parse(String(init?.body)).taskId === `saved-${id}`, "saved task ID lost");
      return id === 1 ? held.promise : response(id);
    }, true, () => { completions++; });
    cleanup(ui.unmount); cleanup(() => held.resolve(response()));
    await until(() => completions === 4); check(calls.join() === "1,2,3,4,5", "account stream duplicated or blocked");
    held.resolve(response()); await until(() => completions === 5);
  });
  await run("hidden page stops new slices; visible resume pins the stored task", async cleanup => {
    const held = deferred<Response>(); const ids: string[] = []; let plans = 0, completions = 0;
    const ui = mount(async (url, init) => {
      if (url === "/api/sync/plan") { plans++; return plan(); }
      ids.push(JSON.parse(String(init?.body)).taskId);
      return ids.length === 1 ? held.promise : response();
    }, true, () => { completions++; });
    cleanup(ui.unmount); cleanup(() => held.resolve(response(1, "queued")));
    await until(() => ids.length === 1); visibility("hidden"); held.resolve(response(1, "queued"));
    await tick(); await tick(); check(ids.length === 1 && completions === 0, "hidden page advanced or completed");
    visibility("visible"); await until(() => completions === 1);
    check(plans === 2 && ids.join() === "saved-1,saved-1", "resume changed task or repeated a plan");
  });
  await run("logout effect aborts a pending slice and suppresses its late result", async cleanup => {
    const held = deferred<Response>(); let signal: AbortSignal | null | undefined, steps = 0, completions = 0;
    const ui = mount(async (url, init) => {
      if (url === "/api/sync/plan") return plan();
      steps++; signal = init?.signal; return held.promise;
    }, true, () => { completions++; });
    cleanup(ui.unmount); cleanup(() => held.resolve(response()));
    await until(() => steps === 1); sessionStorage.removeItem(SESSION_KEY); ui.render("");
    check(signal?.aborted, "logout did not abort the browser request");
    held.resolve(response()); await tick(); await tick(); check(completions === 0 && steps === 1, "late logout result published");
  });
  await run("unmount/remount fences the old runner without stopping the new session", async cleanup => {
    const held = deferred<Response>(); let steps = 0, completions = 0, oldSignal: AbortSignal | null | undefined;
    const api: ApiFetch = async (url, init) => {
      if (url === "/api/sync/plan") return plan();
      steps++; if (steps === 1) { oldSignal = init?.signal; return held.promise; } return response();
    };
    const first = mount(api, true, () => { completions++; });
    cleanup(() => held.resolve(response()));
    await until(() => steps === 1); first.unmount(); check(oldSignal?.aborted, "cleanup did not abort old request");
    const next = mount(api, true, () => { completions++; }); cleanup(next.unmount);
    await until(() => completions === 1); held.resolve(response()); await tick(); await tick();
    check(completions === 1 && steps === 2, "old runner published or replayed after remount");
  });
  await run("normal known cooldown waits once and continues the same task", async () => {
    const ids: string[] = []; const states: SliceState[] = [];
    const completed = await advanceAccount(async (_url, init) => {
      ids.push(JSON.parse(String(init?.body)).taskId);
      return ids.length === 1 ? Response.json({ success: true, accountId: 1, taskId: "saved-1", status: "paused", continuation: true, retry_after_ms: 20 }) : response();
    }, 1, { session, manual: true, taskId: "saved-1", retryDeadline: Date.now() + 2000, onState: state => states.push(state) });
    check(completed && ids.join() === "saved-1,saved-1" && states.length === 2, "cooldown did not resume exactly once");
  });
  await run("unknown HTTP outcome ends the current stream without slice replay", async cleanup => {
    let steps = 0, completions = 0;
    const ui = mount(async url => { if (url === "/api/sync/plan") return plan(); steps++; return Response.json({ message: "offline unknown outcome" }, { status: 503 }); }, true, () => { completions++; });
    cleanup(ui.unmount); await until(() => document.body.textContent?.includes("offline unknown outcome") === true);
    check(steps === 1 && completions === 0, "unknown outcome was replayed or completed");
  });
  await run("51-account global pool crosses plan pages before the slow first account finishes", async cleanup => {
    const held = deferred<Response>(); let peak = 0, running = 0, completions = 0;
    cleanup(() => held.resolve(response()));
    const ui = mount(async (url, init) => {
      if (url === "/api/sync/plan") {
        const after = JSON.parse(String(init?.body)).after;
        return Response.json({ success: true, enabled: true, nextAfter: after === 50 ? null : after+25,
          plans: Array.from({ length: after === 50 ? 1 : 25 }, (_, n) => ({ accountId: after+n+1, eligible: true, status: "stale" })) });
      }
      const id = Number(url.split("/")[3]); running++; peak = Math.max(peak, running);
      const result = id === 1 ? await held.promise : response(id); running--; return result;
    }, true, () => { completions++; });
    cleanup(ui.unmount); await until(() => completions === 50);
    check(peak <= 25, "pool exceeded global bound"); held.resolve(response()); await until(() => completions === 51);
  });
  await run("migration preview requires separate confirmation and ignores duplicate clicks", async cleanup => {
    const calls: string[] = [], held = deferred<Response>();
    const ui = mountTransfer(async url => { calls.push(url); return url.endsWith("preview") ? held.promise : importResponse(); });
    cleanup(ui.unmount); cleanup(() => held.resolve(previewResponse()));
    ui.change(() => { ui.value.setDataOpOpen(true); ui.value.setSourceAesKey("offline-source-key"); });
    await ui.value.handlePickSnapshotFile(backupFile()); await until(() => ui.value.importSnapshot !== null);
    const first = ui.value.handleImportData(); await ui.value.handleImportData();
    check(calls.join() === "/api/data/preview", "duplicate click dispatched import or preview");
    held.resolve(previewResponse()); await first; await until(() => ui.value.importPreview !== null);
    check(ui.refreshes === 0, "preview refreshed as a successful import");
    await ui.value.handleImportData(); await until(() => !ui.value.dataOpOpen);
    check(calls.join() === "/api/data/preview,/api/data/import" && ui.refreshes === 1, "confirmation did not commit exactly once");
    check(!ui.value.sourceAesKey && !ui.value.importSnapshot && !ui.value.importPreview, "successful import retained secrets");
    check(!Object.values(sessionStorage).includes("offline-source-key") && !Object.values(localStorage).includes("offline-source-key"), "source key persisted");
  });
  await run("source-key changes invalidate migration preview; close clears all sensitive state", async cleanup => {
    const calls: string[] = [], ui = mountTransfer(async url => { calls.push(url); return previewResponse(); }); cleanup(ui.unmount);
    ui.change(() => { ui.value.setDataOpOpen(true); ui.value.setSourceAesKey("offline-first"); });
    await ui.value.handlePickSnapshotFile(backupFile()); await until(() => ui.value.importSnapshot !== null);
    await ui.value.handleImportData(); await until(() => ui.value.importPreview !== null);
    ui.change(() => ui.value.setSourceAesKey("offline-second")); check(ui.value.importPreview === null, "old key preview remained valid");
    await ui.value.handleImportData(); check(calls.every(url => url.endsWith("preview")), "changed key skipped preview");
    ui.change(() => ui.value.setDataOpOpen(false));
    check(!ui.value.sourceAesKey && !ui.value.dataOpToken && !ui.value.importSnapshot && !ui.value.importPreview, "close retained sensitive state");
  });
  await run("unknown migration commit is not replayed or reported as success", async cleanup => {
    const calls: string[] = [], ui = mountTransfer(async url => { calls.push(url); return url.endsWith("preview") ? previewResponse() : Response.json({ success: true }, { status: 503 }); }); cleanup(ui.unmount);
    ui.change(() => ui.value.setDataOpOpen(true));
    await ui.value.handlePickSnapshotFile(backupFile()); await until(() => ui.value.importSnapshot !== null);
    await ui.value.handleImportData(); await until(() => ui.value.importPreview !== null);
    await ui.value.handleImportData(); await until(() => ui.value.importPreview === null);
    check(calls.length === 2 && ui.refreshes === 0 && !ui.toasts.some(t => t.startsWith("success:")), "unknown commit replayed or became success");
  });
  await run("closing migration during a delayed file read fences its late result", async cleanup => {
    const held = deferred<string>(), ui = mountTransfer(async () => { throw new Error("late file must not send"); }); cleanup(ui.unmount);
    ui.change(() => ui.value.setDataOpOpen(true));
    const file = backupFile(); Object.defineProperty(file, "text", { value: () => held.promise });
    const picking = ui.value.handlePickSnapshotFile(file); ui.change(() => ui.value.setDataOpOpen(false));
    held.resolve(await backupFile().text()); await picking; await tick();
    check(ui.value.importSnapshot === null, "late file reopened sensitive state");
  });
  await run("logout during migration preview suppresses late results and clears source key", async cleanup => {
    const held = deferred<Response>(), ui = mountTransfer(async () => held.promise); cleanup(ui.unmount); cleanup(() => held.resolve(previewResponse()));
    ui.change(() => { ui.value.setDataOpOpen(true); ui.value.setSourceAesKey("offline-source-key"); });
    await ui.value.handlePickSnapshotFile(backupFile()); await until(() => ui.value.importSnapshot !== null);
    const pending = ui.value.handleImportData(); sessionStorage.removeItem(SESSION_KEY); ui.render();
    held.resolve(previewResponse()); await pending; await tick();
    check(ui.value.importPreview === null && !ui.value.sourceAesKey && ui.refreshes === 0, "logout published preview or retained key");
  });
  return results;
}

Object.assign(window, { runLifecycleSuite });
