import type { DatabaseManager } from "../db";

export type Bindings = {
  DB: D1Database;
  AES_KEY?: string;
  WEBHOOK_URL?: string;
  WEBHOOK_TYPE?: string;
  ADMIN_TOKEN?: string;
  ALLOWED_ORIGIN?: string;
  DEFAULT_API_KEY?: string;
  DEFAULT_API_SECRET?: string;
  DEFAULT_API_ALIAS?: string;
};

export type Variables = { db: DatabaseManager };
export type AppEnv = { Bindings: Bindings; Variables: Variables };
