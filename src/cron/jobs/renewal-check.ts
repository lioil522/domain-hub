import { runDailySyncAndRenewal } from "../../cron";
export async function run(db: Parameters<typeof runDailySyncAndRenewal>[0]) { return runDailySyncAndRenewal(db); }
