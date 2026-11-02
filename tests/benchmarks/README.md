# Offline sliced-sync scale assessment

Run `npm run bench:sync` **in a fresh independent verification copy**, using the
installed dependencies. The optional benchmark is not part of `verify:all`;
timing has no pass/fail threshold. Deterministic query-plan/correctness
regressions run in `test:p1`, and an authenticated HTTP scale test runs in the
existing workerd gate.

Scenarios include five accounts, one/three DNS pages per domain, 20/100/500/1000
domains per account, 1000 unrelated cached domains, two retained generations,
and 75 accounts with 100 historical tasks each. The helper uses production
`syncStep`/`syncPlan`, fresh strict 40/40 budgets and an in-memory SQLite schema.
It checks same-task continuation, distinct upstream page keys, terminal logs,
bounded calls and SQL query plans. It never opens the user's database or uses
credentials. Real outbound fetch is forbidden.

Each synthetic provider method charges one external page operation to the real
counter. It does **not** run provider admission, credentials, transport, HTTP
middleware or rate-limit waits. This is a lower-bound service cost model, not
a measurement of actual DNSHE request limits or network latency. The separate
workerd fixture tests actual client/admission/authentication HTTP paths with
mocked upstream responses.

Receipts and per-query/per-phase observations are retained in a fresh
`sync-scale-*` directory in the approved OpenCode temp directory on Windows
(system temp elsewhere). Counts distinguish D1 API dispatches from SQL
statements within each batch. Transaction-control and diagnostic EXPLAIN
statements are excluded. Returned rows, `runChanges`, SQLite `total_changes`
and allocated pages are **not** cloud rows scanned/written or billable storage.
Local total time includes instrumentation and initial EXPLAIN overhead;
per-query SQL timing excludes EXPLAIN. Node timings are not Workers CPU times.

For before/after comparison, preserve both bundles, manifests and receipts,
assert identical page/call/statement totals and compare query plans first.
Timing depends on JIT, scheduler and fixture shape; do not turn a single local
measurement into a production latency/capacity guarantee. An exact multiple
of 25 accounts intentionally ends with one empty terminal plan page. Scenarios
above 500 slices complete here only by continuing beyond a browser round, not
by raising the production browser bound.
