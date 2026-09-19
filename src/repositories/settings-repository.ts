import type { DatabaseManager } from "../db";

export class SettingsRepository {
  constructor(private readonly db: DatabaseManager) {}
  get(key: string) { return this.db.getSetting(key); }
  set(key: string, value: string) { return this.db.setSetting(key, value); }
  delete(key: string) { return this.db.deleteSetting(key); }
}
