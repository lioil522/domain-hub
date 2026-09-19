import type { DatabaseManager } from "../db";

export class CacheRepository {
  constructor(private readonly db: DatabaseManager) {}
  get(key: string) { return this.db.getCache(key); }
  set(key: string, value: string, ttlSeconds?: number) { return this.db.setCache(key, value, ttlSeconds); }
  delete(key: string) { return this.db.deleteCache(key); }
}
