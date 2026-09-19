import type { DatabaseManager } from "../db";

/** Cache abstraction. Policy belongs to callers; storage belongs to DatabaseManager. */
export class CacheService {
  constructor(private readonly db: DatabaseManager) {}

  get(key: string) { return this.db.getCache(key); }
  set(key: string, value: string, ttlSeconds?: number) { return this.db.setCache(key, value, ttlSeconds); }
  delete(key: string) { return this.db.deleteCache(key); }
  async getOrSet<T>(key: string, loader: () => Promise<T>, ttlSeconds?: number): Promise<T> {
    const cached = await this.get(key);
    if (cached !== null) {
      try { return JSON.parse(cached) as T; } catch { /* corrupt cache: recover from source */ }
    }
    const value = await loader();
    await this.set(key, JSON.stringify(value), ttlSeconds);
    return value;
  }
}
