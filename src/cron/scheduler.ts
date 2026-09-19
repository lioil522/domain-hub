import type { DatabaseManager } from "../db";
import { runDailySyncAndRenewal } from "./jobs/daily-sync";

export interface CronJobContext {
  db: DatabaseManager;
}

export interface CronJob {
  id: string;
  run(context: CronJobContext): Promise<void>;
}

/** Explicit job registry; new jobs can be added without changing the Worker entrypoint. */
export const cronJobs: readonly CronJob[] = [
  {
    id: "daily-sync",
    async run({ db }) {
      await runDailySyncAndRenewal(db);
    },
  },
];

export async function runCronJob(id: string, context: CronJobContext): Promise<void> {
  const job = cronJobs.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`Unknown cron job: ${id}`);
  await job.run(context);
}
