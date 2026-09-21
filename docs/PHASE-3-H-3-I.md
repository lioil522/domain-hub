# Domain Hub 2.0 — Phase 3-H / 3-I / 3-J

## Scanner batch boundaries

- `scanner-batch-planner.ts` owns candidate generation, reserved-prefix filtering, task expansion, and chunking.
- `scanner-batch-pool.ts` owns duplicate-pool priming and background pool completion.
- `scanner-batch-executor.ts` owns worker scheduling, pause/idle handling, task claiming, skip decisions, and per-account rate limiting.
- `useScannerBatchScan.ts` remains the React integration layer for API calls, state updates, persistence, and user feedback.
- Architecture checks prevent the planning/execution responsibilities from collapsing back into the hook.

## Dependency direction

`UI -> useScanner -> Scanner capability hooks -> pure Scanner utilities / API boundaries`

React state setters remain at the hook boundary; planning, pool batching, and worker scheduling remain framework-agnostic.
