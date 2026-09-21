# Domain Hub 2.0 — Architecture Guardrails

## Layering

```text
App / routes
    ↓
features / route orchestration
    ↓
services
    ↓
repositories / provider adapters
    ↓
database / external provider clients
```

UI components should not own database access or provider client construction. Route modules should delegate business operations to services.

## Controller rule

`frontend/src/app/useAppControllerView.tsx` is an orchestration boundary, not a feature implementation. New feature logic belongs under `frontend/src/features/**` or a dedicated controller hook.

The architecture checker fails if this controller grows beyond 110 KB.

## Database rule

`src/db/database-manager.ts` plus `src/db/dao/**` is the only database implementation. The former monolithic `src/db/legacy.ts` must not return.

## Provider rule

Provider-specific DNS behavior belongs under `src/providers/dns/**` and is selected through the provider adapter registry. New providers should not be instantiated directly by route handlers.

## Performance rule

Page components are registered through `frontend/src/app/pages.ts` and loaded lazily. Large result sets should use pagination or virtualization rather than rendering unbounded lists.

## Change discipline

Before merging a refactor, run:

```bash
npm run check:architecture
npm run verify:all
```

For frontend-only changes:

```bash
npm --prefix frontend run typecheck
npm --prefix frontend run build
```
