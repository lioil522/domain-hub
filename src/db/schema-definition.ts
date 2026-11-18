/**
 * Authoritative schema for Workers and Node. Append migrations when changing it;
 * schema.sql is a generated fresh-database snapshot, never an upgrade script.
 */
function table(name: string, columns: string[], constraints: string[] = []) {
  return {
    name,
    columns: columns.map(column => column.split(" ")[0]),
    sql: `CREATE TABLE IF NOT EXISTS ${name} (\n    ${[...columns, ...constraints].join(",\n    ")}\n)`,
  };
}

export const SCHEMA_TABLES = [
  table("accounts", [
    "id INTEGER PRIMARY KEY AUTOINCREMENT", "alias TEXT NOT NULL",
    "api_key TEXT NOT NULL UNIQUE", "api_secret TEXT NOT NULL",
    "provider TEXT NOT NULL DEFAULT 'dnshe'", "website TEXT",
    "created_at DATETIME DEFAULT CURRENT_TIMESTAMP",
  ]),
  table("domains_cache", [
    "id INTEGER PRIMARY KEY", "account_id INTEGER NOT NULL",
    "subdomain TEXT NOT NULL", "rootdomain TEXT NOT NULL", "full_domain TEXT NOT NULL",
    "status TEXT NOT NULL", "created_at TEXT", "expires_at TEXT NOT NULL",
    "last_renewed_at TEXT", "has_dns INTEGER DEFAULT 1", "dns_provider TEXT",
    "provider_account_id TEXT", "remote_id TEXT", "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP",
  ], ["FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE"]),
  table("logs", [
    "id INTEGER PRIMARY KEY AUTOINCREMENT", "type TEXT NOT NULL", "category TEXT NOT NULL",
    "message TEXT NOT NULL", "details TEXT", "created_at DATETIME DEFAULT CURRENT_TIMESTAMP",
  ]),
  table("cache", ["key TEXT PRIMARY KEY", "value TEXT NOT NULL", "expires_at INTEGER NOT NULL"]),
  table("settings", ["key TEXT PRIMARY KEY", "value TEXT NOT NULL", "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP"]),
  table("domain_date_overrides", [
    "id INTEGER PRIMARY KEY AUTOINCREMENT", "account_id INTEGER NOT NULL",
    "full_domain TEXT NOT NULL", "registered_at TEXT", "expires_at TEXT", "source TEXT",
    "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP",
  ], ["UNIQUE (account_id, full_domain)", "FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE"]),
  table("custom_accounts", [
    "id INTEGER PRIMARY KEY AUTOINCREMENT", "group_id INTEGER NOT NULL", "name TEXT NOT NULL",
    "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP",
  ], ["UNIQUE (group_id, name)", "FOREIGN KEY (group_id) REFERENCES accounts(id) ON DELETE CASCADE"]),
  table("custom_domains", [
    "id INTEGER PRIMARY KEY AUTOINCREMENT", "group_id INTEGER NOT NULL", "account_id INTEGER",
    "full_domain TEXT NOT NULL", "registered_at TEXT", "expires_at TEXT NOT NULL",
    "remark TEXT", "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP",
  ], [
    "UNIQUE (group_id, account_id, full_domain)",
    "FOREIGN KEY (group_id) REFERENCES accounts(id) ON DELETE CASCADE",
    "FOREIGN KEY (account_id) REFERENCES custom_accounts(id) ON DELETE CASCADE",
  ]),
  table("actions", [
    "id TEXT PRIMARY KEY", "type TEXT NOT NULL", "status TEXT NOT NULL",
    "progress INTEGER NOT NULL DEFAULT 0", "started_at TEXT", "finished_at TEXT",
    "error TEXT", "metadata TEXT", "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP",
  ]),
  table("audit_logs", [
    "id INTEGER PRIMARY KEY AUTOINCREMENT", "actor TEXT NOT NULL", "action TEXT NOT NULL",
    "resource_type TEXT NOT NULL", "resource_id TEXT", "provider TEXT", "result TEXT NOT NULL",
    "details TEXT", "created_at DATETIME DEFAULT CURRENT_TIMESTAMP",
  ]),
  table("scanner_jobs", [
    "id TEXT PRIMARY KEY", "status TEXT NOT NULL", "cursor TEXT NOT NULL",
    "total_checked INTEGER NOT NULL DEFAULT 0", "available INTEGER NOT NULL DEFAULT 0",
    "registered INTEGER NOT NULL DEFAULT 0", "failed INTEGER NOT NULL DEFAULT 0",
    "started_at TEXT", "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP", "finished_at TEXT", "error TEXT",
  ]),
  table("cf_sync_state", [
    "account_id INTEGER PRIMARY KEY", "generation TEXT NOT NULL", "next_page INTEGER NOT NULL",
    "total_synced INTEGER NOT NULL", "lease_token TEXT NOT NULL", "lease_until INTEGER NOT NULL",
    "updated_at INTEGER NOT NULL",
    "credential_fingerprint TEXT",
  ], ["FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE"]),
  table("cf_sync_seen", [
    "account_id INTEGER NOT NULL", "generation TEXT NOT NULL", "domain_id INTEGER NOT NULL",
    "seen INTEGER NOT NULL DEFAULT 0",
  ], [
    "PRIMARY KEY (account_id, generation, domain_id)",
    "FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE",
  ]),
  table("restore_sessions", [
    "id TEXT PRIMARY KEY", "owner TEXT NOT NULL", "manifest TEXT NOT NULL", "key_id TEXT NOT NULL",
    "status TEXT NOT NULL CHECK (status IN ('uploading','ready','committed','cancelled'))",
    "next_chunk INTEGER NOT NULL DEFAULT 0", "uploaded_rows INTEGER NOT NULL DEFAULT 0",
    "uploaded_bytes INTEGER NOT NULL DEFAULT 0", "expires_at INTEGER NOT NULL",
    "fence TEXT", "result TEXT", "created_at INTEGER NOT NULL",
  ]),
  table("restore_chunks", [
    "session_id TEXT NOT NULL", "chunk_index INTEGER NOT NULL", "digest TEXT NOT NULL",
    "normalized_digest TEXT NOT NULL", "raw_cipher TEXT NOT NULL",
  ], [
    "PRIMARY KEY (session_id, chunk_index)",
    "FOREIGN KEY (session_id) REFERENCES restore_sessions(id) ON DELETE CASCADE",
  ]),
  table("restore_rows", [
    "session_id TEXT NOT NULL", "table_name TEXT NOT NULL", "row_index INTEGER NOT NULL",
    "row_id INTEGER NOT NULL", "identity TEXT NOT NULL", "remote_identity TEXT", "payload TEXT NOT NULL",
  ], [
    "PRIMARY KEY (session_id, table_name, row_index)",
    "UNIQUE (session_id, table_name, row_id)", "UNIQUE (session_id, table_name, identity)",
    "UNIQUE (session_id, table_name, remote_identity)",
    "FOREIGN KEY (session_id) REFERENCES restore_sessions(id) ON DELETE CASCADE",
  ]),
  table("sync_work", [
    "id TEXT PRIMARY KEY", "action_id TEXT NOT NULL", "account_id INTEGER NOT NULL",
    "alias TEXT NOT NULL", "fingerprint TEXT NOT NULL", "renew INTEGER NOT NULL DEFAULT 0",
    "scheduled INTEGER NOT NULL DEFAULT 0",
    "status TEXT NOT NULL CHECK (status IN ('queued','running','paused','completed','failed','cancelled'))",
    "cursor TEXT NOT NULL DEFAULT '{}'", "failures INTEGER NOT NULL DEFAULT 0",
    "lease_token TEXT", "lease_until INTEGER NOT NULL DEFAULT 0", "not_before INTEGER NOT NULL DEFAULT 0",
    "deadline_at INTEGER NOT NULL", "error TEXT", "created_at INTEGER NOT NULL", "updated_at INTEGER NOT NULL",
  ], ["FOREIGN KEY (action_id) REFERENCES actions(id) ON DELETE CASCADE"]),
  table("sync_rows", [
    "job_id TEXT NOT NULL", "domain_id INTEGER NOT NULL", "payload TEXT NOT NULL",
    "enriched INTEGER NOT NULL DEFAULT 0", "dns_attempts INTEGER NOT NULL DEFAULT 0",
    "error TEXT", "renew_state TEXT NOT NULL DEFAULT 'none'",
  ], ["PRIMARY KEY (job_id, domain_id)", "FOREIGN KEY (job_id) REFERENCES sync_work(id) ON DELETE CASCADE"]),
  table("sync_candidates", ["job_id TEXT NOT NULL", "domain_id INTEGER NOT NULL"], [
    "PRIMARY KEY (job_id, domain_id)", "FOREIGN KEY (job_id) REFERENCES sync_work(id) ON DELETE CASCADE",
  ]),
  table("sync_renew_journal", [
    "account_id INTEGER NOT NULL", "domain_id INTEGER NOT NULL", "full_domain TEXT NOT NULL",
    "original_expiry TEXT NOT NULL", "status TEXT NOT NULL", "updated_at INTEGER NOT NULL",
    "new_expiry TEXT",
    "request_token TEXT",
  ], ["PRIMARY KEY (account_id, domain_id, full_domain, original_expiry)"]),
  table("notification_outbox", [
    "id TEXT PRIMARY KEY", "event_key TEXT NOT NULL", "channel TEXT NOT NULL",
    "target_id TEXT NOT NULL", "payload_cipher TEXT NOT NULL",
    "status TEXT NOT NULL CHECK (status IN ('queued','running','sent','dead','cancelled'))",
    "attempts INTEGER NOT NULL DEFAULT 0", "uncertain INTEGER NOT NULL DEFAULT 0",
    "lease_token TEXT", "lease_until INTEGER NOT NULL DEFAULT 0", "not_before INTEGER NOT NULL",
    "deadline_at INTEGER NOT NULL", "last_error TEXT", "created_at INTEGER NOT NULL",
    "updated_at INTEGER NOT NULL", "sent_at INTEGER",
  ]),
  table("notification_scans", [
    "id TEXT PRIMARY KEY", "scan_day TEXT NOT NULL", "target_set TEXT NOT NULL",
    "last_kind TEXT NOT NULL DEFAULT ''", "last_id INTEGER NOT NULL DEFAULT 0",
    "completed INTEGER NOT NULL DEFAULT 0", "lease_token TEXT NOT NULL", "lease_until INTEGER NOT NULL",
    "updated_at INTEGER NOT NULL",
  ]),
] as const;
export const BASELINE_TABLES = SCHEMA_TABLES.filter(table => !/^(restore_|sync_|notification_)/.test(table.name));
export const RESTORE_SCHEMA_TABLES = SCHEMA_TABLES.filter(table => table.name.startsWith("restore_"));
export const SYNC_SCHEMA_TABLES = SCHEMA_TABLES.filter(table => table.name.startsWith("sync_"));
export const NOTIFICATION_SCHEMA_TABLES = SCHEMA_TABLES.filter(table => table.name.startsWith("notification_"));

/** Only these missing legacy fields can be added automatically. */
export const LEGACY_COLUMNS: Record<string, Record<string, string>> = {
  accounts: { provider: "TEXT NOT NULL DEFAULT 'dnshe'", website: "TEXT" },
  domains_cache: { dns_provider: "TEXT", provider_account_id: "TEXT", remote_id: "TEXT" },
  custom_domains: { registered_at: "TEXT" },
  cf_sync_state: { credential_fingerprint: "TEXT" },
};

export const SCHEMA_INDEXES = [
  ["idx_domains_account", "domains_cache(account_id)"],
  ["idx_domains_expires", "domains_cache(expires_at)"],
  ["idx_logs_created", "logs(created_at)"],
  ["idx_cache_expires", "cache(expires_at)"],
  ["idx_domains_account_expires", "domains_cache(account_id, expires_at)"],
  ["idx_actions_updated", "actions(updated_at)"],
  ["idx_custom_domains_account", "custom_domains(account_id)"],
  ["idx_custom_domains_expires", "custom_domains(expires_at)"],
  ["idx_domains_account_full", "domains_cache(account_id, full_domain)"],
  ["idx_domains_account_remote", "domains_cache(account_id, remote_id)"],
  ["idx_restore_sessions_expires", "restore_sessions(expires_at)"],
  ["idx_sync_work_due", "sync_work(status, not_before, updated_at)"],
  ["idx_sync_work_action", "sync_work(action_id)"],
  ["idx_sync_active_account", "sync_work(account_id) WHERE status IN ('queued','running','paused')"],
  ["idx_actions_type_status", "actions(type, status)"],
  ["idx_notification_due", "notification_outbox(status, not_before, created_at)"],
  ["idx_notification_retention", "notification_outbox(status, updated_at)"],
].map(([name, target]) => ({ name, sql: `CREATE INDEX IF NOT EXISTS ${name} ON ${target}` }));
const activeAccountIndex = SCHEMA_INDEXES.find(index => index.name === "idx_sync_active_account")!;
activeAccountIndex.sql = activeAccountIndex.sql.replace("CREATE INDEX", "CREATE UNIQUE INDEX");

export const BASELINE_INDEXES = SCHEMA_INDEXES.slice(0, 8);
export const RESTORE_SCHEMA_INDEXES = SCHEMA_INDEXES.slice(8, 11);
export const SYNC_SCHEMA_INDEXES = SCHEMA_INDEXES.slice(11, 15);
export const NOTIFICATION_SCHEMA_INDEXES = SCHEMA_INDEXES.slice(15);
export const MIGRATION_NAMES = ["baseline_and_legacy_columns", "required_query_indexes", "staged_business_restore", "persistent_sync_queue", "notification_outbox"] as const;
export const SCHEMA_VERSION = MIGRATION_NAMES.length;
export const MIGRATION_TABLE = "domain_hub_schema_migrations";
export const MIGRATION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

export function freshSchemaSql(): string {
  // Never stamp a legacy database as upgraded just because CREATE IF NOT EXISTS succeeded.
  return "-- Generated by npm run schema:generate from src/db/schema-definition.ts.\n" +
    "-- Fresh database snapshot only. Upgrades use the shared versioned migrator.\n" +
    "-- Migration history is intentionally empty until runtime validation succeeds.\n\n" +
    [...SCHEMA_TABLES.map(table => table.sql), ...SCHEMA_INDEXES.map(index => index.sql), MIGRATION_TABLE_SQL]
      .map(sql => `${sql};\n`).join("\n");
}
