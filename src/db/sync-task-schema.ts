/** Additive P1 migration. No legacy tables/columns/data are replaced.
 * Credential revisions live in a side table so older account response shapes and
 * backups remain compatible. SQL triggers cover raw writes as well as the DAO.
 */
export const SYNC_TASK_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS account_sync_versions (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)
  )`,
  `CREATE TABLE IF NOT EXISTS sync_tasks (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
    generation TEXT NOT NULL CHECK(length(generation) BETWEEN 1 AND 128),
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    scope_revision INTEGER NOT NULL CHECK(scope_revision > 0),
    mode TEXT NOT NULL CHECK(mode IN ('full','list')),
    phase TEXT NOT NULL DEFAULT 'list' CHECK(phase IN ('list','dns','quota','cleanup','done')),
    cursor TEXT NOT NULL DEFAULT '{}' CHECK(length(cursor) <= 4096 AND json_valid(cursor) AND json_type(cursor) = 'object'),
    version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','paused','blocked','completed','cancelled','invalidated')),
    owner TEXT CHECK(owner IS NULL OR length(owner) BETWEEN 1 AND 128),
    lease_until INTEGER NOT NULL DEFAULT 0 CHECK(lease_until >= 0),
    next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK(next_attempt_at >= 0),
    last_completed_at INTEGER,
    error TEXT CHECK(error IS NULL OR length(error) <= 2048),
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_tasks_active ON sync_tasks(account_id,mode)
    WHERE status IN ('queued','running','paused','blocked')`,
  `CREATE INDEX IF NOT EXISTS idx_sync_tasks_plan ON sync_tasks(account_id,mode,updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sync_tasks_history ON sync_tasks(status,updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sync_tasks_latest ON sync_tasks(account_id,mode,created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sync_tasks_freshness ON sync_tasks(account_id,mode,last_completed_at DESC,created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sync_tasks_success ON sync_tasks(account_id,mode,last_completed_at DESC,created_at DESC) WHERE status='completed'`,
  `CREATE TABLE IF NOT EXISTS sync_fragments (
    task_id TEXT NOT NULL REFERENCES sync_tasks(id) ON DELETE CASCADE,
    generation TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('list','dns')),
    shard TEXT NOT NULL CHECK(length(shard) BETWEEN 1 AND 256),
    page INTEGER NOT NULL CHECK(page >= 0),
    payload TEXT NOT NULL CHECK(length(payload) <= 32768 AND json_valid(payload)),
    PRIMARY KEY(task_id,generation,kind,shard,page)
  )`,
  `CREATE TABLE IF NOT EXISTS sync_items (
    task_id TEXT NOT NULL REFERENCES sync_tasks(id) ON DELETE CASCADE,
    generation TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('seen','candidate')),
    domain_id TEXT NOT NULL CHECK(length(domain_id) BETWEEN 1 AND 256),
    baseline TEXT CHECK(baseline IS NULL OR (length(baseline) <= 32768 AND json_valid(baseline))),
    PRIMARY KEY(task_id,generation,kind,domain_id)
  )`,
  `CREATE TRIGGER IF NOT EXISTS account_sync_credentials_changed AFTER UPDATE OF api_key,api_secret,provider ON accounts
    WHEN OLD.api_key IS NOT NEW.api_key OR OLD.api_secret IS NOT NEW.api_secret OR OLD.provider IS NOT NEW.provider
    BEGIN
      INSERT INTO account_sync_versions(account_id,revision) VALUES(NEW.id,2)
        ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
      UPDATE sync_tasks SET status='invalidated',owner=NULL,lease_until=0,version=version+1,
        updated_at=CAST(strftime('%s','now') AS INTEGER)
        WHERE account_id=NEW.id AND status IN ('queued','running','paused','blocked');
    END`,
] as const;
