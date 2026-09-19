import assert from "node:assert/strict";
import { test } from "node:test";
import { beginDnsSync, finalizeDnsSync, canApplyDestructiveDiff } from "../../src/services/dns-state-machine";

test("DNS state machine keeps failed/unknown syncs from destructive diff", () => {
  assert.equal(beginDnsSync("known"), "syncing");
  assert.equal(finalizeDnsSync([], false).state, "failed");
  assert.equal(finalizeDnsSync([], true).state, "empty");
  assert.equal(finalizeDnsSync([{ id: 1 }], true).state, "known");
  assert.equal(canApplyDestructiveDiff({ state: "syncing", records: [], complete: true }), false);
  assert.equal(canApplyDestructiveDiff({ state: "failed", records: [], complete: true }), false);
  assert.equal(canApplyDestructiveDiff({ state: "known", records: [], complete: false }), false);
  assert.equal(canApplyDestructiveDiff({ state: "known", records: [], complete: true }), true);
});
