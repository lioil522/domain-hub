# Domain Hub 2.0 — Refactor Phase 2

## Baseline

This phase starts from the verified Domain Hub 2.0 optimized-fixed baseline.
The required invariant is that business/API/database behavior remains unchanged and each migration can be validated independently.

## Completed in this phase

### 1. Extract line-DNS orchestration

Moved the Settings/shared line-DNS state and operations from `frontend/src/app/useAppControllerView.tsx` into:

- `frontend/src/features/dns/hooks/useLineDnsSettings.ts`

The hook owns:

- configurable NS suffix list
- local NS mirror
- learned line-capable roots
- root NS lookup batching
- line-support inference
- line suffix CRUD/restore actions
- learned-root cleanup
- Settings-page NS refresh action
- known-root aggregation

The existing DNSHE-account guard is preserved: root NS lookup is skipped when there is no DNSHE account.

### 2. Extract global alert/log presentation state

Moved alert badge state and log-category filtering into:

- `frontend/src/app/controller/useAppAlerts.ts`

This keeps the main controller focused on orchestration rather than notification presentation state.

### 3. Controller size reduction

`useAppControllerView.tsx` is now below 80 KB and remains the composition/orchestration layer.

The architecture check continues to enforce a 110 KB hard ceiling to prevent regression into another God Hook.

## Validation

The structural architecture check passes after the refactor:

- App.tsx: 9 lines
- route modules: 19
- registered route declarations: 74
- status: PASS

The full frontend build must be run in a clean environment after dependency installation. This working environment did not retain a complete frontend `node_modules` tree after an interrupted dependency reinstall, so this phase does not claim a local frontend build result here.

## Next migration target

The next controlled extraction should focus on the Scanner feature:

- `RegisterPage.tsx`
- `useScanner.ts`

The target is to separate UI composition, scanner orchestration/state, and pure domain transformations without changing the scanner API contract or persistence behavior.
