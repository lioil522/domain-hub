/** Existing bootstrap definitions, unchanged. Never replace legacy tables/data. */
export const LEGACY_TABLE_SCHEMA = [
  { name: "accounts", sql: `
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alias TEXT NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      api_secret TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'dnshe',
      website TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  ` },
  { name: "domains_cache", sql: `
    CREATE TABLE IF NOT EXISTS domains_cache (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      subdomain TEXT NOT NULL,
      rootdomain TEXT NOT NULL,
      full_domain TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT,
      expires_at TEXT NOT NULL,
      last_renewed_at TEXT,
      has_dns INTEGER DEFAULT 1,
      dns_provider TEXT,
      provider_account_id TEXT,
      remote_id TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
  ` },
  { name: "logs", sql: `
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  ` },
  { name: "settings", sql: `
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  ` },
  { name: "cache", sql: `
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  ` },
  { name: "domain_date_overrides", sql: `
    CREATE TABLE IF NOT EXISTS domain_date_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      full_domain TEXT NOT NULL,
      registered_at TEXT,
      expires_at TEXT,
      source TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (account_id, full_domain),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
  ` },
  { name: "custom_accounts", sql: `
    CREATE TABLE IF NOT EXISTS custom_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (group_id, name),
      FOREIGN KEY (group_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
  ` },
  { name: "custom_domains", sql: `
    CREATE TABLE IF NOT EXISTS custom_domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      account_id INTEGER,
      full_domain TEXT NOT NULL,
      registered_at TEXT,
      expires_at TEXT NOT NULL,
      remark TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (group_id, account_id, full_domain),
      FOREIGN KEY (group_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES custom_accounts(id) ON DELETE CASCADE
    );
  ` },
  { name: "actions", sql: `
    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0,
      started_at TEXT, finished_at TEXT, error TEXT, metadata TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  ` },
  { name: "audit_logs", sql: `
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
      resource_type TEXT NOT NULL, resource_id TEXT, provider TEXT, result TEXT NOT NULL,
      details TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  ` },
  { name: "scanner_jobs", sql: `
    CREATE TABLE IF NOT EXISTS scanner_jobs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, cursor TEXT NOT NULL, total_checked INTEGER NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 0, registered INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
      started_at TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, finished_at TEXT, error TEXT
    );
  ` },
] as const;
