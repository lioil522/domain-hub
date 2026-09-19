import type { DatabaseManager } from "../db";

export class DnsRepository {
  constructor(private readonly db: DatabaseManager) {}

  getCache(key: string) {
    return this.db.getCache(key);
  }

  setCache(key: string, value: string, ttlSeconds?: number) {
    return this.db.setCache(key, value, ttlSeconds);
  }

  deleteCache(key: string) {
    return this.db.deleteCache(key);
  }
}
