import { DatabaseManager } from "../db";

export class LogRepository {
  constructor(private readonly db: DatabaseManager) {}

  write(type: Parameters<DatabaseManager["writeLog"]>[0], category: Parameters<DatabaseManager["writeLog"]>[1], message: string, details?: unknown) {
    return this.db.writeLog(type, category, message, details);
  }

  list(limit = 100, categories?: string[]) {
    return this.db.getLogs(limit, categories);
  }

  clear() {
    return this.db.clearLogs();
  }
}
