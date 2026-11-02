import assert from "node:assert/strict";
import test from "node:test";
import { runScannerWorkers } from "../../frontend/src/features/scanner/utils/scanner-batch-executor";
import type { ScannerTask } from "../../frontend/src/features/scanner/utils/scanner-batch-planner";
import type { ScanStatus } from "../../frontend/src/features/scanner/utils/scanner-types";
import { scannerAccountPauseReason } from "../../frontend/src/features/scanner/utils/scanner-pause-reason";

const task = (sub: string): ScannerTask => ({ sub, root: "us.ci", full: `${sub}.us.ci`, queryFull: `${sub}.us.ci` });

async function tick() { await new Promise(resolve => setTimeout(resolve, 0)); }

test("executor distributes tasks across workers and preserves all task claims", async () => {
  const statusBox: { value: ScanStatus } = { value: "running" };
  const claimed: string[] = [];
  const getStatus = () => statusBox.value;
  const processed: string[] = [];
  const result = await runScannerWorkers({
    tasks: [task("a"), task("b"), task("c"), task("d")],
    accounts: [null, null],
    rateLimitMs: 0,
    getStatus,
    waitWhilePaused: async () => { while (getStatus() === "paused") await tick(); },
    shouldSkip: item => item.sub === "b",
    onTaskClaimed: item => claimed.push(item.sub),
    onSkipped: item => processed.push(`skip:${item.sub}`),
    processTask: async item => { processed.push(item.sub); },
  });
  assert.deepEqual(claimed.sort(), ["a", "b", "c", "d"]);
  assert.deepEqual(processed.sort(), ["a", "c", "d", "skip:b"].sort());
  assert.equal(result.skippedCount, 1);
  assert.equal(result.processedCount, 4);
});

test("executor stops cleanly when status becomes idle", async () => {
  const statusBox: { value: ScanStatus } = { value: "running" };
  const processed: string[] = [];
  await runScannerWorkers({
    tasks: [task("a"), task("b"), task("c")],
    accounts: [null],
    rateLimitMs: 0,
    getStatus: () => statusBox.value,
    waitWhilePaused: async () => {},
    shouldSkip: () => false,
    onTaskClaimed: () => {},
    onSkipped: () => {},
    processTask: async item => { processed.push(item.sub); statusBox.value = "idle"; },
  });
  assert.deepEqual(processed, ["a"]);
});

test("five account pipelines run independently without a shared two-slot bottleneck", async () => {
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = runScannerWorkers({ tasks: ["a", "b", "c", "d", "e"].map(task),
    accounts: [null, null, null, null, null], rateLimitMs: 0,
    getStatus: () => "running", waitWhilePaused: async () => {}, shouldSkip: () => false,
    onTaskClaimed: () => {}, onSkipped: () => {},
    processTask: async () => { active++; peak = Math.max(peak, active); await gate; active--; },
  });
  await tick();
  const before = active;
  release();
  const result = await running;
  assert.equal(before, 5);
  assert.equal(peak, 5);
  assert.equal(result.processedCount, 5);
});

test("queued accounts do not claim after stop; in-flight calls may still finish", async () => {
  let status: ScanStatus = "running";
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const claimed: string[] = [];
  const progress: number[] = [];
  const running = runScannerWorkers({ tasks: ["a", "b", "c", "d", "e", "f", "g", "h"].map(task),
    accounts: [null, null, null, null, null], rateLimitMs: 0,
    getStatus: () => status, waitWhilePaused: async () => {}, shouldSkip: () => false,
    onTaskClaimed: item => { claimed.push(item.sub); }, onSkipped: () => {},
    onProgress: index => { progress.push(index); },
    processTask: async () => { await hold; },
  });
  await tick();
  status = "idle";
  release();
  const result = await running;
  assert.deepEqual(claimed, ["a", "b", "c", "d", "e"]);
  assert.equal(result.processedCount, 5);
  assert.equal(progress.at(-1), 5);
});

test("independent lanes retain each account's minimum start interval", async () => {
  const accounts = [1, 2, 3, 4, 5].map(id => ({ id })) as import("../../frontend/src/types/account").Account[];
  const starts = new Map<number, number[]>();
  await runScannerWorkers({ tasks: Array.from({ length: 15 }, (_, i) => task(`a${i}`)), accounts, rateLimitMs: 20,
    getStatus: () => "running", waitWhilePaused: async () => {}, shouldSkip: () => false,
    onTaskClaimed: () => {}, onSkipped: () => {},
    processTask: async (_task, account) => {
      const list = starts.get(account!.id) || [];
      list.push(Date.now());
      starts.set(account!.id, list);
    },
  });
  assert.equal(starts.size, 5);
  for (const list of starts.values()) assert.ok(list.slice(1).every((at, i) => at - list[i] >= 20));
});

test("1000 account lanes start independently and a slow first lane retains the earliest unfinished frontier", async () => {
  const accounts = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1 })) as import("../../frontend/src/types/account").Account[];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sent = 0;
  let frontier = -1;
  const running = runScannerWorkers({ tasks: accounts.map(acc => task(`a${acc.id}`)), accounts, rateLimitMs: 0,
    getStatus: () => "running", waitWhilePaused: async () => {}, shouldSkip: () => false,
    onTaskClaimed: () => {}, onSkipped: () => {}, onProgress: n => { frontier = n; },
    processTask: async (_task, account) => { sent++; if (account?.id === 1) await gate; },
  });
  await tick();
  assert.equal(sent, 1000);
  assert.equal(frontier, 0);
  release();
  await running;
  assert.equal(frontier, 1000);
});

test("credential-scoped pause stops only its lane, keeps failed frontier and never automatically retries", async () => {
  const accounts = [1, 2].map(id => ({ id })) as import("../../frontend/src/types/account").Account[];
  const sends: number[] = [];
  let frontier = -1;
  await runScannerWorkers({ tasks: Array.from({ length: 10 }, (_, i) => task(`a${i}`)), accounts: [accounts[0], accounts[0], accounts[1]], rateLimitMs: 0,
    getStatus: () => "running", waitWhilePaused: async () => {}, shouldSkip: () => false,
    onTaskClaimed: () => {}, onSkipped: () => {}, onProgress: n => { frontier = n; },
    processTask: async (_task, account) => { sends.push(account!.id); if (account?.id === 1) return "account-paused"; },
  });
  assert.equal(sends.filter(n => n === 1).length, 1);
  assert.equal(sends.filter(n => n === 2).length, 9);
  assert.equal(frontier, 0);
});

test("only exact nested credential scope permits isolated pause; unknown/global limits remain conservative", () => {
  assert.match(scannerAccountPauseReason(429, { error_code: "upstream_scheduler_cooldown", details: { details: { scope: "dnshe_key" } } })!, /当前账号凭据冷却/);
  assert.equal(scannerAccountPauseReason(429, { error_code: "upstream_scheduler_cooldown", details: { details: { scope: "deployment_provider" } } }), null);
  assert.equal(scannerAccountPauseReason(429, { error_code: "unknown" }), null);
  assert.equal(scannerAccountPauseReason(502, { error_code: "upstream_transport_error", details: { details: { scope: "dnshe_key" } } }), null);
});
