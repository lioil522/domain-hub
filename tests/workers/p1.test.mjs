import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createCipheriv, createHash, randomBytes, pbkdf2Sync } from "node:crypto";

const { outputFiles: [bundle] } = await build({ entryPoints: ["tests/workers/p1-fixture.ts"], bundle: true,
  platform: "neutral", target: "es2022", format: "esm", write: false });
const compatibilityDate = readFileSync("wrangler.toml", "utf8").match(/^compatibility_date\s*=\s*"([\d-]+)"/m)?.[1];
assert.ok(compatibilityDate);
async function fixture(t, outboundService = () => { throw new Error("P1 runtime tests forbid real outbound requests"); }, aesKey) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.text, compatibilityDate,
    cf: false, host: "127.0.0.1", port: 0, d1Databases: ["DB"], outboundService, bindings: aesKey ? { AES_KEY: aesKey } : {} }));
  t.after(() => mf.dispose());
  return { mf, d1: await mf.getD1Database("DB"),
    request: async values => (await mf.dispatchFetch(`http://localhost/?${new URLSearchParams(values)}`)).json(),
    post: async (values, body) => (await mf.dispatchFetch(`http://localhost/?${new URLSearchParams(values)}`, { method: "POST", body })).json() };
}

function migrationSnapshot() {
  // Independent Node AES implementation -> production workerd WebCrypto.
  const iv = Buffer.alloc(12, 7), cipher = createCipheriv("aes-256-gcm", createHash("sha256").update("offline-source-aes").digest(), iv);
  const encrypted = Buffer.concat([cipher.update("offline-secret", "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { version: 1, exported_at: "offline", data: {
    accounts: [{ id: 1, alias: "migration", api_key: "migration-key", api_secret: `${iv.toString("hex")}:${encrypted.toString("hex")}`, provider: "dnshe" }],
    domains_cache: [{ id: 4739823932, account_id: 1, subdomain: "m", rootdomain: "example.test", full_domain: "m.example.test", status: "active", expires_at: "2027-01-01", provider_account_id: "external-id" }],
  } };
}

test("workerd staging smoke: migration auth, cross-key preview/import, ID mapping and unchanged coordination", async t => {
  const { request, post, d1 } = await fixture(t, undefined, "offline-target-aes");
  const { token } = await request({ op: "automation-init" });
  await d1.exec("INSERT INTO cache VALUES('staging-checkpoint','keep',9999999999)");
  const snapshot = migrationSnapshot(), body = JSON.stringify({ snapshot, sourceAesKey: "offline-source-aes" });
  const call = (path, tokenValue = token, payload = body) => post({ op: "automation-http", path: `/api/data/${path}`, ...(tokenValue ? { token: tokenValue } : {}) }, payload);
  assert.equal((await call("import", "")).status, 401);
  const preview = await call("preview"); assert.equal(preview.status, 200); assert.equal(preview.body.diff.totalAdd, 2);
  assert.equal(await d1.prepare("SELECT count(*) AS n FROM accounts").first("n"), 1);
  assert.equal(await d1.prepare("SELECT count(*) AS n FROM audit_logs").first("n"), 0);
  const imported = await call("import"); assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.mappings.accounts[1], 2); assert.equal(imported.body.mappings.domains_cache[4739823932], 4739823932);
  assert.equal(await d1.prepare("SELECT account_id FROM domains_cache").first("account_id"), 2);
  assert.equal(await d1.prepare("SELECT provider_account_id FROM domains_cache").first("provider_account_id"), "external-id");
  assert.equal(await d1.prepare("SELECT value FROM cache WHERE key='staging-checkpoint'").first("value"), "keep");
  assert.equal(await d1.prepare("SELECT count(*) AS n FROM sync_tasks").first("n"), 0);
  assert.equal(await d1.prepare("SELECT count(*) AS n FROM audit_logs WHERE result='success'").first("n"), 1);
  const repeated = await call("import"); assert.equal(repeated.status, 200); assert.equal(repeated.body.imported.accounts, 0);
  const wrong = await call("preview", token, JSON.stringify({ snapshot, sourceAesKey: "offline-wrong-aes" })); assert.equal(wrong.status, 400);
  assert.ok(!JSON.stringify(wrong.body).includes("offline-wrong-aes"));
  const invalid = structuredClone(snapshot); invalid.data.accounts = Array.from({ length: 501 }, (_, n) => ({ ...snapshot.data.accounts[0], id: n+1, api_key: `k${n}` }));
  assert.equal((await call("import", token, JSON.stringify({ snapshot: invalid }))).status, 400);
  assert.equal((await call("preview", token, JSON.stringify({ padding: "x".repeat(8 * 1024 * 1024 + 8192) }))).status, 413);
  for (const result of [preview, imported, repeated, wrong]) { assert.ok(result.budget.used.d1 <= 40); assert.equal(result.budget.used.external, 0); }
  t.diagnostic(JSON.stringify({ syntheticStaging: true, previewD1: preview.budget.used.d1, importD1: imported.budget.used.d1, external: 0, remoteBilledRows: null }));
});

test("workerd staging smoke: import audit failure is atomic; secondary log failure does not lose commit receipt", async t => {
  const { request, post, d1 } = await fixture(t, undefined, "offline-target-aes");
  const { token } = await request({ op: "automation-init" });
  const body = JSON.stringify({ snapshot: migrationSnapshot(), sourceAesKey: "offline-source-aes" });
  await d1.exec("CREATE TRIGGER restore_fault BEFORE INSERT ON audit_logs WHEN NEW.result='success' BEGIN SELECT RAISE(ABORT,'offline secret-like storage failure'); END");
  const failed = await post({ op: "automation-http", path: "/api/data/import", token }, body);
  assert.equal(failed.status, 400); assert.ok(!JSON.stringify(failed.body).includes("secret-like"));
  assert.equal(await d1.prepare("SELECT count(*) AS n FROM accounts").first("n"), 1);
  assert.equal(await d1.prepare("SELECT count(*) AS n FROM domains_cache").first("n"), 0);
  await d1.exec("DROP TRIGGER restore_fault; CREATE TRIGGER log_fault BEFORE INSERT ON logs WHEN NEW.type='success' BEGIN SELECT RAISE(ABORT,'offline secondary log failure'); END");
  const committed = await post({ op: "automation-http", path: "/api/data/import", token }, body);
  assert.equal(committed.status, 200); assert.equal(committed.body.imported.accounts, 1);
  assert.equal(await d1.prepare("SELECT count(*) AS n FROM audit_logs WHERE result='success'").first("n"), 1);
  assert.equal(await d1.prepare("SELECT count(*) AS n FROM domains_cache").first("n"), 1);
});
const fence = task => ({ id: task.id, generation: task.generation, scope_revision: task.scope_revision,
  version: task.version, owner: task.owner, phase: task.phase });

test("workerd/D1: production entry counts cold/warm schema and session authentication", async t => {
  const { request } = await fixture(t);
  const cold = await request({ op: "http" });
  assert.equal(cold.status, 401); assert.equal(cold.budget.used.d1, 2);
  const warm = await request({ op: "http" });
  assert.equal(warm.status, 401); assert.equal(warm.budget.used.d1, 0);
  const auth = await request({ op: "http", auth: "1" });
  assert.equal(auth.status, 401); assert.ok(auth.budget.used.d1 > 0);
});

test("workerd/D1: native receiver, sessions, first/raw overloads, batch counts and rollback", async t => {
  const { request } = await fixture(t);
  const result = await request({ op: "d1" });
  assert.equal(result.first, 1); assert.equal(result.count, 2); assert.equal(result.failed, true);
  assert.deepEqual(result.rows, [["id"], [1], [2]]);
  assert.equal(result.budget.used.d1, 6);
});

test("workerd/D1: schema exhaustion is closed and next invocation can retry", async t => {
  const { request } = await fixture(t);
  const failed = await request({ op: "http", d1: "1" });
  assert.equal(failed.status, 503); assert.equal(failed.budget.used.d1, 1);
  const retry = await request({ op: "http" });
  assert.equal(retry.status, 401); assert.equal(retry.budget.used.d1, 2);
});

const allSchema = readFileSync("schema.sql", "utf8");
const legacySchema = allSchema.slice(0, allSchema.indexOf("-- 10."));
async function provisionLegacy(d1, sql = legacySchema) {
  const statements = sql.replace(/--[^\r\n]*/g, "").split(";").map(part => part.trim()).filter(Boolean);
  await d1.batch(statements.map(part => d1.prepare(part)));
}
async function schemaState(d1) {
  const schema = (await d1.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name").all()).results;
  const tables = schema.filter(row => row.type === "table").map(row => row.name);
  const rows = await d1.batch([...tables.map(name => d1.prepare(`SELECT * FROM "${name}" ORDER BY rowid`)), d1.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name")]);
  return { schema, rows: Object.fromEntries(tables.map((name, n) => [name, rows[n].results])), sequences: rows.at(-1).results };
}
const encryptOffline = (text, aesKey) => {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(aesKey).digest(), iv);
  return `${iv.toString("hex")}:${Buffer.concat([cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("hex")}`;
};

test("workerd/D1: 80 x 7 legacy status uses 3 calls, preserves rows/sequences and decrypts independent AES 2FA", async t => {
  let outbound = 0; const aesKey = "offline-bootstrap-workerd-aes";
  const { d1, request } = await fixture(t, () => { outbound++; throw new Error("No bootstrap outbound"); }, aesKey);
  await provisionLegacy(d1);
  const encrypted = encryptOffline("offline-account-secret", aesKey);
  const insert = d1.prepare("INSERT INTO accounts(id,alias,api_key,api_secret) VALUES(?,'offline',?,?)");
  await d1.batch(Array.from({ length: 80 }, (_, n) => insert.bind(n + 1, `offline-${n + 1}`, encrypted)));
  const domain = d1.prepare("INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at) VALUES(?,?,?,'example.test',?,'active','2027-01-01')");
  for (let account = 1; account <= 80; account++) await d1.batch(Array.from({ length: 7 }, (_, n) => domain.bind(account * 100 + n, account, `d${n}`, `a${account}-d${n}.example.test`)));
  const salt = randomBytes(16), hash = pbkdf2Sync("offline-password", salt, 100000, 32, "sha256").toString("hex");
  await d1.prepare("INSERT INTO settings(key,value) VALUES('auth_username','offline'),('auth_pass_hash',?),('auth_pass_salt',?),('auth_2fa_enabled','1'),('auth_2fa_secret',?),('auth_initialized','1')")
    .bind(hash, salt.toString("hex"), encryptOffline("JBSWY3DPEHPK3PXP", aesKey)).run();
  const before = await schemaState(d1), cold = await request({ op: "schema-http" });
  assert.equal(cold.status, 200); assert.deepEqual(cold.body, { success: true, initialized: true, two_fa_enabled: true });
  assert.deepEqual(cold.budget.used, { d1: 3, external: 0 });
  const after = await schemaState(d1);
  for (const [name, rows] of Object.entries(before.rows)) assert.deepEqual(after.rows[name], rows, name);
  assert.deepEqual(after.sequences, before.sequences); assert.equal(Object.keys(after.rows).length, 20);
  assert.equal(after.rows.accounts.length, 80); assert.equal(after.rows.domains_cache.length, 560);
  assert.deepEqual(after.rows.domain_mutation_clock, [{ id: 1, version: 0 }]);
  const warm = await request({ op: "schema-http" }); assert.equal(warm.status, 200); assert.equal(warm.budget.used.d1, 1);
  assert.deepEqual(await schemaState(d1), after); assert.equal(outbound, 0);
});

test("workerd/D1: legacy ALTERs, CREATEs and clock initialization roll back together on late failure", async t => {
  const { d1, request } = await fixture(t);
  const oldest = legacySchema.replace(/\r\n/g, "\n").replace(/^[ \t]*(provider|website|dns_provider|provider_account_id|remote_id) TEXT[^\n]*\n/gm, "")
    .replace(/(CREATE TABLE IF NOT EXISTS custom_domains \([\s\S]*?)\s+registered_at TEXT,[^\r\n]*[\r\n]+/, "$1\n");
  await provisionLegacy(d1, oldest);
  await d1.prepare("INSERT INTO accounts(id,alias,api_key,api_secret) VALUES(99,'offline','offline','offline-secret')").run();
  await d1.exec("CREATE TABLE idx_domains_expiry(n INTEGER)");
  const before = await schemaState(d1), failed = await request({ op: "schema-http" });
  assert.equal(failed.status, 503); assert.equal(failed.body.error_code, "storage_unavailable");
  assert.deepEqual(await schemaState(d1), before); assert.equal(failed.budget.used.d1, 2);
  await d1.exec("DROP TABLE idx_domains_expiry");
  const retry = await request({ op: "schema-http" }); assert.equal(retry.status, 200); assert.equal(retry.budget.used.d1, 3);
  const after = await schemaState(d1); assert.equal(Object.keys(after.rows).length, 20);
  assert.equal(after.rows.accounts[0].provider, "dnshe"); assert.equal(after.rows.accounts[0].api_secret, "offline-secret");
  assert.deepEqual(after.sequences, before.sequences); assert.deepEqual(after.rows.domain_mutation_clock, [{ id: 1, version: 0 }]);
  assert.deepEqual((await d1.prepare("PRAGMA foreign_key_check").all()).results, []);
});

test("workerd/D1: one-call budget leaves empty schema untouched; two calls bootstrap without ALTER duplicates", async t => {
  const { d1, request } = await fixture(t);
  const failed = await request({ op: "schema", d1: "1" }); assert.equal(failed.ready, false); assert.equal(failed.budget.used.d1, 1);
  assert.equal(await d1.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' AND name NOT GLOB 'sqlite_*'").first("n"), 0);
  const next = await request({ op: "schema", d1: "2" }); assert.equal(next.ready, true); assert.equal(next.budget.used.d1, 2);
  assert.equal(await d1.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' AND name NOT GLOB 'sqlite_*'").first("n"), 20);
  assert.equal((await d1.prepare("PRAGMA quick_check").all()).results[0].quick_check, "ok");
});

test("workerd/D1: distinct invocations acquire once, commit atomically and reject old replay", async t => {
  const { request, d1 } = await fixture(t);
  assert.equal((await request({ op: "task-create" })).created, true);
  const [a, b] = await Promise.all([request({ op: "task-claim", owner: "a" }), request({ op: "task-claim", owner: "b" })]);
  assert.equal([a.task, b.task].filter(Boolean).length, 1);
  const held = a.task ?? b.task;
  const saved = await request({ op: "task-commit", fence: JSON.stringify(fence(held)), d1: "1" });
  assert.equal(saved.code, "ok"); assert.equal(saved.budget.used.d1, 1); assert.equal(saved.task.cursor, '{"page":2}');
  const stale = await request({ op: "task-commit", fence: JSON.stringify(fence(held)) });
  assert.equal(stale.code, "sync_fence_lost");
  assert.equal(await d1.prepare("SELECT COUNT(*) AS n FROM sync_fragments").first("n"), 1);
  assert.equal(await d1.prepare("SELECT COUNT(*) AS n FROM sync_items").first("n"), 1);
});

test("workerd/D1: rollback protects cursor and fragments; credential trigger fences old owner", async t => {
  const { request, d1 } = await fixture(t);
  await request({ op: "task-create" });
  const { task } = await request({ op: "task-claim" });
  await d1.exec("CREATE TRIGGER fail_slice BEFORE INSERT ON sync_items BEGIN SELECT RAISE(ABORT,'offline rollback'); END");
  const failed = await request({ op: "task-commit", fence: JSON.stringify(fence(task)) });
  assert.equal(failed.code, "storage_error"); assert.equal(failed.task.cursor, "{}");
  assert.equal(await d1.prepare("SELECT COUNT(*) AS n FROM sync_fragments").first("n"), 0);
  await d1.exec("DROP TRIGGER fail_slice; UPDATE accounts SET api_secret='changed' WHERE id=1");
  const stale = await request({ op: "task-commit", fence: JSON.stringify(fence(task)) });
  assert.equal(stale.code, "sync_fence_lost"); assert.equal(stale.task.status, "invalidated");
  assert.equal(await d1.prepare("SELECT revision FROM account_sync_versions WHERE account_id=1").first("revision"), 2);
});

test("workerd: each redirect hop consumes external capacity and no credential is forwarded", async t => {
  const calls = [];
  const { request } = await fixture(t, request => {
    calls.push({ url: request.url, key: request.headers.get("X-API-Key") });
    return request.url.includes("first.invalid") ? new Response(null, { status: 302, headers: { Location: "https://other.invalid/result" } }) : Response.json({ ok: true });
  });
  const result = await request({ op: "fetch", external: "2" });
  assert.equal(result.status, 200); assert.equal(result.budget.used.external, 2);
  assert.equal(calls.length, 2); assert.equal(calls[1].key, null);
  calls.length = 0;
  const limited = await request({ op: "fetch", external: "1" });
  assert.equal(limited.code, "invocation_budget_exhausted"); assert.equal(calls.length, 1);
});

test("workerd/D1: unauthenticated sync-plan and sync-step never issue upstream calls", async t => {
  const { request } = await fixture(t);
  for (const path of ["/api/sync/plan", "/api/accounts/1/sync-step"]) {
    const result = await request({ op: "automation-http", path });
    assert.equal(result.status, 401); assert.equal(result.budget.used.external, 0);
  }
});

test("workerd/D1 history: authenticated preview defaults, strict confirmation and bounded slices", async t => {
  const { request, d1 } = await fixture(t);
  const { token } = await request({ op: "automation-init", provider: "cloudflare" });
  await d1.batch([
    d1.prepare("INSERT INTO sync_tasks(id,generation,account_id,provider,scope_revision,mode,phase,status,last_completed_at,created_at,updated_at) VALUES('old','old',1,'cloudflare',1,'full','done','completed',100,100,1)"),
    d1.prepare("INSERT INTO sync_tasks(id,generation,account_id,provider,scope_revision,mode,phase,status,last_completed_at,created_at,updated_at) VALUES('latest','latest',1,'cloudflare',1,'full','done','completed',200,200,1)"),
    d1.prepare("INSERT INTO cache VALUES('history:legacy','keep',9999999999)"),
  ]);
  await d1.batch(Array.from({ length: 205 }, (_, n) => d1.prepare("INSERT INTO sync_fragments(task_id,generation,kind,shard,page,payload) VALUES('old','old','dns','offline',?,'[]')").bind(n)));
  await d1.batch(Array.from({ length: 205 }, (_, n) => d1.prepare("INSERT INTO sync_items(task_id,generation,kind,domain_id) VALUES('old','old','seen',?)").bind(String(n))));
  const path = "/api/sync/history/maintenance";
  const anonymous = await request({ op: "automation-http", path, body: '{"dryRun":false,"confirm":"purge-terminal-sync-history"}' });
  assert.equal(anonymous.status, 401); assert.equal(await d1.prepare("SELECT count(*) AS n FROM sync_fragments").first("n"), 205);
  const preview = await request({ op: "automation-http", path, token, body: '{}' });
  assert.equal(preview.status, 200); assert.equal(preview.body.dryRun, true);
  assert.deepEqual(preview.body.sample, { candidateTasks: 1, fragments: 100, items: 100 });
  assert.equal(await d1.prepare("SELECT count(*) AS n FROM logs WHERE category='operation'").first("n"), 0);
  for (const body of ['null', '[]', '{', '{"dryRun":false}', '{"dryRun":"false"}', '{"retentionDays":29}', '{"limit":101}']) {
    const bad = await request({ op: "automation-http", path, token, body }); assert.equal(bad.status, 400, body);
  }
  const oversized = await request({ op: "automation-http", path, token, body: JSON.stringify({ padding: "x".repeat(1500) }) });
  assert.equal(oversized.status, 413);
  const costs = [];
  for (let n = 0; n < 3; n++) {
    const applied = await request({ op: "automation-http", path, token, body: '{"dryRun":false,"confirm":"purge-terminal-sync-history"}' });
    assert.equal(applied.status, 200); assert.equal(applied.body.dryRun, false);
    assert.deepEqual(applied.body.deleted, { fragments: n === 2 ? 5 : 100, items: n === 2 ? 5 : 100, tasks: n === 2 ? 1 : 0 });
    assert.equal(applied.body.hasCandidates, n !== 2); assert.ok(applied.budget.used.d1 <= 40); assert.equal(applied.budget.used.external, 0);
    assert.deepEqual(applied.budget.reserved, { d1: 0, external: 0 }); costs.push(applied.budget.used.d1);
  }
  assert.equal(await d1.prepare("SELECT count(*) AS n FROM sync_tasks WHERE id='latest'").first("n"), 1);
  assert.equal(await d1.prepare("SELECT value FROM cache WHERE key='history:legacy'").first("value"), "keep");
  assert.equal(await d1.prepare("SELECT count(*) AS n FROM logs WHERE category='operation'").first("n"), 3);
  t.diagnostic(`Synthetic history HTTP D1 costs: ${JSON.stringify(costs)}, external=0`);
});

test("workerd/D1 history: audit failure rolls back child and task deletions", async t => {
  const { request, d1 } = await fixture(t);
  const { token } = await request({ op: "automation-init", provider: "cloudflare" });
  await d1.exec("INSERT INTO sync_tasks(id,generation,account_id,provider,scope_revision,mode,phase,status,last_completed_at,created_at,updated_at) VALUES('old','old',1,'cloudflare',1,'full','done','completed',100,100,1),('latest','latest',1,'cloudflare',1,'full','done','completed',200,200,1)");
  await d1.exec("INSERT INTO sync_fragments VALUES('old','old','dns','offline',1,'[]'); INSERT INTO sync_items VALUES('old','old','seen','1',NULL)");
  await d1.exec("CREATE TRIGGER history_audit_failure BEFORE INSERT ON logs WHEN NEW.category='operation' BEGIN SELECT RAISE(ABORT,'offline audit failure'); END");
  const result = await request({ op: "automation-http", path: "/api/sync/history/maintenance", token, body: '{"dryRun":false,"confirm":"purge-terminal-sync-history"}' });
  assert.equal(result.status, 500); assert.equal(result.budget.used.external, 0);
  for (const table of ["sync_fragments", "sync_items"]) assert.equal(await d1.prepare(`SELECT count(*) AS n FROM ${table}`).first("n"), 1);
  assert.equal(await d1.prepare("SELECT count(*) AS n FROM sync_tasks").first("n"), 2);
  assert.equal(await d1.prepare("SELECT count(*) AS n FROM logs").first("n"), 0);
});

test("workerd/D1: DNSHE full snapshot really advances one upstream page per HTTP invocation", async t => {
  const calls = [];
  const { request, d1 } = await fixture(t, request => {
    const url = new URL(request.url); calls.push(url);
    const endpoint = url.searchParams.get("endpoint");
    if (endpoint === "subdomains") return Response.json({ success: true, total: 1, subdomains: [{ id: 101, subdomain: "offline", rootdomain: "example.test", full_domain: "offline.example.test", status: "active", created_at: "", expires_at: "2027-01-01" }] });
    if (endpoint === "dns_records") return Response.json({ success: true, records: [{ id: url.searchParams.get("cursor"), name: "@", type: "A", content: "192.0.2.1", ttl: 60 }], pagination: url.searchParams.get("cursor") === "0" ? { has_more: true, next_cursor: "1" } : { has_more: false } });
    throw new Error(`Unplanned outbound endpoint: ${endpoint}`);
  });
  const { token } = await request({ op: "automation-init" });
  let taskId, completed = false;
  for (let i = 0; i < 12; i++) {
    const before = calls.length;
    const result = await request({ op: "automation-http", token, body: JSON.stringify({ manual: true, taskId }) });
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.ok(result.budget.used.d1 <= 40); assert.ok(result.budget.used.external <= 1); assert.ok(calls.length - before <= 1);
    taskId = result.body.taskId;
    if (result.body.status === "completed") { completed = true; break; }
    assert.equal(result.body.status, "queued", JSON.stringify(result.body));
  }
  assert.equal(completed, true); assert.equal(calls.length, 3);
  const cache = await d1.prepare("SELECT value FROM cache WHERE key='api_cache:dns:101'").first("value");
  assert.equal(JSON.parse(cache).length, 2);
  const successLogs = await d1.prepare("SELECT COUNT(*) AS n FROM logs WHERE category='sync' AND type='success'").first("n");
  assert.equal(successLogs, 1);
});

test("workerd/D1: confirmed budget pause returns HTTP 200 and the next invocation resumes with fresh capacity", async t => {
  let calls = 0;
  const { request, d1 } = await fixture(t, () => { calls++; return Response.json({ success: true, total: 0, subdomains: [] }); });
  const { token } = await request({ op: "automation-init" });
  const first = await request({ op: "automation-http", token });
  assert.equal(first.status, 200); assert.equal(calls, 0);
  const taskId = first.body.taskId;
  const before = await d1.prepare("SELECT cursor FROM sync_tasks WHERE id=?").bind(taskId).first("cursor");
  const limited = await request({ op: "automation-http", token, external: "0", body: JSON.stringify({ manual: true, taskId }) });
  assert.equal(limited.status, 200, JSON.stringify(limited.body)); assert.equal(limited.body.success, true);
  assert.equal(limited.body.status, "paused"); assert.equal(limited.body.budget_yield, true); assert.equal(calls, 0);
  assert.ok(limited.body.retry_after_ms > 0 && limited.body.retry_after_ms <= 1000);
  assert.equal(limited.budget.reserved.d1, 0); assert.ok(limited.budget.used.d1 <= 40);
  assert.equal(await d1.prepare("SELECT cursor FROM sync_tasks WHERE id=?").bind(taskId).first("cursor"), before);
  const detail = JSON.parse(await d1.prepare("SELECT details FROM logs ORDER BY id DESC LIMIT 1").first("details"));
  assert.equal(detail.resource, "external"); assert.equal(detail.reason, "exhausted"); assert.equal(detail.used, 0); assert.equal(detail.reserved, 0); assert.equal(detail.limit, 0); assert.equal(detail.phase, "list");
  await d1.prepare("UPDATE sync_tasks SET next_attempt_at=0 WHERE id=?").bind(taskId).run();
  const resumed = await request({ op: "automation-http", token, body: JSON.stringify({ manual: true, taskId }) });
  assert.equal(resumed.status, 200); assert.equal(resumed.body.taskId, taskId); assert.equal(resumed.body.status, "queued");
  assert.equal(resumed.body.budget_yield, false); assert.equal(calls, 1);
});

test("workerd/D1 scale: authenticated 26-account plan and multi-page CF snapshots retain strict budgets", async t => {
  const calls = [];
  const { request, d1 } = await fixture(t, req => {
    const url = new URL(req.url);
    assert.equal(req.method, "GET"); assert.equal(url.pathname, "/client/v4/zones");
    const account = req.headers.get("Authorization") === "Bearer offline-secret" ? "offline-key" : req.headers.get("Authorization") === "Bearer offline-token-26" ? "offline-26" : null;
    const page = Number(url.searchParams.get("page"));
    assert.ok(["offline-key", "offline-26"].includes(account)); assert.ok(page >= 1 && page <= 3);
    calls.push(`${account}:${page}`);
    const zones = Array.from({ length: Math.min(50, 105 - (page - 1) * 50) }, (_, n) => ({
      id: `${account}-${(page - 1) * 50 + n}`, name: `${account}-${(page - 1) * 50 + n}.example.test`, status: "active", account: { id: account },
    }));
    return Response.json({ success: true, result: zones, result_info: { page, per_page: 50, count: zones.length, total_count: 105, total_pages: 3 } });
  });
  const { token } = await request({ op: "automation-init", provider: "cloudflare" });
  await d1.batch(Array.from({ length: 25 }, (_, n) => d1.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(?,'offline',?,'plain:b2ZmbGluZS1zZWNyZXQ=','cloudflare')").bind(n + 2, `offline-${n + 2}`)));
  await d1.prepare("UPDATE accounts SET api_secret=? WHERE id=26").bind(`plain:${btoa("offline-token-26")}`).run();
  for (const id of [1, 26]) await d1.batch(Array.from({ length: 30 }, (_, n) => d1.prepare(`INSERT INTO sync_tasks(id,generation,account_id,provider,scope_revision,mode,phase,status,last_completed_at,created_at,updated_at)
    VALUES(?,'offline',?,'cloudflare',1,'full','done','completed',100,100,100)`).bind(`history-${id}-${n}`, id)));
  const page1 = await request({ op: "automation-http", path: "/api/sync/plan", token, body: '{"manual":true}' });
  const page2 = await request({ op: "automation-http", path: "/api/sync/plan", token, body: JSON.stringify({ manual: true, after: page1.body.nextAfter }) });
  assert.deepEqual(page1.body.plans.map(row => row.accountId), Array.from({ length: 25 }, (_, n) => n + 1));
  assert.equal(page1.body.plans[0].taskId, "history-1-29"); assert.equal(page2.body.plans[0].taskId, "history-26-29");
  assert.equal(page2.body.nextAfter, null); assert.equal(calls.length, 0);
  for (const page of [page1, page2]) { assert.equal(page.status, 200); assert.ok(page.budget.used.d1 <= 40); assert.equal(page.budget.used.external, 0); }
  const costs = [];
  for (const id of [1, 26]) {
    let taskId, state;
    for (let n = 0; n < 20; n++) {
      const before = calls.length, start = performance.now();
      const response = await request({ op: "automation-http", path: `/api/accounts/${id}/sync-step`, token, body: JSON.stringify({ manual: true, taskId }) });
      assert.equal(response.status, 200, JSON.stringify(response.body)); state = response.body;
      if (taskId) assert.equal(state.taskId, taskId); taskId = state.taskId;
      assert.ok(response.budget.used.d1 <= 40); assert.equal(response.budget.used.external, calls.length - before); assert.ok(calls.length - before <= 1);
      assert.deepEqual(response.budget.reserved, { d1: 0, external: 0 });
      costs.push({ d1: response.budget.used.d1, external: response.budget.used.external, ms: performance.now() - start });
      if (state.status === "completed") break;
      assert.equal(state.status, "queued", JSON.stringify(state));
    }
    assert.equal(state.status, "completed"); assert.equal(state.domain_count, 105);
    assert.equal(await d1.prepare("SELECT count(*) AS n FROM domains_cache WHERE account_id=?").bind(id).first("n"), 105);
  }
  assert.deepEqual(calls, ["offline-key:1", "offline-key:2", "offline-key:3", "offline-26:1", "offline-26:2", "offline-26:3"]);
  assert.equal(await d1.prepare("SELECT count(*) AS n FROM logs WHERE category='sync' AND type='success'").first("n"), 2);
  t.diagnostic(`Synthetic HTTP scale cost: ${JSON.stringify({ invocations: costs.length, d1: costs.reduce((n, c) => n + c.d1, 0), external: calls.length, maxD1: Math.max(...costs.map(c => c.d1)), maxMs: Math.max(...costs.map(c => c.ms)), cloudCpuMs: null })}`);
});

test("workerd/D1: scheduled/Node shared Cron uses no list/DNS/RDAP calls", async t => {
  const { request } = await fixture(t);
  await request({ op: "automation-init", provider: "cloudflare" });
  const result = await request({ op: "automation-cron" });
  assert.equal(result.budget.used.external, 0); assert.ok(result.budget.used.d1 <= 40); assert.equal(result.budget.strict, true);
});

test("workerd/D1: legacy manual full-sync route returns local sliced plan, not renewal or waitUntil", async t => {
  const { request } = await fixture(t);
  const { token } = await request({ op: "automation-init" });
  const result = await request({ op: "automation-http", path: "/api/domains/sync", token });
  assert.equal(result.body.syncPlan, true); assert.equal(result.budget.used.external, 0); assert.equal(result.body.plans.length, 1);
});

test("workerd/D1: real renewal HTTP entry persists intent and stays within strict invocation budgets", async t => {
  const calls = [];
  const { request, d1 } = await fixture(t, req => {
    const url = new URL(req.url); calls.push({ method: req.method, action: url.searchParams.get("action") });
    assert.equal(req.method, "POST"); assert.equal(url.searchParams.get("action"), "renew");
    return Response.json({ success: true, new_expires_at: "2027-11-02" });
  });
  const { token } = await request({ op: "automation-init" });
  await d1.prepare("INSERT INTO domains_cache(id,account_id,subdomain,rootdomain,full_domain,status,expires_at) VALUES(101,1,'offline','example.test','offline.example.test','active','2026-11-02')").run();
  const result = await request({ op: "automation-http", path: "/api/domains/101/renew", token });
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.success, true);
  assert.equal(result.budget.used.external, 1); assert.ok(result.budget.used.d1 <= 40); assert.equal(result.budget.reserved.d1, 0);
  assert.equal(await d1.prepare("SELECT status FROM renewal_intents WHERE domain_id=101").first("status"), "completed");
  const repeat = await request({ op: "automation-http", path: "/api/domains/101/renew", token });
  assert.equal(repeat.status, 409); assert.equal(calls.length, 1);
});
