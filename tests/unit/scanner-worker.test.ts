import assert from "node:assert/strict";
import { test } from "node:test";
import { runScannerStep } from "../../src/scanner/engine/worker";

function fakeStore(initial: any) {
  let current = initial;
  return {
    async get() { return current; },
    async save(next: any) { current = next; },
    getCurrent() { return current; },
  };
}

test("scanner persists cursor and pauses between slices", async () => {
  const store = fakeStore({ id: "job-1", status: "created", cursor: "0", totalChecked: 0, available: 0, registered: 0, failed: 0, startedAt: "now" });
  const next = await runScannerStep(store as any, "job-1", async (cursor) => ({ cursor: String(Number(cursor) + 10), checked: 10, available: 2, registered: 3, failed: 0, done: false }));
  assert.equal(next.status, "paused");
  assert.equal(next.cursor, "10");
  assert.equal(next.totalChecked, 10);
});
