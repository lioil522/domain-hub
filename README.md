# Domain Hub 2.0 — Direct Execution Workspace

This archive is a continuation of the Domain Hub 2.0 architecture migration.

Current candidate: v8

Key verified predecessor: v7 Windows/Wrangler runtime validation passed for frontend build, Worker boot, auth, accounts, domains, DNS reads, quota, logs, settings, custom groups, date overrides and expiry.

v8 continues the migration by moving account synchronization/bootstrap and quota aggregation out of `src/index.ts` into dedicated services. Full v8 typecheck/build/runtime verification remains pending and is intentionally not represented as completed.


### Current checkpoint: v10

- Root NS discovery is DNSHE-account gated to avoid useless DoH traffic before DNSHE is configured.
- Backend `/api/dns/ns` enforces the same gate for direct callers.
- HuaweiCloudClient is explicitly imported in account background sync.
