-- 1. API 账号表
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT NOT NULL,                  -- 账号别名
    api_key TEXT NOT NULL UNIQUE,         -- API Key（Cloudflare 账号存 CF account id，防重复绑定）
    api_secret TEXT NOT NULL,             -- 加密后的 API Secret（Cloudflare 账号存加密后的 API Token）
    provider TEXT NOT NULL DEFAULT 'dnshe', -- 账号提供商 (dnshe/cloudflare/custom)
    website TEXT,                         -- 官网链接（仅自定义服务商分组使用，NULL=未填写）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. 域名缓存表
CREATE TABLE IF NOT EXISTS domains_cache (
    id INTEGER PRIMARY KEY,               -- subdomain_id (DNSHE 的子域名ID)
    account_id INTEGER NOT NULL,          -- 绑定的账号 ID
    subdomain TEXT NOT NULL,              -- 子域名前缀
    rootdomain TEXT NOT NULL,             -- 根域名
    full_domain TEXT NOT NULL,            -- 完整域名
    status TEXT NOT NULL,                 -- 状态 (active/suspended/expired)
    created_at TEXT,                      -- 注册时间 (YYYY-MM-DD HH:MM:SS)
    expires_at TEXT NOT NULL,             -- 到期时间 (YYYY-MM-DD HH:MM:SS)
    last_renewed_at TEXT,                 -- 上次自动续期时间
    has_dns INTEGER DEFAULT 1,            -- 是否使用默认 NS 并启用 DNS 管理 (1=是, 0=否)
    dns_provider TEXT,                    -- DNS 托管商 (system/Cloudflare/DNSPod/Vercel/vps8/external)
    provider_account_id TEXT,             -- 解析服务商账号 ID，线路支持判定的兜底信号（主判定用根域 NS，详见 src/dnshe.ts 注释）
    remote_id TEXT,                       -- 上游对象 ID（Cloudflare 存 zone id；DNSHE 行留空，主键 id 即 subdomain_id）
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- 3. 系统运行日志表（包含同步与自动续期日志）
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,                   -- info / success / warning / error
    category TEXT NOT NULL,               -- sync / renew / system / auth / api / operation
    message TEXT NOT NULL,                -- 简短描述
    details TEXT,                         -- 详细 JSON 内容或报错堆栈
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. API 上游响应缓存表（防止频繁调用 DNSHE 官方 API 被判定滥用）
CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,                 -- 缓存键 (如 api_cache:quota / api_cache:dns:<domainId> / ns:<rootdomain>)
    value TEXT NOT NULL,                  -- 缓存的 JSON 数据
    expires_at INTEGER NOT NULL           -- 绝对过期时间 (epoch 秒)
);

-- 4.1 应用配置键值表（登录凭据哈希、2FA 密钥、通知渠道配置、续期阈值、
--     dns_records_cache_mode 等，以及 sess_ 前缀的登录会话行）
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引以加速跨账号域名搜索和定时扫描
CREATE INDEX IF NOT EXISTS idx_domains_account ON domains_cache(account_id);
CREATE INDEX IF NOT EXISTS idx_domains_expires ON domains_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
-- 加速查重池的过期过滤与每日过期行清理
CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);

-- 5. 域名日期手动覆盖表（Cloudflare zone 注册/到期时间 + 注册来源：
--    RDAP 查不到的域名由用户自行录入，随账号存后端，多设备共享）
CREATE TABLE IF NOT EXISTS domain_date_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,          -- 归属账号（Cloudflare 账号）
    full_domain TEXT NOT NULL,            -- zone 完整域名（小写）
    registered_at TEXT,                   -- 手动注册时间 (YYYY-MM-DD，NULL=未填)
    expires_at TEXT,                      -- 手动到期时间 (YYYY-MM-DD，NULL=未填)
    source TEXT,                          -- 注册来源备注（如 Namecheap）
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (account_id, full_domain),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- 6. 自定义域名服务商（无 API 的社区公益域名）：分组 → (可选账号) → 域名
-- 分组 = accounts 表（provider='custom'）；账号 = custom_accounts（可选）；域名 = custom_domains
CREATE TABLE IF NOT EXISTS custom_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,            -- 归属的服务商分组（accounts.id，provider='custom'）
    name TEXT NOT NULL,                   -- 账号名称（用户名/邮箱/昵称）
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (group_id, name),
    FOREIGN KEY (group_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS custom_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,            -- 归属的服务商分组（accounts.id，始终有值）
    account_id INTEGER,                   -- 可选：归属的账号（custom_accounts.id，NULL=直接挂在分组下）
    full_domain TEXT NOT NULL,            -- 完整域名（小写）
    registered_at TEXT,                   -- 注册时间 (YYYY-MM-DD，NULL=未填)
    expires_at TEXT NOT NULL,             -- 到期时间 (YYYY-MM-DD HH:MM:SS)
    remark TEXT,                          -- 备注
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (group_id, account_id, full_domain),
    FOREIGN KEY (group_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES custom_accounts(id) ON DELETE CASCADE
);


-- 7. 可恢复操作中心
CREATE TABLE IF NOT EXISTS actions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    finished_at TEXT,
    error TEXT,
    metadata TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 8. 审计日志
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    provider TEXT,
    result TEXT NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 9. 可恢复 Scanner Job
CREATE TABLE IF NOT EXISTS scanner_jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    cursor TEXT NOT NULL,
    total_checked INTEGER NOT NULL DEFAULT 0,
    available INTEGER NOT NULL DEFAULT 0,
    registered INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT,
    error TEXT
);

-- 10. Invocation-bounded sync foundation (inactive until the sliced engine ships).
CREATE TABLE IF NOT EXISTS account_sync_versions (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)
);
CREATE TABLE IF NOT EXISTS sync_tasks (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_tasks_active ON sync_tasks(account_id,mode)
    WHERE status IN ('queued','running','paused','blocked');
CREATE INDEX IF NOT EXISTS idx_sync_tasks_plan ON sync_tasks(account_id,mode,updated_at);
CREATE INDEX IF NOT EXISTS idx_sync_tasks_history ON sync_tasks(status,updated_at);
CREATE INDEX IF NOT EXISTS idx_sync_tasks_latest ON sync_tasks(account_id,mode,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_tasks_freshness ON sync_tasks(account_id,mode,last_completed_at DESC,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_tasks_success ON sync_tasks(account_id,mode,last_completed_at DESC,created_at DESC) WHERE status='completed';
CREATE TABLE IF NOT EXISTS sync_fragments (
    task_id TEXT NOT NULL REFERENCES sync_tasks(id) ON DELETE CASCADE,
    generation TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('list','dns')),
    shard TEXT NOT NULL CHECK(length(shard) BETWEEN 1 AND 256),
    page INTEGER NOT NULL CHECK(page >= 0),
    payload TEXT NOT NULL CHECK(length(payload) <= 32768 AND json_valid(payload)),
    PRIMARY KEY(task_id,generation,kind,shard,page)
);
CREATE TABLE IF NOT EXISTS sync_items (
    task_id TEXT NOT NULL REFERENCES sync_tasks(id) ON DELETE CASCADE,
    generation TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('seen','candidate')),
    domain_id TEXT NOT NULL CHECK(length(domain_id) BETWEEN 1 AND 256),
    baseline TEXT CHECK(baseline IS NULL OR (length(baseline) <= 32768 AND json_valid(baseline))),
    PRIMARY KEY(task_id,generation,kind,domain_id)
);
CREATE TRIGGER IF NOT EXISTS account_sync_credentials_changed AFTER UPDATE OF api_key,api_secret,provider ON accounts
    WHEN OLD.api_key IS NOT NEW.api_key OR OLD.api_secret IS NOT NEW.api_secret OR OLD.provider IS NOT NEW.provider
    BEGIN
      INSERT INTO account_sync_versions(account_id,revision) VALUES(NEW.id,2)
        ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
      UPDATE sync_tasks SET status='invalidated',owner=NULL,lease_until=0,version=version+1,
        updated_at=CAST(strftime('%s','now') AS INTEGER)
        WHERE account_id=NEW.id AND status IN ('queued','running','paused','blocked');
    END;
-- 11. Additive reminder/renewal and monotonic domain fencing (no legacy data replacement).
CREATE TABLE IF NOT EXISTS domain_mutation_clock (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
INSERT OR IGNORE INTO domain_mutation_clock VALUES(1,0);
CREATE TABLE IF NOT EXISTS domain_mutations (domain_id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sync_commit_assertions (valid INTEGER NOT NULL CHECK(valid=1));
CREATE TRIGGER IF NOT EXISTS domain_mutation_insert AFTER INSERT ON domains_cache BEGIN
  UPDATE domain_mutation_clock SET version=version+1 WHERE id=1;
  INSERT INTO domain_mutations(domain_id,version) VALUES(NEW.id,(SELECT version FROM domain_mutation_clock WHERE id=1)) ON CONFLICT(domain_id) DO UPDATE SET version=excluded.version;
END;
CREATE TRIGGER IF NOT EXISTS domain_mutation_update AFTER UPDATE ON domains_cache BEGIN
  UPDATE domain_mutation_clock SET version=version+1 WHERE id=1;
  INSERT INTO domain_mutations(domain_id,version) VALUES(NEW.id,(SELECT version FROM domain_mutation_clock WHERE id=1)) ON CONFLICT(domain_id) DO UPDATE SET version=excluded.version;
END;
CREATE TRIGGER IF NOT EXISTS domain_mutation_delete AFTER DELETE ON domains_cache BEGIN
  UPDATE domain_mutation_clock SET version=version+1 WHERE id=1;
  INSERT INTO domain_mutations(domain_id,version) VALUES(OLD.id,(SELECT version FROM domain_mutation_clock WHERE id=1)) ON CONFLICT(domain_id) DO UPDATE SET version=excluded.version;
END;
CREATE TABLE IF NOT EXISTS renewal_intents (
  domain_id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, scope_revision INTEGER NOT NULL,
  baseline TEXT NOT NULL, token TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('prepared','sent','verify','completed','rejected')),
  lease_until INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_renewal_pending ON renewal_intents(status,next_attempt_at,lease_until);
CREATE TABLE IF NOT EXISTS reminder_deliveries (
  day TEXT NOT NULL, report_version TEXT NOT NULL, channel TEXT NOT NULL, token TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('sending','sent','failed')), next_attempt_at INTEGER NOT NULL,
  PRIMARY KEY(day,report_version,channel)
);
CREATE INDEX IF NOT EXISTS idx_domains_expiry ON domains_cache(expires_at,account_id);
