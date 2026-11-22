import type { DatabaseManager } from "../db";
import type { RequestSecurity } from "../middleware/request-security";

export type Bindings = {
  DB: D1Database;
  AES_KEY?: string;
  WEBHOOK_URL?: string;
  WEBHOOK_TYPE?: string;
  ADMIN_TOKEN?: string;
  SETUP_TOKEN?: string;
  ALLOWED_ORIGIN?: string;
  REQUEST_SECURITY?: RequestSecurity;
  DEFAULT_API_KEY?: string;
  DEFAULT_API_SECRET?: string;
  DEFAULT_API_ALIAS?: string;
  SYNC_QUEUE?: Queue<{ kind: "sync_tick" }>;
};

export type Variables = { db: DatabaseManager };
export type AppEnv = { Bindings: Bindings; Variables: Variables };
