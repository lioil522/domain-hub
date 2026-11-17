import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { runScannerWorkers } from "../../frontend/src/features/scanner/utils/scanner-batch-executor";
import { classifyScannerResponse, retryAfterMs } from "../../frontend/src/features/scanner/utils/scanner-response";
import { captureScannerPlan, isScanCursorV2, restoreScannerPlan } from "../../frontend/src/features/scanner/utils/scanner-checkpoint";
import { loadScanCursor, saveScanCursor, clearScanCursor } from "../../frontend/src/features/scanner/utils/scanner-storage";
import { BrowserScannerRun } from "../../frontend/src/features/scanner/utils/scanner-browser-run";
import { scannerJsonRequest } from "../../frontend/src/features/scanner/utils/scanner-request";
import { primeScannerSkipPool } from "../../frontend/src/features/scanner/utils/scanner-batch-pool";
import type { ScanCursorV2, ScanStatus, ScannerExecutorCheckpoint, AvailableDomain } from "../../frontend/src/features/scanner/utils/scanner-types";
import type { ScannerTask } from "../../frontend/src/features/scanner/utils/scanner-batch-planner";

const task = (sub: string): ScannerTask => ({ sub, root: "us.ci", full: `${sub}.us.ci`, queryFull: `${sub}.us.ci` });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const captured = captureScannerPlan({
    seqMode: false, seqCharset: "字母", seqLength: 2, seqStart: "", batchRules: "aa,bb",
    excludeChars: "", batchLength: 2, resolveBank: () => null, selectedRoots: ["us.ci", "cn.mt"],
    enableReservedFilter: false, reservedPrefixes: [], ignorePool: true,
  });
  assert.ok(captured.result.ok);
  const cursor: ScanCursorV2 = {
    version: 2, backend: "/", plan: captured.plan, total: 4, taskIndex: 0, checked: 0,
    completedAhead: [], availableDomains: [], failedIndices: [], savedAt: "test",
    seqMode: false, charset: "字母", length: 2, lastCandidate: "aa",
  };
  return { cursor, tasks: captured.result.plan.tasks };
}
function storage(t: TestContext) {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const fake = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: fake });
  t.after(() => { if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); });
  return fake;
}

test("scanner accepts only explicit boolean registration results on successful responses", () => {
  assert.deepEqual(classifyScannerResponse(200, { success: true, whois: { registered: false } }), { kind: "available" });
  assert.deepEqual(classifyScannerResponse(200, { success: true, whois: { registered: true } }), { kind: "registered" });
  for (const payload of [null, {}, { success: false, whois: { registered: false } }, { success: true, whois: { success: false, registered: false } }, { success: true, whois: { success: "false", registered: false } }, { success: true, whois: { registered: "false" } }]) {
    assert.equal(classifyScannerResponse(200, payload).kind, "retry");
  }
  assert.equal(classifyScannerResponse(503, { success: true, whois: { registered: false } }).kind, "retry");
});

test("Retry-After supports seconds, dates, invalid values and a bounded wait", () => {
  assert.equal(retryAfterMs("3"), 3000);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:00:05 GMT", 1000), 4000);
  assert.equal(retryAfterMs("invalid"), 1200);
  assert.equal(retryAfterMs("999999999"), 86400000);
  assert.equal(classifyScannerResponse(429, null, "3").kind, "retry");
});

test("out-of-order results do not advance the contiguous checkpoint past an in-flight task", async () => {
  const slow = deferred<void>();
  const ahead = deferred<ScannerExecutorCheckpoint>();
  const promise = runScannerWorkers({
    tasks: [task("aa"), task("bb")], accounts: [null, null], rateLimitMs: 0, getStatus: () => "running",
    shouldSkip: () => false, onTaskClaimed() {}, onSkipped() {},
    processTask: async item => { if (item.sub === "aa") await slow.promise; },
    onCheckpoint: checkpoint => { if (checkpoint.completedAhead.includes(1)) ahead.resolve(checkpoint); },
  });
  const checkpoint = await ahead.promise;
  assert.equal(checkpoint.nextIndex, 0);
  assert.equal(checkpoint.completedCount, 1);
  slow.resolve();
  assert.equal((await promise).nextIndex, 2);
});

test("resuming a hole does not repeat later tasks that already completed", async () => {
  const checked: string[] = [];
  const result = await runScannerWorkers({
    tasks: [task("aa"), task("bb"), task("cc")], accounts: [null], rateLimitMs: 0, getStatus: () => "running",
    resume: { nextIndex: 0, completedAhead: [1], completedCount: 1 },
    shouldSkip: () => false, onTaskClaimed() {}, onSkipped() {}, processTask: async item => { checked.push(item.sub); },
  });
  assert.deepEqual(checked, ["aa", "cc"]);
  assert.equal(result.completedCount, 3);
  assert.equal(result.nextIndex, 3);
});

test("retry is requeued, respects its delay, and is counted only once", async () => {
  let clock = 0, attempts = 0;
  const starts: number[] = [];
  const result = await runScannerWorkers({
    tasks: [task("aa")], accounts: [null], rateLimitMs: 1200, getStatus: () => "running", now: () => clock,
    sleep: async ms => { clock += ms; }, shouldSkip: () => false, onTaskClaimed() {}, onSkipped() {},
    processTask: async () => { starts.push(clock); return ++attempts === 1 ? { kind: "retry", retryAfterMs: 5000 } : { kind: "completed" }; },
  });
  assert.deepEqual(starts, [0, 5000]);
  assert.equal(result.completedCount, 1);
});

test("early timer wakeups are rechecked against the monotonic lane deadline", async () => {
  let clock = 0, early = true;
  const starts: number[] = [];
  await runScannerWorkers({
    tasks: [task("aa"), task("bb"), task("cc")], accounts: [null], rateLimitMs: 1200, getStatus: () => "running",
    now: () => clock, sleep: async ms => { clock += early ? ms / 2 : ms; early = false; },
    shouldSkip: () => false, onTaskClaimed() {}, onSkipped() {}, processTask: async () => { starts.push(clock); },
  });
  assert.deepEqual(starts, [0, 1200, 2400]);
});

test("aborting while paused drains workers without advancing unresolved tasks", async () => {
  const controller = new AbortController();
  let status: ScanStatus = "running";
  const result = await runScannerWorkers({
    tasks: [task("aa"), task("bb")], accounts: [null], rateLimitMs: 0, signal: controller.signal,
    getStatus: () => status, shouldSkip: () => false, onTaskClaimed() {}, onSkipped() {},
    processTask: async () => { status = "paused"; controller.abort(); return { kind: "retry" }; },
  });
  assert.equal(result.completedCount, 0);
  assert.equal(result.nextIndex, 0);
});

test("invalid or contradictory checkpoints are rejected before claiming work", async () => {
  await assert.rejects(() => runScannerWorkers({
    tasks: [task("aa"), task("bb")], accounts: [null], rateLimitMs: 0, getStatus: () => "running",
    resume: { nextIndex: 0, completedAhead: [1], completedCount: 99 },
    shouldSkip: () => false, onTaskClaimed: () => assert.fail("Invalid claim"), onSkipped() {}, processTask: async () => {},
  }), /checkpoint/);
});

test("captured word banks and root order survive edits and serialize deterministically", () => {
  const words = ["aa", "bb"];
  const captured = captureScannerPlan({ ...fixture().cursor.plan, batchRules: "{bank}", resolveBank: () => words });
  assert.ok(captured.result.ok);
  const original = captured.result.plan.tasks.map(item => item.full);
  words.splice(0, words.length, "changed");
  const cursor = { ...fixture().cursor, plan: captured.plan, total: original.length };
  assert.deepEqual(restoreScannerPlan(cursor).tasks.map(item => item.full), original);
});

test("checkpoint validation rejects an advancing but inconsistent cursor", () => {
  const { cursor } = fixture();
  assert.ok(isScanCursorV2(cursor));
  assert.equal(isScanCursorV2({ ...cursor, taskIndex: 3, checked: 1 }), false);
  assert.equal(isScanCursorV2({ ...cursor, completedAhead: [0] }), false);
  assert.equal(isScanCursorV2({ ...cursor, failedIndices: [99] }), false);
});

test("checkpoint persistence is isolated by backend and preserves results", t => {
  storage(t);
  const { cursor } = fixture();
  const one = { ...cursor, backend: "https://one.example", availableDomains: [{ fullDomain: "aa.us.ci", subdomain: "aa", rootdomain: "us.ci", time: "now" }] };
  const two = { ...cursor, backend: "https://two.example" };
  saveScanCursor(one); saveScanCursor(two);
  assert.deepEqual(loadScanCursor("https://one.example/"), JSON.parse(JSON.stringify(one)));
  clearScanCursor("https://one.example");
  assert.equal(loadScanCursor("https://one.example"), null);
  assert.deepEqual(loadScanCursor("https://two.example"), JSON.parse(JSON.stringify(two)));
});

test("storage failures leave the last valid checkpoint intact", t => {
  const fake = storage(t);
  const { cursor } = fixture();
  saveScanCursor(cursor);
  t.mock.method(fake, "setItem", () => { throw new Error("quota exceeded"); });
  assert.throws(() => saveScanCursor({ ...cursor, taskIndex: 1, checked: 1 }));
  assert.equal((loadScanCursor() as ScanCursorV2).taskIndex, 0);
});

test("browser runner labels malformed 429 as unknown and preserves Retry-After and the unresolved task", { timeout: 3000 }, async t => {
  const { cursor } = fixture();
  let status: ScanStatus = "running";
  let saved: ScanCursorV2 | undefined;
  const available: AvailableDomain[] = [];
  const run = new BrowserScannerRun({
    apiFetch: async () => new Response("<html>rate limited</html>", { status: 429, headers: { "Retry-After": "30" } }),
    accounts: [], tasks: [task("aa")], plan: { ...cursor.plan, selectedRoots: ["us.ci"], batchRules: "aa" }, backend: "/",
    available: [], getStatus: () => status, isCurrent: () => true,
    onAvailable: item => available.push(item), onProgress() {}, onLog() {},
    onPause: () => { status = "paused"; },
    onCheckpoint: checkpoint => { if (checkpoint.failedIndices.length) { saved = checkpoint; run.abort(); } },
    rateLimitMs: 0,
  });
  t.after(() => run.abort());
  await run.start();
  assert.equal(available.length, 0);
  assert.equal(saved?.checked, 0);
  assert.equal(saved?.taskIndex, 0);
  assert.ok(saved?.retryUntil && saved.retryUntil > Date.now() + 25000);
});

test("a superseded browser run cannot append late available results or checkpoints", { timeout: 3000 }, async t => {
  const { cursor } = fixture();
  const oldResponse = deferred<Response>();
  const started = deferred<void>();
  const results: string[] = [];
  let current: BrowserScannerRun;
  const create = (sub: string, fetch: () => Promise<Response>) => new BrowserScannerRun({
    apiFetch: async () => fetch(), accounts: [], tasks: [task(sub)], plan: { ...cursor.plan, selectedRoots: ["us.ci"], batchRules: sub },
    backend: "/", available: [], getStatus: () => "running", isCurrent: () => current === runFor(sub),
    onAvailable: item => results.push(item.fullDomain), onProgress() {}, onLog() {}, onPause() {}, onCheckpoint() {}, rateLimitMs: 0,
  });
  let old: BrowserScannerRun, next: BrowserScannerRun;
  const runFor = (sub: string) => sub === "old" ? old : next;
  old = create("old", () => { started.resolve(); return oldResponse.promise; });
  next = create("new", async () => Response.json({ success: true, whois: { registered: false } }));
  t.after(() => { old.abort(); next.abort(); });
  current = old;
  const previous = old.start();
  await started.promise;
  current = next;
  await next.start();
  oldResponse.resolve(Response.json({ success: true, whois: { registered: false } }));
  await previous;
  assert.deepEqual(results, ["new.us.ci"]);
});

test("scanner requests time out and cancellation propagates to the underlying fetch", async () => {
  const fake = async (_url: string, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
  });
  await assert.rejects(() => scannerJsonRequest(fake, "/api/test", {}, undefined, 5), /超时/);
  const controller = new AbortController();
  const pending = scannerJsonRequest(fake, "/api/test", {}, controller.signal);
  controller.abort();
  await assert.rejects(() => pending);
});

test("skip-pool prefetch is bounded and ignores unrequested registered domains", { timeout: 3000 }, async () => {
  let active = 0, maximum = 0;
  const done = deferred<void>();
  const skip = await primeScannerSkipPool({
    tasks: [task("aa"), task("bb"), task("cc")], batchSize: 1,
    apiFetch: async (_url, options) => {
      active++; maximum = Math.max(maximum, active);
      await Promise.resolve();
      const domains = JSON.parse(String(options?.body)).domains;
      active--;
      return Response.json({ success: true, registered: [...domains, "unrequested.example"] });
    },
    onFailure: error => assert.fail(String(error)), onBackgroundComplete: () => done.resolve(),
  });
  await done.promise;
  assert.equal(maximum, 1);
  assert.equal(skip.size, 3);
  assert.equal(skip.has("unrequested.example"), false);
});

test("browser refresh resumes all unfinished roots without repeating completed-ahead tasks", { timeout: 3000 }, async t => {
  const { cursor, tasks } = fixture();
  const known = { fullDomain: tasks[0].full, subdomain: tasks[0].sub, rootdomain: tasks[0].root, time: "before-refresh" };
  const restored: ScanCursorV2 = { ...cursor, taskIndex: 1, checked: 2, completedAhead: [3], failedIndices: [1], availableDomains: [known] };
  const queried: string[] = [];
  const run = new BrowserScannerRun({
    apiFetch: async url => { queried.push(new URL(url, "http://localhost").searchParams.get("domain")!); return Response.json({ success: true, whois: { registered: false } }); },
    accounts: [], tasks: restoreScannerPlan(restored).tasks, plan: restored.plan, backend: "/", restored, available: [],
    getStatus: () => "running", isCurrent: () => true, onAvailable() {}, onProgress() {}, onLog() {}, onPause() {}, onCheckpoint() {}, rateLimitMs: 0,
  });
  t.after(() => run.abort());
  await run.start();
  assert.deepEqual(queried, [tasks[1].queryFull, tasks[2].queryFull]);
  assert.equal(run.snapshot().checked, 4);
  assert.equal(run.snapshot().availableDomains.length, 3);
  assert.deepEqual(run.snapshot().failedIndices, []);
});

test("a manually resumed rate-limited task is retried rather than skipped or counted twice", { timeout: 3000 }, async t => {
  const { cursor } = fixture();
  let calls = 0;
  let status: ScanStatus = "running";
  const run = new BrowserScannerRun({
    apiFetch: async () => ++calls === 1 ? Response.json({ success: false }, { status: 429, headers: { "Retry-After": "0" } }) : Response.json({ success: true, whois: { registered: false } }),
    accounts: [], tasks: [task("aa")], plan: { ...cursor.plan, selectedRoots: ["us.ci"], batchRules: "aa" }, backend: "/", available: [],
    getStatus: () => status, isCurrent: () => true, onAvailable() {}, onProgress() {}, onLog() {},
    onPause: () => { status = "paused"; }, onCheckpoint: checkpoint => { if (checkpoint.failedIndices.length) status = "running"; }, rateLimitMs: 0,
  });
  t.after(() => run.abort());
  await run.start();
  assert.equal(calls, 2);
  assert.equal(run.snapshot().checked, 1);
  assert.equal(run.snapshot().availableDomains.length, 1);
});

test("a failed skip-pool request reports failure once and does not launch all remaining chunks", async () => {
  let requests = 0, failures = 0;
  const skip = await primeScannerSkipPool({
    tasks: [task("aa"), task("bb"), task("cc")], batchSize: 1,
    apiFetch: async () => { requests++; return Response.json({ success: false, message: "pool unavailable" }, { status: 503 }); },
    onFailure: () => { failures++; }, onBackgroundComplete: () => assert.fail("False pool success"),
  });
  assert.equal(requests, 1);
  assert.equal(failures, 1);
  assert.equal(skip.size, 0);
});

test("cross-product task budget is checked before materializing a huge task array", () => {
  const captured = captureScannerPlan({
    ...fixture().cursor.plan, seqMode: true, seqCharset: "数字", seqLength: 4,
    selectedRoots: Array.from({ length: 31 }, (_, i) => `root${i}.ci`), resolveBank: () => null,
  });
  assert.deepEqual(captured.result, { ok: false, issue: { kind: "too-many-tasks", limit: 300000 } });
});
