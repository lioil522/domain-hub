import { resyncAccountsInBackground } from "../../services/account-sync-service";
export async function run(db: Parameters<typeof resyncAccountsInBackground>[0], accountIds: number[]) { return resyncAccountsInBackground(db, accountIds, "auto"); }
