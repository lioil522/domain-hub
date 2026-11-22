import { setTimeout as delay } from "node:timers/promises";

interface StartupSqlite {
  exec(sql: string): void;
  prepare(sql: string): { get(): Record<string, unknown> | undefined };
}
interface StartupWait {
  timeoutMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}
const SQLITE_BUSY = 5;
const BUSY_TIMEOUT_MS = 5000;
function isBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ERR_SQLITE_ERROR" &&
    "errcode" in error && typeof error.errcode === "number" && (error.errcode & 0xff) === SQLITE_BUSY;
}

/** Only for a fresh writable connection outside a transaction, before D1/HTTP. */
export async function configureSqliteStartup(sqlite: StartupSqlite, options: StartupWait = {}): Promise<void> {
  const timeout = options.timeoutMs ?? BUSY_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > BUSY_TIMEOUT_MS) throw new Error("Invalid SQLite startup wait budget");
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? (async ms => { await delay(ms); });
  const deadline = now() + timeout;
  for (;;) {
    // Keep each native busy wait inside the remaining wall-clock budget too.
    sqlite.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.floor(deadline - now()))}`);
    try {
      const mode = sqlite.prepare("PRAGMA journal_mode").get()?.journal_mode;
      if (mode !== "wal") sqlite.exec("PRAGMA journal_mode = WAL");
      if (sqlite.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") {
        throw new Error("SQLite did not accept WAL mode; refusing to start");
      }
      break;
    } catch (error) {
      const remaining = deadline - now();
      if (!isBusy(error) || remaining <= 0) throw error;
      // SQLite can return BUSY without invoking its busy handler during a lock
      // upgrade. exec() finalizes the failed PRAGMA; yield before retrying this
      // idempotent setup operation, never a migration, cipher check or API write.
      await wait(Math.min(25, remaining));
    }
  }
  sqlite.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  sqlite.exec("PRAGMA synchronous = NORMAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
}
