/** Additive migration. Domain tombstones survive deletion to fence late readers. */
export const AUTOMATION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS domain_mutation_clock (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO domain_mutation_clock VALUES(1,0)`,
  `CREATE TABLE IF NOT EXISTS domain_mutations (domain_id INTEGER PRIMARY KEY, version INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sync_commit_assertions (valid INTEGER NOT NULL CHECK(valid=1))`,
  ...["INSERT", "UPDATE", "DELETE"].map(event => `CREATE TRIGGER IF NOT EXISTS domain_mutation_${event.toLowerCase()} AFTER ${event} ON domains_cache BEGIN
    UPDATE domain_mutation_clock SET version=version+1 WHERE id=1;
    INSERT INTO domain_mutations(domain_id,version) VALUES(${event === "DELETE" ? "OLD" : "NEW"}.id,(SELECT version FROM domain_mutation_clock WHERE id=1))
      ON CONFLICT(domain_id) DO UPDATE SET version=excluded.version;
  END`),
  `CREATE TABLE IF NOT EXISTS renewal_intents (
    domain_id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, scope_revision INTEGER NOT NULL,
    baseline TEXT NOT NULL, token TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('prepared','sent','verify','completed','rejected')),
    lease_until INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_renewal_pending ON renewal_intents(status,next_attempt_at,lease_until)`,
  `CREATE TABLE IF NOT EXISTS reminder_deliveries (
    day TEXT NOT NULL, report_version TEXT NOT NULL, channel TEXT NOT NULL, token TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('sending','sent','failed')), next_attempt_at INTEGER NOT NULL,
    PRIMARY KEY(day,report_version,channel)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_domains_expiry ON domains_cache(expires_at,account_id)`,
] as const;
