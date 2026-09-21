import assert from "node:assert/strict";
import test from "node:test";
import { chunkScannerTasks, createBatchPlan } from "../../frontend/src/features/scanner/utils/scanner-batch-planner";

test("batch planner creates cross-product tasks and punycodes query domains", () => {
  const result = createBatchPlan({
    seqMode: false,
    seqCharset: "字母",
    seqLength: 2,
    seqStart: "",
    batchRules: "ab,中文",
    excludeChars: "",
    batchLength: 2,
    resolveBank: () => null,
    selectedRoots: ["us.ci", "cn.ci"],
    enableReservedFilter: false,
    reservedPrefixes: [],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.tasks.length, 4);
  assert.equal(result.plan.tasks[0].full, "ab.us.ci");
  assert.notEqual(result.plan.tasks[2].queryFull, result.plan.tasks[2].full);
});

test("batch planner removes reserved prefixes case-insensitively", () => {
  const result = createBatchPlan({
    seqMode: false,
    seqCharset: "字母",
    seqLength: 2,
    seqStart: "",
    batchRules: "abc,Api",
    excludeChars: "",
    batchLength: 2,
    resolveBank: () => null,
    selectedRoots: ["us.ci"],
    enableReservedFilter: true,
    reservedPrefixes: ["api"],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.plan.prefixes, ["abc"]);
  assert.equal(result.warnings.some(w => w.includes("排除 1")), true);
});

test("batch planner reports all-reserved and invalid inputs", () => {
  const allReserved = createBatchPlan({
    seqMode: false,
    seqCharset: "字母",
    seqLength: 2,
    seqStart: "",
    batchRules: "api",
    excludeChars: "",
    batchLength: 2,
    resolveBank: () => null,
    selectedRoots: ["us.ci"],
    enableReservedFilter: true,
    reservedPrefixes: ["API"],
  });
  assert.deepEqual(allReserved, { ok: false, issue: { kind: "all-reserved" } });

  const noRoots = createBatchPlan({
    seqMode: true,
    seqCharset: "数字",
    seqLength: 2,
    seqStart: "",
    batchRules: "",
    excludeChars: "",
    batchLength: 2,
    resolveBank: () => null,
    selectedRoots: [],
    enableReservedFilter: false,
    reservedPrefixes: [],
  });
  assert.deepEqual(noRoots, { ok: false, issue: { kind: "empty-roots" } });
});

test("chunkScannerTasks preserves order and boundaries", () => {
  const tasks = Array.from({ length: 5 }, (_, i) => ({
    sub: String(i), root: "us.ci", full: `${i}.us.ci`, queryFull: `${i}.us.ci`,
  }));
  assert.deepEqual(chunkScannerTasks(tasks, 2).map(chunk => chunk.map(t => t.sub)), [["0", "1"], ["2", "3"], ["4"]]);
  assert.throws(() => chunkScannerTasks(tasks, 0));
});
