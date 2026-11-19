import assert from "node:assert/strict";
import { test } from "node:test";
import { SummaryRefresh } from "../src/features/domains/utils/summary-refresh";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("twenty refresh callers coalesce into one request without cancelling each other", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [], gate = deferred();
  const queue = new SummaryRefresh(async (signal, force) => { calls.push({ signal, force }); await gate.promise; });
  const promises = Array.from({ length: 20 }, () => queue.request({ invalidate: true }));
  t.mock.timers.tick(25); await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, false);
  const read = queue.request();
  assert.equal(queue.request(), read);
  gate.resolve(); await flush(); await Promise.all(promises);
  queue.dispose();
});

test("mutations during an active read cause exactly one follow-up request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = deferred(), second = deferred(), calls = [];
  const queue = new SummaryRefresh(async (signal, force) => {
    calls.push({ signal, force }); await (calls.length === 1 ? first.promise : second.promise);
  });
  const original = queue.request();
  t.mock.timers.tick(25); await flush();
  const reads = queue.request();
  assert.equal(calls.length, 1);
  const mutations = Array.from({ length: 10 }, () => queue.request({ invalidate: true }));
  first.resolve(); await flush(); await original; await reads;
  t.mock.timers.tick(25); await flush();
  assert.equal(calls.length, 2);
  second.resolve(); await flush(); await Promise.all(mutations);
  queue.dispose();
});

test("operator bypass is preserved when coalescing and disposed scopes never start pending work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [], gate = deferred();
  const queue = new SummaryRefresh(async (signal, force) => { calls.push({ signal, force }); await gate.promise; });
  const one = queue.request(), two = queue.request({ force: true });
  t.mock.timers.tick(25); await flush();
  assert.equal(calls[0].force, true);
  const pending = queue.request({ invalidate: true });
  queue.dispose();
  assert.equal(calls[0].signal.aborted, true);
  await pending;
  gate.resolve(); await flush(); await Promise.all([one, two]);
  t.mock.timers.tick(1000); await flush();
  assert.equal(calls.length, 1);
  await queue.request();
});

test("failed loads settle callers and allow a bounded manual retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const queue = new SummaryRefresh(async () => { calls++; throw new Error("offline"); });
  const first = queue.request(); t.mock.timers.tick(25); await flush(); await first;
  const retry = queue.request({ invalidate: true }); t.mock.timers.tick(25); await flush(); await retry;
  assert.equal(calls, 2);
  queue.dispose();
});
