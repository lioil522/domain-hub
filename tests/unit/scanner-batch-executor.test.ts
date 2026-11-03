import assert from "node:assert/strict";
import test from "node:test";
import { runScannerWorkers } from "../../frontend/src/features/scanner/utils/scanner-batch-executor";
import type { ScannerTask } from "../../frontend/src/features/scanner/utils/scanner-batch-planner";
import type { ScanStatus } from "../../frontend/src/features/scanner/utils/scanner-types";

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
