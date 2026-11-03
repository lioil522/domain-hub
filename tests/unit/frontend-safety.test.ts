import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createApiFetch, SESSION_KEY } from "../../frontend/src/api/client";
import { runScannerWorkers } from "../../frontend/src/features/scanner/utils/scanner-batch-executor";
import { useScannerBatchScan } from "../../frontend/src/features/scanner/hooks/useScannerBatchScan";
import type { ScanLog, ScanStatus, AvailableDomain } from "../../frontend/src/features/scanner/utils/scanner-types";
import type { Account } from "../../frontend/src/types/account";
import { waitForSyncAction, finishSyncAction, ActionWaitError } from "../../frontend/src/lib/sync-action";
import { ApiRequestError } from "../../frontend/src/api/request";
import { scannerPauseReason } from "../../frontend/src/features/scanner/utils/scanner-pause-reason";
import { createElement } from "react";
import { renderToString } from "react-dom/server.browser";
import { advancePlan, advanceAccount, validateSliceState, type SliceState } from "../../frontend/src/lib/sliced-sync";
import { syncStatusText } from "../../frontend/src/lib/sync-status";
import { mergeSyncActions, isExecutingAction } from "../../frontend/src/lib/action-center-state";
import { createLogFeed, mergeLogFeed, startLogPolling, shouldStreamLogs } from "../../frontend/src/lib/log-feed";
import { operationNotification, type OperationEvent } from "../../frontend/src/lib/operation-activity";
import { LogsPage } from "../../frontend/src/features/logs/components/LogsPage";
import type { AppLog } from "../../frontend/src/types/log";
import { createActionFeed } from "../../frontend/src/lib/action-feed";
import { requestTransfer } from "../../frontend/src/features/data/utils/transfer-request";
import { DataOpModal } from "../../frontend/src/features/data/components/DataOpModal";

test("backup transfer explicitly previews without sending import; malformed/HTTP failures never confirm", async () => {
  const calls: string[] = [], body = { snapshot: {}, sourceAesKey: "offline-ephemeral-source" };
  const api = async (url: string) => { calls.push(url); return Response.json({ success: true, diff: { totalAdd: 6, totalUpdate: 0, totalRemove: 0, totalConflicts: 0 } }); };
  const result = await requestTransfer(api, "preview", body);
  assert.equal((result.diff as { totalAdd: number }).totalAdd, 6); assert.deepEqual(calls, ["/api/data/preview"]);
  for (const result of [null, { success: false }, { success: true }, { success: true, diff: { totalAdd: 501, totalUpdate: 0, totalRemove: 0, totalConflicts: 0 } },
    { success: true, diff: { totalAdd: 1, totalUpdate: 1, totalRemove: 0, totalConflicts: 0 } }]) {
    await assert.rejects(requestTransfer(async () => Response.json(result), "preview", body));
  }
  await assert.rejects(requestTransfer(async () => Response.json({ success: true, imported: {} }, { status: 503 }), "import", body));
  await assert.rejects(requestTransfer(async () => Response.json({ success: true }), "import", body));
});

test("backup modal uses ephemeral password input and explicit preview/confirmation wording", () => {
  const props = { open: true, mode: "import" as const, onClose() {}, token: "", onTokenChange() {}, importSnapshot: { name: "offline.json" },
    sourceAesKey: "", onSourceAesKeyChange() {}, importPreview: null, onPickFile() {}, twoFaEnabled: false, busy: false, onExport() {}, onImport() {} };
  const before = renderToString(createElement(DataOpModal, props));
  assert.match(before, /type="password"/); assert.match(before, /autoComplete="off"/i); assert.match(before, /只读预览/);
  assert.match(before, /500行\/8MiB/); assert.doesNotMatch(before, /被备份中的值/);
  const after = renderToString(createElement(DataOpModal, { ...props, importPreview: { totalAdd: 6 } }));
  assert.match(after, /确认追加导入/); assert.match(after, /重新检查/);
});

function renderScanner(options: Parameters<typeof useScannerBatchScan>[0]) {
  let result!: ReturnType<typeof useScannerBatchScan>;
  function Capture() { result = useScannerBatchScan(options); return null; }
  renderToString(createElement(Capture));
  return result;
}

function storage() {
  const values = new Map([[SESSION_KEY, "fixture-session"]]);
  const store = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  return { values, store };
}

function sessionFixture(t: TestContext) {
  const previous = { session: globalThis.sessionStorage, local: globalThis.localStorage };
  t.after(() => { globalThis.sessionStorage = previous.session; globalThis.localStorage = previous.local; });
  const current = storage();
  globalThis.sessionStorage = current.store as Storage;
  globalThis.localStorage = current.store as Storage;
  return current.values;
}

test("disabled silent sync reads all 1000 local account plans without sync-step", async t => {
  sessionFixture(t); let plans = 0, states = 0;
  const done = await advancePlan(async (url, init) => {
    assert.equal(url, "/api/sync/plan"); plans++;
    const { after } = JSON.parse(String(init?.body));
    const rows = Array.from({ length: Math.min(25, 1000 - after) }, (_, i) => ({ accountId: after + i + 1, eligible: false, status: "stale" }));
    return Response.json({ success: true, plans: rows, nextAfter: rows.length === 25 ? after + 25 : null, enabled: false });
  }, { session: "fixture-session", manual: false, localOnly: true, onState: () => states++ });
  assert.equal(done, true); assert.equal(states, 1000); assert.equal(plans, 41);
});

test("sliced browser flow yields cooled account and completes the independent next account", async t => {
  sessionFixture(t); const steps: number[] = [], complete: number[] = [];
  const state = (accountId: number, status: string, retry = 0): SliceState => ({ accountId, taskId: `t${accountId}`, status, continuation: status !== "completed", retry_after_ms: retry });
  const done = await advancePlan(async (url) => {
    if (url === "/api/sync/plan") return Response.json({ success: true, enabled: true, nextAfter: null, plans: [1, 2].map(accountId => ({ accountId, eligible: true, status: "stale" })) });
    const id = Number(url.split("/")[3]); steps.push(id);
    return Response.json({ success: true, ...state(id, id === 1 ? "paused" : "completed", id === 1 ? 60000 : 0) });
  }, { session: "fixture-session", manual: false, onCompleted: s => { complete.push(s.accountId); } });
  assert.equal(done, false); assert.deepEqual(steps, [1, 2]); assert.deepEqual(complete, [2]);
});

test("hidden page and changed session suppress late slice state and completion callbacks", async t => {
  sessionFixture(t);
  const old = Object.getOwnPropertyDescriptor(globalThis, "document");
  const page = { visibilityState: "visible" };
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  t.after(() => { if (old) Object.defineProperty(globalThis, "document", old); else Reflect.deleteProperty(globalThis, "document"); });
  for (const mode of ["hidden", "logout", "cleanup"]) {
    page.visibilityState = "visible"; sessionStorage.setItem(SESSION_KEY, "fixture-session"); let stopped = false, callbacks = 0, calls = 0;
    const done = await advanceAccount(async () => {
      calls++;
      if (mode === "hidden") page.visibilityState = "hidden";
      else if (mode === "logout") sessionStorage.setItem(SESSION_KEY, "replacement");
      else stopped = true;
      return Response.json({ success: true, accountId: 1, taskId: "t", status: "completed", continuation: false, retry_after_ms: 0 });
    }, 1, { session: "fixture-session", manual: true, stopped: () => stopped, onState: () => callbacks++ });
    assert.equal(done, false); assert.equal(calls, 1); assert.equal(callbacks, 0);
  }
});

test("invalid sliced plan IDs/cursors never dispatch upstream slices", async t => {
  sessionFixture(t);
  for (const plans of [[{ accountId: 1, eligible: true, status: "stale" }, { accountId: 1, eligible: true, status: "stale" }], [{ accountId: -1, eligible: true, status: "stale" }]]) {
    let calls = 0;
    await assert.rejects(advancePlan(async () => { calls++; return Response.json({ success: true, enabled: true, plans, nextAfter: null }); }, { session: "fixture-session", manual: true }), /账号无效/);
    assert.equal(calls, 1);
  }
});

test("hung sliced browser request has bounded wait, aborts and does not replay", async t => {
  sessionFixture(t); let calls = 0, signal: AbortSignal | null | undefined;
  await assert.rejects(advanceAccount(async (_url, init) => { calls++; signal = init?.signal; return new Promise<Response>(() => {}); }, 1,
    { session: "fixture-session", manual: true, requestTimeoutMs: 10 }), /未确认完成/);
  assert.equal(calls, 1); assert.equal(signal?.aborted, true);
});

test("slow first account cannot block the independent account streams", async t => {
  sessionFixture(t); const calls: number[] = [], completed: number[] = [];
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  const work = advancePlan(async url => {
    if (url === "/api/sync/plan") return Response.json({ success: true, enabled: true, nextAfter: null, plans: [1, 2, 3, 4, 5].map(accountId => ({ accountId, eligible: true, status: "stale" })) });
    const id = Number(url.split("/")[3]); calls.push(id);
    if (id === 1) await held;
    return Response.json({ success: true, accountId: id, taskId: `t${id}`, status: "completed", continuation: false, retry_after_ms: 0 });
  }, { session: "fixture-session", manual: false, onCompleted: s => { completed.push(s.accountId); } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls, [1, 2, 3, 4, 5]); assert.deepEqual(completed, [2, 3, 4, 5]);
  release(); assert.equal(await work, true);
});

test("cross-page pool admits account 26 before slow account 1 finishes; streams stay globally bounded", async t => {
  sessionFixture(t); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  const calls: number[] = [], pages: number[] = [], completed: number[] = [];
  let inFlight = 0, peak = 0; const perAccount = new Set<number>();
  const work = advancePlan(async (url, init) => {
    if (url === "/api/sync/plan") {
      const after = JSON.parse(String(init?.body)).after; pages.push(after);
      const size = after === 50 ? 1 : 25;
      return Response.json({ success: true, enabled: true, nextAfter: after === 50 ? null : after + 25,
        plans: Array.from({ length: size }, (_, n) => ({ accountId: after + n + 1, eligible: true, status: "stale" })) });
    }
    const id = Number(url.split("/")[3]); assert.equal(perAccount.has(id), false); perAccount.add(id);
    calls.push(id); inFlight++; peak = Math.max(peak, inFlight);
    if (id === 1) await held;
    await Promise.resolve(); inFlight--; perAccount.delete(id);
    return Response.json({ success: true, accountId: id, taskId: `t${id}`, status: "completed", continuation: false, retry_after_ms: 0 });
  }, { session: "fixture-session", manual: false, onCompleted: s => { completed.push(s.accountId); } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(completed.includes(26)); assert.ok(completed.includes(51)); assert.equal(completed.includes(1), false);
  assert.ok(peak <= 25); assert.deepEqual(pages, [0, 25, 50]);
  release(); assert.equal(await work, true); assert.equal(new Set(calls).size, 51); assert.equal(calls.length, 51);
});

test("hung first-page account times out once while later-page errors stay isolated", async t => {
  sessionFixture(t); const calls: number[] = [], errors: number[] = [], completed: number[] = [];
  const done = await advancePlan(async (url, init) => {
    if (url === "/api/sync/plan") {
      const after = JSON.parse(String(init?.body)).after;
      return Response.json({ success: true, enabled: true, nextAfter: after ? null : 25,
        plans: Array.from({ length: after ? 2 : 25 }, (_, n) => ({ accountId: after + n + 1, eligible: true, status: "stale" })) });
    }
    const id = Number(url.split("/")[3]); calls.push(id);
    if (id === 1) return new Promise<Response>(() => {});
    if (id === 26) return Response.json({ message: "isolated" }, { status: 503 });
    return Response.json({ success: true, accountId: id, taskId: `t${id}`, status: "completed", continuation: false, retry_after_ms: 0 });
  }, { session: "fixture-session", manual: false, requestTimeoutMs: 40, onError: id => { errors.push(id!); }, onCompleted: s => { completed.push(s.accountId); } });
  assert.equal(done, false); assert.deepEqual(errors.sort((a,b) => a-b), [1, 26]); assert.ok(completed.includes(27));
  assert.equal(calls.filter(id => id === 1).length, 1); assert.equal(calls.filter(id => id === 26).length, 1);
});

for (const mode of ["abort", "hidden", "logout", "bad-page", "local-only"]) test(`cross-page queued streams stop on ${mode}`, async t => {
  const values = sessionFixture(t), controller = new AbortController();
  const old = Object.getOwnPropertyDescriptor(globalThis, "document"), page = { visibilityState: "visible" };
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  t.after(() => { if (old) Object.defineProperty(globalThis, "document", old); else Reflect.deleteProperty(globalThis, "document"); });
  let steps = 0, late = 0;
  const work = advancePlan(async (url, init) => {
    if (url === "/api/sync/plan") {
      const after = JSON.parse(String(init?.body)).after;
      if (after) {
        if (mode === "abort") controller.abort();
        if (mode === "hidden") page.visibilityState = "hidden";
        if (mode === "logout") values.set(SESSION_KEY, "replacement");
      }
      return Response.json({ success: true, enabled: true, nextAfter: after ? null : 25,
        plans: Array.from({ length: after ? 1 : 25 }, (_, n) => ({ accountId: after && mode === "bad-page" ? 1 : after + n + 1, eligible: true, status: "stale" })) });
    }
    steps++; assert.ok(Number(url.split("/")[3]) <= 25);
    await new Promise(resolve => setTimeout(resolve, 5));
    return Response.json({ success: true, accountId: Number(url.split("/")[3]), taskId: "saved", status: "queued", continuation: true, retry_after_ms: 0 });
  }, { session: "fixture-session", manual: false, signal: controller.signal, localOnly: mode === "local-only", onCompleted: () => { late++; } });
  if (mode === "bad-page") await assert.rejects(work, /账号无效/);
  else assert.equal(await work, mode === "local-only");
  assert.equal(steps, mode === "local-only" ? 0 : 25); assert.equal(late, 0);
});

test("HTTP failure is visible and isolated; the next account completes without replay", async t => {
  sessionFixture(t); const calls: number[] = [], errors: number[] = [], states: SliceState[] = [];
  const done = await advancePlan(async url => {
    if (url === "/api/sync/plan") return Response.json({ success: true, enabled: true, nextAfter: null, plans: [1, 2].map(accountId => ({ accountId, eligible: true, status: "stale" })) });
    const id = Number(url.split("/")[3]); calls.push(id);
    return id === 1 ? Response.json({ message: "offline transport failure" }, { status: 503 }) : Response.json({ success: true, accountId: id, taskId: "t2", status: "completed", continuation: false, retry_after_ms: 0 });
  }, { session: "fixture-session", manual: false, onState: state => states.push(state), onError: id => { errors.push(id!); } });
  assert.equal(done, false); assert.deepEqual(calls, [1, 2]); assert.deepEqual(errors, [1]);
  assert.match(states.find(s => s.client_error)!.client_error!, /offline transport failure/);
  assert.equal(states.some(s => s.accountId === 2 && s.status === "completed"), true);
});

test("manual sync waits known cooldown with login sync disabled and resumes the same task", async t => {
  sessionFixture(t); const ids: unknown[] = [];
  const done = await advancePlan(async (url, init) => {
    if (url === "/api/sync/plan") return Response.json({ success: true, enabled: false, nextAfter: null, plans: [{ accountId: 1, taskId: "saved", eligible: true, status: "queued", continuation: true, retry_after_ms: 0 }] });
    ids.push(JSON.parse(String(init?.body)).taskId);
    return Response.json({ success: true, accountId: 1, taskId: "saved", status: ids.length === 1 ? "paused" : "completed", continuation: ids.length === 1, retry_after_ms: ids.length === 1 ? 10 : 0 });
  }, { session: "fixture-session", manual: true, retryWaitMs: 1000 });
  assert.equal(done, true); assert.deepEqual(ids, ["saved", "saved"]);
});

for (const manual of [true, false]) {
  test(`confirmed budget yield continues the same task with a bounded wait (manual=${manual})`, async t => {
    sessionFixture(t); const ids: string[] = [];
    const done = await advancePlan(async (url, init) => {
      if (url === "/api/sync/plan") return Response.json({ success: true, enabled: !manual, nextAfter: null,
        plans: [{ accountId: 1, taskId: "saved", eligible: true, status: "paused", continuation: true, retry_after_ms: 5, budget_yield: true }] });
      ids.push(JSON.parse(String(init?.body)).taskId);
      return Response.json({ success: true, accountId: 1, taskId: "saved", status: ids.length === 1 ? "paused" : "completed",
        continuation: ids.length === 1, retry_after_ms: ids.length === 1 ? 5 : 0, budget_yield: ids.length === 1 });
    }, { session: "fixture-session", manual, retryWaitMs: 1000 });
    assert.equal(done, true); assert.deepEqual(ids, ["saved", "saved"]);
  });
}

test("three consecutive budget yields stop instead of issuing 500 impossible slices", async t => {
  sessionFixture(t); let calls = 0;
  await assert.rejects(advanceAccount(async () => {
    calls++; return Response.json({ success: true, accountId: 1, taskId: "saved", status: "paused", continuation: true, retry_after_ms: 5, budget_yield: true });
  }, 1, { session: "fixture-session", manual: true }), /连续三个分片预算不足/);
  assert.equal(calls, 3);
});

test("a committed queued slice resets the consecutive budget-yield limit", async t => {
  sessionFixture(t); let calls = 0;
  const done = await advanceAccount(async () => {
    calls++; const yielded = [1, 2, 4, 5].includes(calls);
    return Response.json({ success: true, accountId: 1, taskId: "saved", status: calls === 6 ? "completed" : yielded ? "paused" : "queued",
      continuation: calls !== 6, retry_after_ms: yielded ? 5 : 0, budget_yield: yielded });
  }, 1, { session: "fixture-session", manual: true });
  assert.equal(done, true); assert.equal(calls, 6);
});

test("budget HTTP errors do not retry even when they claim no upstream send", async t => {
  sessionFixture(t); let calls = 0;
  await assert.rejects(advanceAccount(async () => {
    calls++; return Response.json({ success: false, message: "unconfirmed budget pause", error_code: "invocation_budget_exhausted", details: { request_sent: false } }, { status: 503 });
  }, 1, { session: "fixture-session", manual: true }), /unconfirmed budget pause/);
  assert.equal(calls, 1);
});

test("budget yield waiting stops on hidden page, abort, changed session and excessive backoff", async t => {
  const values = sessionFixture(t);
  const old = Object.getOwnPropertyDescriptor(globalThis, "document"); const page = { visibilityState: "visible" };
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  t.after(() => { if (old) Object.defineProperty(globalThis, "document", old); else Reflect.deleteProperty(globalThis, "document"); });
  for (const mode of ["hidden", "abort", "session", "deadline"]) {
    values.set(SESSION_KEY, "fixture-session"); page.visibilityState = "visible";
    const controller = new AbortController(); let calls = 0;
    const work = advanceAccount(async () => {
      calls++; return Response.json({ success: true, accountId: 1, taskId: "saved", status: "paused", continuation: true, retry_after_ms: 1000, budget_yield: true });
    }, 1, { session: "fixture-session", manual: false, signal: controller.signal, retryDeadline: Date.now() + (mode === "deadline" ? 1 : 10000) });
    await new Promise(resolve => setTimeout(resolve, 0));
    if (mode === "hidden") page.visibilityState = "hidden";
    if (mode === "abort") controller.abort();
    if (mode === "session") values.set(SESSION_KEY, "replacement");
    assert.equal(await work, false); assert.equal(calls, 1);
  }
});

test("invalid budget continuation flags are rejected", () => {
  const base: SliceState = { accountId: 1, taskId: "saved", status: "paused", continuation: true, retry_after_ms: 0 };
  assert.throws(() => validateSliceState({ ...base, budget_yield: "true" as unknown as boolean }, 1));
  assert.throws(() => validateSliceState({ ...base, status: "blocked", budget_yield: true }, 1));
  assert.throws(() => validateSliceState({ ...base, continuation: false, budget_yield: true }, 1));
});

test("manual cooldown wait is bounded and abort suppresses all further slices", async t => {
  sessionFixture(t); let calls = 0;
  const api = async () => { calls++; return Response.json({ success: true, accountId: 1, taskId: "saved", status: "paused", continuation: true, retry_after_ms: 10000 }); };
  assert.equal(await advanceAccount(api, 1, { session: "fixture-session", manual: true, retryDeadline: Date.now() + 100 }), false);
  assert.equal(calls, 1);
  const controller = new AbortController();
  const work = advanceAccount(api, 1, { session: "fixture-session", manual: true, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
  assert.equal(await work, false); assert.equal(calls, 2);
});

test("blocked manual restart ignores obsolete cooldown and does not pin the blocked task", async t => {
  sessionFixture(t);
  const done = await advancePlan(async (url, init) => {
    if (url === "/api/sync/plan") return Response.json({ success: true, enabled: false, nextAfter: null, plans: [{ accountId: 1, taskId: "blocked", eligible: true, status: "blocked", continuation: false, retry_after_ms: 300000 }] });
    assert.equal(JSON.parse(String(init?.body)).taskId, undefined);
    return Response.json({ success: true, accountId: 1, taskId: "replacement", status: "completed", continuation: false, retry_after_ms: 0 });
  }, { session: "fixture-session", manual: true });
  assert.equal(done, true);
});

for (const total of [559, 1115]) test(`large account (${total} slices) continues the same task across bounded plan rounds`, async t => {
  sessionFixture(t); let slices = 0, rounds = 0, completed = 0;
  const taskIds: unknown[] = [];
  const api = async (url: string, init?: RequestInit) => {
    if (url === "/api/sync/plan") {
      rounds++;
      return Response.json({ success: true, enabled: true, nextAfter: null, plans: [{ accountId: 1, taskId: "large-saved", eligible: true,
        status: "queued", continuation: true, retry_after_ms: 0, dns_completed: slices }] });
    }
    taskIds.push(JSON.parse(String(init?.body)).taskId); slices++;
    return Response.json({ success: true, accountId: 1, taskId: "large-saved", status: slices === total ? "completed" : "queued",
      continuation: slices !== total, retry_after_ms: 0, dns_completed: slices });
  };
  const options = { session: "fixture-session", manual: false, onCompleted: () => { completed++; } };
  for (let round = 1; round <= Math.ceil(total / 500); round++) {
    const final = round === Math.ceil(total / 500);
    assert.equal(await advancePlan(api, options), final); assert.equal(slices, Math.min(round * 500, total)); assert.equal(completed, final ? 1 : 0);
  }
  assert.equal(rounds, Math.ceil(total / 500));
  assert.ok(taskIds.every(id => id === "large-saved"));
});

test("sync status distinguishes disabled continuation, real progress and failed browser advancement", () => {
  assert.match(syncStatusText({ accountId: 3, status: "queued", continuation: true }, false), /自动同步关闭.*点击同步继续/);
  assert.match(syncStatusText({ accountId: 3, status: "queued", advancing: true, phase: "dns", dns_completed: 2, domain_count: 5 }, false), /正在推进.*DNS 2\/5/);
  assert.match(syncStatusText({ accountId: 3, status: "queued", client_error: "offline" }, true), /页面推进失败/);
  assert.match(syncStatusText({ accountId: 3, status: "paused", retry_after_ms: 60000 }, true), /等待 60 秒/);
});

const feedRow = (id: number): AppLog => ({ id, type: "info", category: "sync", message: `feed-row-${id}`, details: null, created_at: "2026-11-01 22:00:00" });

test("task center merges live slice details once and keeps newer authoritative versions", () => {
  const queued: SliceState = { accountId: 3, taskId: "saved", status: "queued", continuation: true, phase: "dns", dns_completed: 2, domain_count: 5, version: 12, alias: "offline" };
  const items = mergeSyncActions([{ id: "saved", type: "sync", status: "queued", progress: 60, version: 12 }], { 3: { ...queued, advancing: true } });
  assert.equal(items.length, 1); assert.equal(items[0].status, "running"); assert.equal(items[0].progress, 70);
  assert.equal(isExecutingAction(items[0], false), true);
  assert.equal(isExecutingAction(mergeSyncActions([], { 3: queued })[0], false), false, "idle saved checkpoint does not enable live log reads");
  const newer = mergeSyncActions([{ id: "saved", type: "sync", sync_status: "completed", status: "completed", progress: 100, version: 20 }], { 3: queued });
  assert.equal(newer[0].status, "completed"); assert.equal(newer[0].progress, 100);
  assert.equal(isExecutingAction(mergeSyncActions([], { 3: { ...queued, eligible: true } })[0], true), false, "eligible saved checkpoints are not executing tasks");
  assert.equal(isExecutingAction({ ...items[0], advancing: false, executing: false, sync_status: "running" }, true), false, "expired leases do not keep log polling alive");
  assert.equal(mergeSyncActions(newer, { 3: { ...queued, advancing: true } })[0].status, "completed", "old local pending state cannot replace newer terminal authority");
});

test("task reader is single-flight, queues a completion refresh and recovers after StrictMode cleanup", async t => {
  sessionFixture(t);
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } });
  t.after(() => { if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document"); });
  let calls = 0, publications = 0, release!: (response: Response) => void;
  const feed = createActionFeed(async (_url, init) => {
    assert.ok(init?.signal); calls++;
    if (calls === 1) return new Promise<Response>(resolve => { release = resolve; });
    return Response.json({ success: true, actions: [] });
  }, "fixture-session", () => publications++, () => {});
  t.after(feed.stop);
  const first = feed.load(); assert.equal(feed.load(), first); feed.load(true); assert.equal(calls, 1);
  release(Response.json({ success: true, actions: [] })); await first; await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 2); assert.equal(publications, 2);
  feed.stop(); feed.start(); await feed.load(); assert.equal(calls, 3);
});

test("task reader suppresses old-session/hidden/late results and hung reads cannot pin it", async t => {
  const values = sessionFixture(t), page = { hidden: false };
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  t.after(() => { if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document"); });
  let calls = 0, publications = 0, release!: (response: Response) => void;
  const feed = createActionFeed(async () => { calls++; return new Promise<Response>(resolve => { release = resolve; }); }, "fixture-session", () => publications++, () => {}, 15);
  t.after(feed.stop);
  const old = feed.load(); values.set(SESSION_KEY, "replacement"); release(Response.json({ success: true, actions: [] })); await old;
  assert.equal(publications, 0); await feed.load(); assert.equal(calls, 1);
  values.set(SESSION_KEY, "fixture-session"); page.hidden = true; await feed.load(); assert.equal(calls, 1);
  page.hidden = false; await feed.load(); assert.equal(calls, 2);
  const strictOld = feed.load(); feed.stop(); feed.start(); const strictNew = feed.load();
  release(Response.json({ success: true, actions: [] })); await strictOld; await strictNew;
  assert.equal(calls, 4); assert.equal(publications, 1);
});

test("incremental waterfall de-duplicates, preserves row identity and bounds the latest 100", () => {
  const original = [feedRow(2), feedRow(1)];
  const merged = mergeLogFeed(original, [feedRow(3), feedRow(3)]);
  assert.deepEqual(merged.map(log => log.id), [3, 2, 1]); assert.equal(merged[1], original[0]);
  assert.deepEqual(original.map(log => log.id), [2, 1]);
  const burst = mergeLogFeed(merged, Array.from({ length: 200 }, (_, index) => feedRow(index + 4)));
  assert.equal(burst.length, 100); assert.equal(burst[0].id, 203); assert.equal(burst.at(-1)?.id, 104);
});

test("log feed reads only new IDs and never clears the waterfall for an empty delta", async t => {
  sessionFixture(t); const paths: string[] = []; let rows: AppLog[] = [], changes = 0;
  const feed = createLogFeed(async url => {
    paths.push(url);
    return Response.json({ success: true, logs: paths.length === 1 ? [feedRow(5)] : paths.length === 2 ? [feedRow(6)] : [], nextCursor: paths.length === 1 ? 5 : 6 });
  }, "fixture-session", { full: value => { rows = value; }, delta: value => { rows = mergeLogFeed(rows, value); changes++; }, loading: () => {} });
  t.after(feed.stop); await feed.full(); await feed.tail(); await feed.tail();
  assert.deepEqual(paths, ["/api/logs", "/api/logs?after_id=5", "/api/logs?after_id=6"]);
  assert.deepEqual(rows.map(row => row.id), [6, 5]); assert.equal(changes, 1);
});

test("clear/full refresh fences an older delta and changed-session results never publish", async t => {
  const values = sessionFixture(t); let rows: AppLog[] = [], call = 0, release!: (response: Response) => void;
  const feed = createLogFeed(async () => {
    call++;
    if (call === 1) return Response.json({ success: true, logs: [feedRow(1)], nextCursor: 1 });
    if (call === 2) return new Promise<Response>(resolve => { release = resolve; });
    return Response.json({ success: true, logs: [feedRow(10)], nextCursor: 10 });
  }, "fixture-session", { full: value => { rows = value; }, delta: value => { rows = mergeLogFeed(rows, value); }, loading: () => {} });
  t.after(feed.stop); await feed.full();
  const old = feed.tail(); const rejected = assert.rejects(old, /已停止/);
  await feed.full(); release(Response.json({ success: true, logs: [feedRow(2)], nextCursor: 2 })); await rejected;
  assert.deepEqual(rows.map(row => row.id), [10]);
  values.set(SESSION_KEY, "replacement-session"); await feed.tail(); assert.equal(call, 3);
});

test("log polling is sequential and stops immediately when activity ends", async () => {
  assert.equal(shouldStreamLogs("s", true, true, false), false);
  assert.equal(shouldStreamLogs("s", false, true, true), false);
  assert.equal(shouldStreamLogs("s", true, false, true), false);
  assert.equal(shouldStreamLogs(null, true, true, true), false);
  assert.equal(shouldStreamLogs("s", true, true, true), true);
  let calls = 0, release!: () => void;
  const stop = startLogPolling(async signal => { calls++; await new Promise<void>(resolve => { release = resolve; signal.addEventListener("abort", resolve, { once: true }); }); }, 5);
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(calls, 1, "no overlapping reads");
  stop(); release(); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(calls, 1);
});

test("StrictMode log feed cleanup/start recovers but suppresses all late old results", async t => {
  sessionFixture(t); let calls = 0, published = 0;
  const feed = createLogFeed(async () => { calls++; if (calls === 1) return new Promise<Response>(() => {}); return Response.json({ success: true, logs: [feedRow(1)], nextCursor: 1 }); }, "fixture-session", { full: () => { published++; }, delta: () => {}, loading: () => {} });
  const first = feed.full(); const rejected = assert.rejects(first, /已停止/); feed.stop(); feed.start(); await feed.full(); await rejected; feed.stop();
  assert.equal(calls, 2); assert.equal(published, 1);
});

test("log activity ending cancels an in-flight delta, performs one final read then stays idle", async t => {
  sessionFixture(t); let calls = 0, rows: AppLog[] = [];
  const feed = createLogFeed(async (_url, init) => {
    calls++;
    if (calls === 2) return new Promise<Response>(() => {});
    return Response.json({ success: true, logs: [feedRow(calls)], nextCursor: calls });
  }, "fixture-session", { full: value => { rows = value; }, delta: value => { rows = mergeLogFeed(rows, value); }, loading: () => {} });
  t.after(feed.stop); await feed.full();
  const controller = new AbortController(); const delta = feed.tail(controller.signal); const rejected = assert.rejects(delta, /已停止/);
  controller.abort(); await feed.settle(); await rejected;
  assert.equal(calls, 3); assert.deepEqual(rows.map(row => row.id), [3, 1]);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 3);
});

test("log feed rejects malformed deltas, bounds hung reads, and suppresses a late changed-session response", async t => {
  const values = sessionFixture(t); let calls = 0, published = 0, release!: (response: Response) => void;
  const feed = createLogFeed(async () => { calls++; if (calls === 1) return Response.json({ success: true, logs: [feedRow(2)], nextCursor: 1 }); return new Promise<Response>(resolve => { release = resolve; }); }, "fixture-session", { full: () => published++, delta: () => published++, loading: () => {} }, 15);
  t.after(feed.stop); await assert.rejects(feed.full(), /无效/);
  await assert.rejects(feed.tail(), /超时/);
  const old = feed.tail(); values.set(SESSION_KEY, "replacement"); release(Response.json({ success: true, logs: [feedRow(2)], nextCursor: 2 })); await old;
  assert.equal(published, 0); assert.equal(calls, 3);
});

test("local operation events exclude passive reads/plan polling and contain no request data", t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const target = new EventTarget(); Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  t.after(() => { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); });
  const events: OperationEvent[] = []; target.addEventListener("domain-hub:operation", event => events.push((event as CustomEvent<OperationEvent>).detail));
  assert.equal(operationNotification("/api/logs?after_id=1", "GET", "s"), undefined);
  assert.equal(operationNotification("/api/actions", "GET", "s"), undefined);
  assert.equal(operationNotification("/api/sync/plan", "POST", "s"), undefined);
  const notify = operationNotification("/api/accounts/3/sync-step", "POST", "s")!; notify("start"); notify("end");
  assert.deepEqual(events.map(event => event.phase), ["start", "end"]); assert.equal(events[0].id, events[1].id);
  assert.equal(events[0].actionsChanged, false); assert.deepEqual(Object.keys(events[0]).sort(), ["actionsChanged", "id", "phase", "session"]);
});

test("logs table shows newest IDs first and keeps existing rows visible during refresh", () => {
  const logs = [feedRow(2), feedRow(1), feedRow(3)];
  const html = renderToString(createElement(LogsPage, { logs, loadingLogs: true, logCategory: "all", setLogCategory: () => {}, actionLoading: null, onClearLogs: () => {}, streaming: true, onRefreshLogs: () => {} }));
  assert.match(html, /role="log"/); assert.match(html, /实时更新/); assert.match(html, /<table/);
  for (const header of ["时间", "类型", "模块", "描述信息"]) assert.match(html, new RegExp(`<th[^>]*scope="col"[^>]*>${header}</th>`));
  assert.equal((html.match(/<td\b/g) ?? []).length, 12);
  assert.ok(html.indexOf("feed-row-3") < html.indexOf("feed-row-2") && html.indexOf("feed-row-2") < html.indexOf("feed-row-1"));
  assert.deepEqual(logs.map(row => row.id), [2, 1, 3], "display sorting must not mutate feed state");
  assert.match(html, /overflow-x-auto/); assert.doesNotMatch(html, /<ol|<li\b|max-h-\[68vh\]|跟随最新日志/);
  assert.match(html.match(/<button[^>]*aria-label="刷新运行日志"[^>]*>/)?.[0] ?? "", /disabled=""/);
});

test("logs table preserves expandable escaped details, semantic levels and idle refresh controls", () => {
  const logs = ["info", "success", "warning", "error"].map((type, index) => ({ ...feedRow(index + 1), type, details: '<script>unsafe()</script>' }));
  const html = renderToString(createElement(LogsPage, { logs, loadingLogs: false, logCategory: "all", setLogCategory: () => {}, actionLoading: "clear-logs", onClearLogs: () => {}, streaming: false, onRefreshLogs: () => {} }));
  assert.equal((html.match(/<details\b/g) ?? []).length, 4);
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
  for (const tone of ["idle", "ok", "warn", "danger"]) assert.match(html, new RegExp(`bg-state-${tone}-bg`));
  assert.match(html, /空闲 · 自动刷新已停止/);
  assert.doesNotMatch(html.match(/<button[^>]*aria-label="刷新运行日志"[^>]*>/)?.[0] ?? "", /disabled=""/);
  assert.match(html, /disabled=""[^>]*>清空运行日志<\/button>/);
});

test("logs table retains initial loading and empty-category states", () => {
  const props = { logs: [], logCategory: "auth" as const, setLogCategory: () => {}, actionLoading: null, onClearLogs: () => {}, streaming: false, onRefreshLogs: () => {} };
  const loading = renderToString(createElement(LogsPage, { ...props, loadingLogs: true }));
  assert.match(loading, /animate-spin/); assert.doesNotMatch(loading, /<table|该分类下暂无运行日志/);
  const empty = renderToString(createElement(LogsPage, { ...props, loadingLogs: false }));
  assert.match(empty, /该分类下暂无运行日志/); assert.doesNotMatch(empty, /<table/);
});

for (const status of ["completed", "partial", "failed", "cancelled"] as const) {
  test(`frontend sync Action ${status} refreshes cache and shows only the matching result`, async t => {
    sessionFixture(t);
    const levels: string[] = [];
    let refreshed = 0;
    await finishSyncAction(async () => Response.json({ success: true, action: { id: "fixture", status, error: "fixture detail" } }),
      { success: true, actionId: "fixture" }, () => { refreshed++; }, level => { levels.push(level); });
    assert.equal(refreshed, 1);
    assert.equal(levels.at(-1), status === "completed" ? "success" : status === "failed" ? "error" : "warning");
    assert.equal(levels.includes("success"), status === "completed");
  });
}

test("Action polling ignores running cache changes and waits for the correct terminal response", async t => {
  sessionFixture(t);
  let calls = 0;
  const action = await waitForSyncAction(async url => {
    assert.equal(url, "/api/actions/fixture");
    calls++;
    return Response.json({ success: true, action: { id: "fixture", status: calls === 1 ? "running" : "partial" } });
  }, "fixture", { intervalMs: 1 });
  assert.equal(calls, 2);
  assert.equal(action.status, "partial");
});

test("Action polling has a bounded deadline even if an HTTP request never settles", async t => {
  sessionFixture(t);
  let signal: AbortSignal | null | undefined;
  await assert.rejects(waitForSyncAction(async (_, options) => {
    signal = options?.signal;
    return new Promise<Response>(() => {});
  }, "fixture", { timeoutMs: 10 }), error => error instanceof ActionWaitError && error.code === "timeout");
  assert.equal(signal?.aborted, true);
});

test("missing ID, wrong ID, invalid status and HTTP errors never become a successful sync toast", async t => {
  sessionFixture(t);
  const levels: string[] = [];
  const toast = (level: string) => { levels.push(level); };
  await finishSyncAction(async () => { throw new Error("should not poll without ID"); }, { success: true }, () => {}, toast);
  for (const action of [{ id: "wrong", status: "completed" }, { id: "fixture", status: "invalid" }, null]) {
    await finishSyncAction(async () => Response.json({ success: true, action }), { success: true, actionId: "fixture" }, () => {}, toast);
  }
  await finishSyncAction(async () => Response.json({ success: false, message: "fixture read error" }, { status: 503 }),
    { success: true, actionId: "fixture" }, () => {}, toast);
  await assert.rejects(waitForSyncAction(async () => Response.json({}, { status: 503 }), "fixture"), ApiRequestError);
  assert.equal(levels.includes("success"), false);
  assert.equal(levels.filter(level => level === "warning").length, 4);
  assert.equal(levels.at(-1), "error");
});

test("poll response from an old session cannot refresh or notify a new session", async t => {
  const values = sessionFixture(t);
  let refreshed = 0;
  const levels: string[] = [];
  await finishSyncAction(async () => {
    values.set(SESSION_KEY, "replacement-session");
    return Response.json({ success: true, action: { id: "fixture", status: "completed" } });
  }, { success: true, actionId: "fixture" }, () => { refreshed++; }, level => { levels.push(level); });
  assert.equal(refreshed, 0);
  assert.deepEqual(levels, ["info"]);
  await finishSyncAction(async () => { throw new Error("must not poll"); }, { success: true, actionId: "fixture" },
    () => { refreshed++; }, level => { levels.push(level); }, "fixture-session");
  assert.equal(refreshed, 0);
  assert.deepEqual(levels, ["info"]);
});

test("list refresh errors do not emit success or repeat a completed synchronization", async t => {
  sessionFixture(t);
  let refreshed = 0;
  const levels: string[] = [];
  await finishSyncAction(async () => Response.json({ success: true, action: { id: "fixture", status: "completed" } }),
    { success: true, actionId: "fixture" }, () => { refreshed++; throw new Error("fixture refresh failed"); }, level => { levels.push(level); });
  assert.equal(refreshed, 1);
  assert.deepEqual(levels, ["info", "error"]);
});

test("saved account with sync-start warning refreshes without polling or claiming sync completion", async t => {
  sessionFixture(t);
  let refreshed = 0;
  const notices: [string, string][] = [];
  const warning = "账号已保存，但同步任务未能启动；请稍后手动同步";
  await finishSyncAction(async () => { throw new Error("must not poll"); }, { success: true, syncWarning: warning },
    () => { refreshed++; }, (level, message) => { notices.push([level, message]); });
  assert.equal(refreshed, 1);
  assert.deepEqual(notices, [["warning", warning]]);
});

test("business 403 preserves session and response body; explicit expiry clears only the current session", async t => {
  const originalFetch = globalThis.fetch;
  const originalSession = globalThis.sessionStorage;
  const originalLocal = globalThis.localStorage;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.sessionStorage = originalSession; globalThis.localStorage = originalLocal; });
  const { store, values } = storage();
  globalThis.sessionStorage = store as Storage;
  globalThis.localStorage = store as Storage;
  let expired = 0;
  const api = createApiFetch({ backendUrl: "https://test.invalid", onSessionExpired: () => { expired++; } });
  globalThis.fetch = async () => Response.json({ success: false, error_code: "2fa_required" }, { status: 403 });
  assert.equal((await (await api("/api/data/export")).json() as { error_code: string }).error_code, "2fa_required");
  assert.equal(expired, 0);
  assert.equal(values.get(SESSION_KEY), "fixture-session");
  globalThis.fetch = async () => { values.set(SESSION_KEY, "newer-session"); return Response.json({ error_code: "session_expired" }, { status: 401 }); };
  await api("/api/domains");
  assert.equal(expired, 0);
  globalThis.fetch = async () => Response.json({ error_code: "session_expired" }, { status: 401 });
  await api("/api/domains");
  assert.equal(expired, 1);
  assert.equal(values.has(SESSION_KEY), false);
});

test("scanner concurrent checkpoint advances only past contiguous successful tasks; 429 task is retried", async () => {
  const tasks = ["a", "b", "c"].map(sub => ({ sub, root: "us.ci", full: `${sub}.us.ci`, queryFull: `${sub}.us.ci` }));
  let status: ScanStatus = "running";
  let release!: () => void;
  const holdFirst = new Promise<void>(resolve => { release = resolve; });
  const progress: number[] = [];
  const attempts: string[] = [];
  const result = await runScannerWorkers({ tasks, accounts: [null, null], rateLimitMs: 0,
    getStatus: () => status, waitWhilePaused: async () => { status = "running"; },
    shouldSkip: () => false, onTaskClaimed: () => {}, onSkipped: () => {},
    onProgress: index => { progress.push(index); },
    processTask: async item => {
      attempts.push(item.sub);
      if (item.sub === "a") await holdFirst;
      if (item.sub === "b") { assert.equal(progress.includes(2), false); release(); }
      if (item.sub === "c" && attempts.filter(x => x === "c").length === 1) { status = "paused"; return "retry"; }
    },
  });
  assert.equal(result.processedCount, 3);
  assert.equal(attempts.filter(x => x === "c").length, 2);
  assert.equal(progress.at(-1), 3);
});

test("real scanner hook classifies HTTP failures as unknown, not registered", async t => {
  const originalLocal = globalThis.localStorage;
  t.after(() => { globalThis.localStorage = originalLocal; });
  globalThis.localStorage = storage().store as Storage;
  const logs: ScanLog[] = [];
  const ref: { current: ScanStatus } = { current: "idle" };
  const available: AvailableDomain[] = [];
  const warnings: string[] = [];
  const scan = renderScanner({
    apiFetch: async () => Response.json({ success: false, message: "fixture failure" }, { status: 400 }),
    showToast: (kind, message) => { if (kind === "warning") warnings.push(message); },
    dnsheAccounts: [{ id: 1, alias: "fixture" } as Account], batchRules: "", excludeChars: "", batchLength: 1,
    resolveBank: () => null, selectedRoots: ["us.ci"], seqMode: true, seqCharset: "数字", seqLength: 1,
    seqStart: "9", enableReservedFilter: false, reservedPrefixes: [], ignorePool: true,
    scanControlRef: ref, setScanStatus: () => {}, setScanProgress: () => {}, availableDomainsList: available,
    setAvailableDomainsList: () => {}, setScanLogs: update => { if (typeof update === "function") logs.splice(0, logs.length, ...update(logs)); },
    setScanCursor: () => {}, scanCursorRef: { current: { lastCandidate: "", taskIndex: 0, checked: 0 } },
  });
  await scan.handleStartBatchScan();
  assert.equal(logs.some(log => log.status === "registered"), false);
  assert.equal(logs.some(log => log.status === "error"), true);
  assert.equal(warnings.length, 1);
  assert.equal(ref.current, "completed");
});

test("scanner distinguishes exact local admission/cooldown/budget, upstream limits, quota and unknown 429", () => {
  for (const [code, label] of [["upstream_scheduler_busy", "本地服务商并发名额已满"],
    ["upstream_scheduler_cooldown", "共享冷却"], ["upstream_rate_limited", "本地 DNSHE 请求预算"],
    ["upstream_rate_limit_exceeded", "上游 DNSHE API"], ["quota_exceeded", "配额不足"]]) {
    assert.ok(scannerPauseReason(429, { error_code: code })?.includes(label));
  }
  assert.match(scannerPauseReason(429, { error_code: "unknown", details: { retry_after_ms: 2100 } })!, /来源尚未确认.*3 秒/);
  for (const value of [-1, 1.5, "3000", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(scannerPauseReason(429, { details: { retry_after_ms: value } })!.includes("建议"), false);
  }
  assert.equal(scannerPauseReason(403, { error_code: "rate_limit_exceeded_suffix", message: "rate limit / quota" }), null);
  assert.equal(scannerPauseReason(200, { success: true }), null);
});

test("real scanner hook pauses on local contention once, logs the earliest unfinished checkpoint and sends no queued work", async t => {
  sessionFixture(t);
  const logs: ScanLog[] = [];
  const warnings: string[] = [];
  const ref: { current: ScanStatus } = { current: "idle" };
  const cursor = { current: { lastCandidate: "", taskIndex: 0, checked: 0 } };
  const calls: string[] = [];
  let release!: () => void;
  const holdFirst = new Promise<void>(resolve => { release = resolve; });
  t.after(() => { ref.current = "idle"; release(); });
  const scan = renderScanner({
    apiFetch: async url => {
      const sub = new URL(url, "https://fixture.invalid").searchParams.get("domain")!.split(".")[0];
      calls.push(sub);
      if (sub === "5") { await holdFirst; return Response.json({ success: true, whois: { success: true, registered: true } }); }
      return Response.json({ success: false, error_code: "upstream_scheduler_busy", details: { retry_after_ms: 1000 } }, { status: 429 });
    },
    showToast: (kind, text) => { if (kind === "warning") warnings.push(text); },
    dnsheAccounts: [1, 2, 3, 4, 5].map(id => ({ id, alias: `fixture-${id}` })) as Account[],
    batchRules: "", excludeChars: "", batchLength: 1, resolveBank: () => null, selectedRoots: ["us.ci"],
    seqMode: true, seqCharset: "数字", seqLength: 1, seqStart: "5", enableReservedFilter: false, reservedPrefixes: [], ignorePool: true,
    scanControlRef: ref, setScanStatus: () => {}, setScanProgress: () => {}, availableDomainsList: [], setAvailableDomainsList: () => {},
    setScanLogs: update => { if (typeof update === "function") logs.splice(0, logs.length, ...update(logs)); },
    setScanCursor: () => {}, scanCursorRef: cursor,
  });
  const running = scan.handleStartBatchScan();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ref.current, "paused");
  assert.deepEqual(calls, ["5", "6", "7", "8", "9"]);
  assert.equal(cursor.current.lastCandidate, "5");
  assert.equal(cursor.current.taskIndex, 0);
  assert.match(logs.find(log => log.status === "error")!.text, /本地服务商并发名额已满.*断点已保存至 5/);
  assert.equal(logs.some(log => log.text.includes("触发 API 限流/配额上限")), false);
  assert.equal(warnings.length, 1);
  ref.current = "idle";
  release();
  await running;
  assert.deepEqual(calls, ["5", "6", "7", "8", "9"]);
});

test("real scanner hook cancels pending WHOIS requests on manual pause without sending more candidates", async t => {
  sessionFixture(t);
  const ref: { current: ScanStatus } = { current: "idle" };
  const signals: AbortSignal[] = [];
  const scan = renderScanner({
    apiFetch: async (_url, init) => {
      const signal = init!.signal!;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled fixture")), { once: true }));
    },
    showToast: () => {}, dnsheAccounts: [1, 2].map(id => ({ id, alias: `fixture-${id}` })) as Account[],
    batchRules: "", excludeChars: "", batchLength: 1, resolveBank: () => null, selectedRoots: ["us.ci"],
    seqMode: true, seqCharset: "数字", seqLength: 1, seqStart: "5", enableReservedFilter: false, reservedPrefixes: [], ignorePool: true,
    scanControlRef: ref, setScanStatus: () => {}, setScanProgress: () => {}, availableDomainsList: [], setAvailableDomainsList: () => {},
    setScanLogs: () => {}, setScanCursor: () => {}, scanCursorRef: { current: { lastCandidate: "5", taskIndex: 0, checked: 0 } },
  });
  const running = scan.handleStartBatchScan();
  await new Promise(resolve => setTimeout(resolve, 0));
  scan.pauseScan();
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
  ref.current = "idle";
  await running;
  assert.equal(signals.length, 2);
});

test("real scanner hook isolates a credential cooldown and retains its unfinished checkpoint while another account succeeds", async t => {
  sessionFixture(t);
  const ref: { current: ScanStatus } = { current: "idle" };
  const cursor = { current: { lastCandidate: "", taskIndex: 0, checked: 0 } };
  const calls: string[] = [];
  const logs: ScanLog[] = [];
  const scan = renderScanner({
    apiFetch: async url => {
      const id = new URL(url, "https://fixture.invalid").searchParams.get("account_id")!;
      calls.push(id);
      return id === "1" ? Response.json({ error_code: "upstream_scheduler_cooldown",
        details: { details: { scope: "dnshe_key", request_sent: false }, retry_after_ms: 60_000 } }, { status: 429 })
        : Response.json({ success: true, whois: { success: true, registered: true } });
    },
    showToast: () => {}, dnsheAccounts: [1, 2].map(id => ({ id, alias: `fixture-${id}` })) as Account[],
    batchRules: "", excludeChars: "", batchLength: 1, resolveBank: () => null, selectedRoots: ["us.ci"],
    seqMode: true, seqCharset: "数字", seqLength: 1, seqStart: "8", enableReservedFilter: false, reservedPrefixes: [], ignorePool: true,
    scanControlRef: ref, setScanStatus: () => {}, setScanProgress: () => {}, availableDomainsList: [], setAvailableDomainsList: () => {},
    setScanLogs: update => { if (typeof update === "function") logs.splice(0, logs.length, ...update(logs)); },
    setScanCursor: () => {}, scanCursorRef: cursor,
  });
  await scan.handleStartBatchScan();
  assert.deepEqual(calls, ["1", "2"]);
  assert.equal(ref.current, "completed");
  assert.equal(cursor.current.taskIndex, 0);
  assert.equal(cursor.current.lastCandidate, "8");
  assert.ok(logs.some(log => log.text.includes("其他账号继续")));
  assert.equal(logs.filter(log => log.status === "registered").length, 1);
});
