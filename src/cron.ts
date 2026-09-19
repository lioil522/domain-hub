/**
 * Compatibility facade for the legacy cron implementation.
 * New code should depend on `src/cron/jobs/*` or `src/cron/scheduler.ts`.
 */
export * from "./cron/legacy";
