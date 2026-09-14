/**
 * D1 → SQLite 适配层自检
 *
 * 跑法：npm run test:node
 *
 * 目的不是覆盖业务逻辑，而是钉住适配层与 D1 的行为差异 —— 这些点一旦跑偏，
 * 症状都是「Cloudflare 上正常、自建版数据莫名其妙」，不容易一眼看出来：
 *   · batch() 的原子性（syncAccountDomains 把 UPSERT 与 DELETE 混在一批里）
 *   · bind() 的不可变语义（buildDomainUpsert 的返回值同时给 run() 和 batch() 用）
 *   · meta.changes（purgeExpiredCache / pruneExpiredLogs 靠它报告清理条数）
 *   · first() 无行时返回 null 而不是 undefined
 *   · 外键级联（deleteAccount 依赖 ON DELETE CASCADE 清 domains_cache）
 *   · AES-GCM / PBKDF2 在 Node 的 WebCrypto 上与 Workers 行为一致
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { DatabaseManager, DATA_EXPORT_VERSION } from "../src/db";
import type { UpstreamSubdomain } from "../src/db";
import { createD1FromSqlite } from "./d1-sqlite";

const AES_KEY = "test-only-key-do-not-reuse";

let passed = 0;
let failed = 0;
async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    // NOTE: 失败信息必须拼进同一条 console.error —— 分两条打时，stdout 的 ✓/✗
    // 与 stderr 的错误堆栈在管道里会交错，出现「打印了 Error 却仍显示 ✓」的错觉，
    // 让人误以为这条过了。汇成一条并带上 ✗ 前缀，肉眼与 CI 都不会看错。
    const detail = e instanceof Error ? (e.stack || e.message) : String(e);
    console.error(`  ✗ ${name}\n${detail}`);
    process.exitCode = 1;
  }
}

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const d1 = createD1FromSqlite(sqlite);
  return { sqlite, d1, dbm: new DatabaseManager(d1, AES_KEY) };
}

function sub(id: number, name: string, extra: Partial<UpstreamSubdomain> = {}): UpstreamSubdomain {
  return {
    id,
    subdomain: name,
    rootdomain: "cn.mt",
    full_domain: `${name}.cn.mt`,
    status: "已解析",
    created_at: "2026-01-01 00:00:00",
    expires_at: "2027-01-01 00:00:00",
    dns_state_known: true,
    has_dns: 1,
    dns_provider: "system",
    ...extra,
  };
}

console.log("\nD1 → SQLite 适配层自检");

const { sqlite, d1, dbm } = freshDb();

await it("ensureTables() 建表成功（走 batch + PRAGMA table_info）", async () => {
  assert.equal(await dbm.ensureTables(), true);
  const tables = await d1
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>();
  const names = tables.results.map((r) => r.name);
  for (const expected of ["accounts", "cache", "domains_cache", "logs", "settings"]) {
    assert.ok(names.includes(expected), `缺少表 ${expected}`);
  }
});

await it("first() 无匹配行时返回 null（D1 语义，非 undefined）", async () => {
  const row = await d1.prepare("SELECT id FROM accounts WHERE id = ?").bind(999).first();
  assert.equal(row, null);
});

await it("run() 回报 meta.changes 与 meta.last_row_id", async () => {
  const res = await d1
    .prepare("INSERT INTO accounts (alias, api_key, api_secret) VALUES (?, ?, ?)")
    .bind("测试账号", "cfsd_test_key", "plain:c2VjcmV0")
    .run();
  assert.equal(res.meta.changes, 1);
  assert.equal(res.meta.last_row_id, 1);
  assert.equal(res.success, true);
});

await it("setSetting/getSetting 往返，且 UPSERT 覆盖旧值", async () => {
  await dbm.setSetting("probe", "v1");
  assert.equal(await dbm.getSetting("probe"), "v1");
  await dbm.setSetting("probe", "v2");
  assert.equal(await dbm.getSetting("probe"), "v2");
});

await it("PBKDF2 密码哈希与校验（Node WebCrypto）", async () => {
  await dbm.setPassword("admin", "Sm0keTest!2026");
  assert.equal(await dbm.verifyPassword("Sm0keTest!2026"), true);
  assert.equal(await dbm.verifyPassword("wrong-password"), false);
  const cfg = await dbm.getAuthConfig();
  assert.equal(cfg.username, "admin");
  assert.equal(cfg.initialized, true);
});

await it("AES-GCM 加密的 2FA 密钥可原文取回", async () => {
  await dbm.setTwoFaSecret("JBSWY3DPEHPK3PXP");
  const cfg = await dbm.getAuthConfig();
  assert.equal(cfg.twoFaSecret, "JBSWY3DPEHPK3PXP");
  // 库里存的必须是密文
  const stored = await dbm.getSetting("auth_2fa_secret");
  assert.ok(stored && !stored.includes("JBSWY3DPEHPK3PXP"), "2FA 密钥不应以明文落库");
});

await it("syncAccountDomains() 批量写入（batch + buildDomainUpsert）", async () => {
  await dbm.syncAccountDomains(1, [sub(101, "alpha"), sub(102, "beta"), sub(103, "gamma")]);
  const domains = await dbm.getDomains();
  assert.equal(domains.length, 3);
  assert.deepEqual(
    domains.map((d) => d.full_domain).sort(),
    ["alpha.cn.mt", "beta.cn.mt", "gamma.cn.mt"]
  );
  // LEFT JOIN 出来的账号别名
  assert.equal(domains[0].account_alias, "测试账号");
});

await it("syncAccountDomains() 会删除上游已不存在的域名（同一批里混 DELETE）", async () => {
  await dbm.syncAccountDomains(1, [sub(101, "alpha"), sub(102, "beta")]);
  const left = (await dbm.getDomains()).map((d) => d.id).sort();
  assert.deepEqual(left, [101, 102]);
});

await it("upsertAccountDomains() 只增不删（分片续拉时不能误删未拉到的分片）", async () => {
  // 先落一份完整的账号快照
  await dbm.syncAccountDomains(1, [sub(101, "alpha"), sub(102, "beta"), sub(103, "gamma")]);
  // 模拟「分片续拉」：只拿到上游第 2 页的一小部分，此时绝不能把 101/102 当作用户已删域名清掉
  await dbm.upsertAccountDomains(1, [sub(103, "gamma", { expires_at: "2029-03-03 00:00:00" }), sub(104, "delta")]);
  const ids = (await dbm.getDomains()).map((d) => d.id).sort();
  assert.deepEqual(ids, [101, 102, 103, 104], "upsertAccountDomains 不应删除任何行");
  // 分片里带的新值仍然要生效（走的是同一个 buildDomainUpsert）
  assert.equal((await dbm.getDomainById(103))?.expires_at, "2029-03-03 00:00:00");

  // 对照：同一次调用改走 syncAccountDomains 就会按差集删掉 101/102
  await dbm.syncAccountDomains(1, [sub(103, "gamma"), sub(104, "delta")]);
  assert.deepEqual((await dbm.getDomains()).map((d) => d.id).sort(), [103, 104]);
});

await it("upsertAccountDomains() 空数组时不发起任何写操作", async () => {
  await dbm.syncAccountDomains(1, [sub(201, "keep"), sub(202, "keep2")]);
  const before = (await dbm.getDomains()).map((d) => d.id).sort();
  await dbm.upsertAccountDomains(1, []);
  assert.deepEqual((await dbm.getDomains()).map((d) => d.id).sort(), before);
});

await it("dns_state_known 缺失时不覆盖已识别出的三态", async () => {
  await dbm.syncAccountDomains(1, [
    sub(101, "alpha", { dns_state_known: true, status: "已委派", has_dns: 0, dns_provider: "Cloudflare" }),
    sub(102, "beta"),
  ]);
  // 第二次同步不带 dns_state_known（模拟 subdomains/list 没有解析记录）
  await dbm.syncAccountDomains(1, [
    sub(101, "alpha", { dns_state_known: undefined, status: "active", dns_provider: undefined, has_dns: undefined, ns1: "ns1.cloudflare.com" }),
    sub(102, "beta"),
  ]);
  const alpha = await dbm.getDomainById(101);
  assert.equal(alpha?.status, "已委派", "三态被上游注册态覆盖了");
  assert.equal(alpha?.dns_provider, "Cloudflare");
});

await it("CF 快路径行可正常落库（provider 过滤 + provider_account_id/remote_id 写入）", async () => {
  // 建一个 Cloudflare 账号，它的 zone 行就是 DNSHE 快路径的比对基准
  await d1
    .prepare("INSERT INTO accounts (id, alias, api_key, api_secret, provider) VALUES (?, ?, ?, ?, ?)")
    .bind(50, "CF主账号", "cfsd_cf_key", "plain:c2VjcmV0", "cloudflare")
    .run();
  await dbm.syncAccountDomains(50, [
    {
      id: 7001,
      subdomain: "delegated",
      rootdomain: "de5.net",
      full_domain: "delegated.de5.net",
      status: "已委派",
      dns_provider: "Cloudflare",
      provider_account_id: "CF主账号",
      remote_id: "zone_abc123",
      dns_state_known: true,
      has_dns: 0,
    },
  ]);

  // provider 过滤必须把 CF zone 行单独筛出来（collectManagedCfZones 依赖它）
  const cfRows = await dbm.getDomains("", "", undefined, "cloudflare");
  assert.equal(cfRows.length, 1);
  assert.equal(cfRows[0].full_domain, "delegated.de5.net");
  assert.equal(cfRows[0].account_alias, "CF主账号");

  // 默认视图（不传 provider）必须排除 CF 行，避免 CF zone 混进 DNSHE 域名页
  const dnsheRows = await dbm.getDomains();
  assert.ok(!dnsheRows.some((d) => d.id === 7001), "CF zone 行混进了 DNSHE 默认视图");

  const row = await dbm.getDomainById(7001);
  assert.equal(row?.provider_account_id, "CF主账号");
  assert.equal(row?.remote_id, "zone_abc123");

  // NOTE: 这里刻意不清理 50 号账号与 7001 行 —— 最后的级联断言只针对 1 号账号，
  // 留着 50 号账号正好反证 deleteAccount(1) 不会误伤其它账号的域名行。
});

await it("upsertDomain() 单条写入走同一个 bind() 结果（不可变语义）", async () => {
  await dbm.upsertDomain(1, sub(104, "delta"));
  const delta = await dbm.getDomainById(104);
  assert.equal(delta?.full_domain, "delta.cn.mt");
  // 已存在的行再 upsert 一次只更新，不重复插入
  await dbm.upsertDomain(1, sub(104, "delta", { expires_at: "2028-01-01 00:00:00" }));
  assert.equal((await dbm.getDomains()).filter((d) => d.id === 104).length, 1);
  assert.equal((await dbm.getDomainById(104))?.expires_at, "2028-01-01 00:00:00");
});

await it("bind() 返回新语句，不会互相踩参数", async () => {
  const stmt = d1.prepare("SELECT ? AS v");
  const a = stmt.bind("first");
  const b = stmt.bind("second");
  assert.equal((await a.first<{ v: string }>())?.v, "first");
  assert.equal((await b.first<{ v: string }>())?.v, "second");
});

await it("batch() 出错时整批回滚", async () => {
  const before = (await dbm.getDomains()).length;
  await assert.rejects(
    d1.batch([
      d1.prepare("INSERT INTO domains_cache (id, account_id, subdomain, rootdomain, full_domain, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(901, 1, "ok", "cn.mt", "ok.cn.mt", "未解析", "2027-01-01 00:00:00"),
      // account_id = 12345 违反外键约束，整批必须回退
      d1.prepare("INSERT INTO domains_cache (id, account_id, subdomain, rootdomain, full_domain, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(902, 12345, "bad", "cn.mt", "bad.cn.mt", "未解析", "2027-01-01 00:00:00"),
    ])
  );
  assert.equal((await dbm.getDomains()).length, before, "失败的 batch 留下了半成品数据");
  assert.equal(await d1.prepare("SELECT id FROM domains_cache WHERE id = ?").bind(901).first(), null);
});

await it("缓存读写与 purgeExpiredCache() 的 meta.changes", async () => {
  await dbm.setCache("api_cache:probe", JSON.stringify({ hit: true }));
  assert.equal(await dbm.getCache("api_cache:probe"), '{"hit":true}');
  // 手动写一条已过期的缓存行
  await d1.prepare("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)")
    .bind("api_cache:stale", "x", 1).run();
  assert.equal(await dbm.getCache("api_cache:stale"), null, "过期行不该被读到");
  assert.equal(await dbm.purgeExpiredCache(), 1);
  assert.equal(await dbm.getCache("api_cache:probe"), '{"hit":true}', "未过期的行被误删");
});

await it("查重池批量查询（域名内联为字面量，绑定参数恒为 1）", async () => {
  await dbm.addToWhoisPool("taken.cn.mt");
  const hits = await dbm.getWhoisPool(["taken.cn.mt", "free.cn.mt"]);
  assert.deepEqual(hits, ["taken.cn.mt"]);
});

await it("getDnsRecordsCacheBatch() 批量读记录缓存（跳过缺失/过期/损坏项）", async () => {
  const recs = [
    { type: "A", content: "1.2.3.4" },
    { type: "NS", content: "ns1.cloudflare.com" },
  ];
  await dbm.setCache("api_cache:dns:501", JSON.stringify(recs));
  await dbm.setCache("api_cache:dns:502", JSON.stringify([{ type: "TXT", content: "x" }]));
  // 503 没有缓存行；504 已过期；505 内容损坏
  await d1.prepare("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)")
    .bind("api_cache:dns:504", "[]", 1).run();
  await dbm.setCache("api_cache:dns:505", "{not json");

  const got = await dbm.getDnsRecordsCacheBatch([501, 502, 503, 504, 505]);
  assert.deepEqual([...got.keys()].sort(), [501, 502], "只应返回有效且未过期的缓存");
  assert.deepEqual(got.get(501), recs);
  assert.deepEqual(got.get(502), [{ type: "TXT", content: "x" }]);

  // 空数组 / 非法 id 不应发起查询
  assert.equal((await dbm.getDnsRecordsCacheBatch([])).size, 0);
  assert.equal((await dbm.getDnsRecordsCacheBatch([NaN, -1, 1.5])).size, 0);

  // 大批量（超过单条 SQL 的 400 行分块）也要能全部读回
  const bulkIds = Array.from({ length: 450 }, (_, i) => 6000 + i);
  for (const id of bulkIds) {
    await dbm.setCache(`api_cache:dns:${id}`, JSON.stringify([{ type: "A", content: `10.0.${id % 256}.1` }]));
  }
  assert.equal((await dbm.getDnsRecordsCacheBatch(bulkIds)).size, 450);
});

await it("getDateOverridesByAccountIds() 批量读手动日期覆盖（按账号分桶、跳过空到期时间）", async () => {
  // domain_date_overrides.account_id 有外键约束，必须先把账号建出来
  await d1
    .prepare("INSERT INTO accounts (id, alias, api_key, api_secret) VALUES (?, ?, ?, ?)")
    .bind(3, "覆盖测试账号", "cfsd_ov_key", "plain:c2VjcmV0")
    .run();

  await dbm.upsertDateOverride(1, "a.example.com", { expires_at: "2027-01-01" });
  await dbm.upsertDateOverride(1, "b.example.com", { expires_at: "2028-02-02", source: "手动" });
  await dbm.upsertDateOverride(3, "c.example.com", { expires_at: "2029-03-03" });
  // 只有注册时间、没有到期时间的行必须被排除：它对「是否即将到期」没有意义
  await dbm.upsertDateOverride(1, "no-expiry.example.com", { registered_at: "2020-01-01" });
  // 大小写归一：库里存什么大小写，读出来都要能按小写 host 命中
  await dbm.upsertDateOverride(1, "MixedCase.example.com", { expires_at: "2030-04-04" });

  const got = await dbm.getDateOverridesByAccountIds([1, 3]);
  assert.deepEqual([...got.keys()].sort(), [1, 3], "只应有 1、3 号账号两个桶");
  const one = got.get(1)!;
  assert.equal(one.get("a.example.com"), "2027-01-01");
  assert.equal(one.get("b.example.com"), "2028-02-02");
  assert.equal(one.get("mixedcase.example.com"), "2030-04-04", "host 应归一为小写");
  assert.equal(one.has("no-expiry.example.com"), false, "无到期时间的行应被排除");
  assert.equal(got.get(3)!.get("c.example.com"), "2029-03-03");
  // 未传入的账号不应出现
  assert.equal(got.has(2), false);

  // 空数组 / 非法 id 不应发起查询
  assert.equal((await dbm.getDateOverridesByAccountIds([])).size, 0);
  assert.equal((await dbm.getDateOverridesByAccountIds([NaN, 0, -5, 1.5])).size, 0);
});

await it("getRdapExpiryCacheBatch() 批量读 RDAP 到期缓存（只认 found + expires_at）", async () => {
  const key = (d: string) => `rdap:4:${d}`;
  await dbm.setCache(key("ok.com"), JSON.stringify({ found: true, expires_at: "2027-06-01" }), 3600);
  // 查到但无到期时间 → 不给结果（不能当成「不过期」）
  await dbm.setCache(key("nodate.com"), JSON.stringify({ found: true }), 3600);
  // 注册局明确「查无此记录」（子域 zone 的典型结论）→ 不给结果
  await dbm.setCache(key("notfound.com"), JSON.stringify({ found: false }), 3600);
  // 已过期
  await d1.prepare("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)")
    .bind(key("stale.com"), JSON.stringify({ found: true, expires_at: "2020-01-01" }), 1).run();
  // 内容损坏
  await dbm.setCache(key("broken.com"), "{not json", 3600);
  // 带 error 的失败结论本来就不落缓存，这里显式验证「error 但没 expires_at」也不会误报
  await dbm.setCache(key("errored.com"), JSON.stringify({ found: false, error: "RDAP HTTP 403" }), 3600);

  const got = await dbm.getRdapExpiryCacheBatch([
    "ok.com", "nodate.com", "notfound.com", "stale.com", "broken.com", "errored.com", "missing.com",
  ]);
  assert.deepEqual([...got.keys()], ["ok.com"], "只有 found + expires_at 齐备的项才应返回");
  assert.equal(got.get("ok.com"), "2027-06-01");

  // 大小写与去重：查询键统一按小写归一，重复项只查一次
  const got2 = await dbm.getRdapExpiryCacheBatch(["OK.com", "ok.com"]);
  assert.equal(got2.get("ok.com"), "2027-06-01");

  // 空数组不应发起查询
  assert.equal((await dbm.getRdapExpiryCacheBatch([])).size, 0);
});

await it("exportAllData() 只导出业务表，且不泄漏 settings/cache/logs", async () => {
  const snap = await dbm.exportAllData();
  assert.equal(snap.version, DATA_EXPORT_VERSION);
  assert.ok(snap.exported_at, "应带导出时间戳");

  const tables = Object.keys(snap.data).sort();
  assert.deepEqual(
    tables,
    ["accounts", "custom_accounts", "custom_domains", "domain_date_overrides", "domains_cache"],
    "导出范围应恰好是 5 张业务表"
  );
  // 这三张必须**不在**导出里：settings 含 2FA 密钥与密码哈希，cache 是临时缓存，logs 是运行历史
  for (const forbidden of ["settings", "cache", "logs"]) {
    assert.equal(tables.includes(forbidden), false, `不应导出 ${forbidden} 表`);
  }
  // counts 与实际行数一致
  for (const t of tables) {
    assert.equal(snap.counts[t], (snap.data[t] as unknown[]).length, `${t} 的 counts 不符`);
  }
  assert.ok((snap.data.accounts as unknown[]).length > 0, "应有账号数据");
});

await it("importAllData() 合并 upsert：新增 + 覆盖，且不删除现有行", async () => {
  const target = freshDb();
  await target.dbm.ensureTables();

  // 目标库先放一个「备份里没有」的账号，验证导入不会把它删掉
  await target.d1
    .prepare("INSERT INTO accounts (id, alias, api_key, api_secret) VALUES (?, ?, ?, ?)")
    .bind(900, "本地独有账号", "cfsd_local_only", "plain:c2VjcmV0")
    .run();

  // 备份：1 号账号（覆盖目标库同名 id）+ 901 号账号（目标库没有，应新增）
  const snapshot = {
    version: DATA_EXPORT_VERSION,
    data: {
      accounts: [
        { id: 1, alias: "改过的别名", api_key: "k1", api_secret: "s1", provider: "dnshe", website: null, created_at: "2026-01-01 00:00:00" },
        { id: 901, alias: "备份新增账号", api_key: "k901", api_secret: "s901", provider: "dnshe", website: null, created_at: "2026-01-01 00:00:00" },
      ],
      domains_cache: [
        { id: 7001, account_id: 901, subdomain: "a", rootdomain: "cn.mt", full_domain: "a.cn.mt", status: "已解析", created_at: "2026-01-01 00:00:00", expires_at: "2027-01-01 00:00:00", last_renewed_at: null, has_dns: 1, dns_provider: "system", provider_account_id: null, remote_id: null, updated_at: "2026-01-01 00:00:00" },
      ],
      domain_date_overrides: [
        { id: 1, account_id: 901, full_domain: "a.cn.mt", registered_at: "2020-01-01", expires_at: "2027-01-01", source: "手动", updated_at: "2026-01-01 00:00:00" },
      ],
    },
  };

  const { imported } = await target.dbm.importAllData(snapshot);
  assert.equal(imported.accounts, 2);
  assert.equal(imported.domains_cache, 1);
  assert.equal(imported.custom_domains, 0, "备份里没有的表应报 0");

  const accounts = await target.dbm.getAccounts();
  assert.equal(accounts.find((a) => a.id === 1)?.alias, "改过的别名", "同 id 应被覆盖");
  assert.ok(accounts.some((a) => a.id === 901), "备份里的新账号应被插入");
  assert.ok(accounts.some((a) => a.id === 900), "本地独有账号绝不能被删掉（合并语义）");
  assert.equal((await target.dbm.getDomainById(7001))?.full_domain, "a.cn.mt");
  assert.equal((await target.dbm.getDateOverrides()).length, 1);

  target.sqlite.close();
});

await it("importAllData() 反复导入幂等（同 id 不会重复插入）", async () => {
  const target = freshDb();
  await target.dbm.ensureTables();
  const snapshot = {
    version: DATA_EXPORT_VERSION,
    data: {
      accounts: [{ id: 1, alias: "A", api_key: "k1", api_secret: "s1", provider: "dnshe", website: null, created_at: "2026-01-01 00:00:00" }],
    },
  };
  await target.dbm.importAllData(snapshot);
  await target.dbm.importAllData(snapshot);
  const accounts = await target.dbm.getAccounts();
  assert.equal(accounts.filter((a) => a.id === 1).length, 1, "同 id 反复导入不应产生重复行");
  target.sqlite.close();
});

await it("importAllData() 版本不匹配 / 结构非法时拒绝（不静默降级）", async () => {
  const target = freshDb();
  await target.dbm.ensureTables();

  await assert.rejects(
    () => target.dbm.importAllData({ version: 999, data: {} }),
    /版本不支持/,
    "版本不符必须明确拒绝"
  );
  await assert.rejects(
    () => target.dbm.importAllData({ version: DATA_EXPORT_VERSION }),
    /缺少 data 字段/
  );
  // 拒绝之后库里不该留下任何痕迹
  assert.equal((await target.dbm.getAccounts()).length, 0);
  target.sqlite.close();
});

await it("importAllData() 外键悬空时整批回滚（不留半截数据）", async () => {
  const target = freshDb();
  await target.dbm.ensureTables();
  // domains_cache 指向不存在的 account_id，外键约束必须让整批失败
  await assert.rejects(() =>
    target.dbm.importAllData({
      version: DATA_EXPORT_VERSION,
      data: {
        accounts: [{ id: 1, alias: "A", api_key: "k1", api_secret: "s1", provider: "dnshe", website: null, created_at: "2026-01-01 00:00:00" }],
        domains_cache: [{ id: 7001, account_id: 12345, subdomain: "a", rootdomain: "cn.mt", full_domain: "a.cn.mt", status: "已解析", created_at: "2026-01-01 00:00:00", expires_at: "2027-01-01 00:00:00", last_renewed_at: null, has_dns: 1, dns_provider: "system", provider_account_id: null, remote_id: null, updated_at: "2026-01-01 00:00:00" }],
      },
    })
  );
  assert.equal(
    (await target.dbm.getAccounts()).length,
    0,
    "batch 必须原子回滚 —— 账号也不该被写进去"
  );
  target.sqlite.close();
});

await it("export → import 往返一致（同库自洽）", async () => {
  // freshDb() 起手是空库，domains_cache / domain_date_overrides 都有 account_id 外键，
  // 必须先把账号建出来（否则 syncAccountDomains 会撞 FOREIGN KEY constraint failed）
  const src = freshDb();
  await src.dbm.ensureTables();
  await src.d1
    .prepare("INSERT INTO accounts (id, alias, api_key, api_secret) VALUES (?, ?, ?, ?)")
    .bind(1, "往返测试账号", "cfsd_rt_key", "plain:c2VjcmV0")
    .run();
  await src.dbm.syncAccountDomains(1, [sub(3001, "roundtrip")]);
  await src.dbm.upsertDateOverride(1, "roundtrip.cn.mt", { expires_at: "2028-08-08" });
  const snapshot = await src.dbm.exportAllData();

  const dst = freshDb();
  await dst.dbm.ensureTables();
  await dst.dbm.importAllData(snapshot);

  assert.equal((await dst.dbm.getAccounts()).length, (await src.dbm.getAccounts()).length);
  assert.equal((await dst.dbm.getDomains()).length, (await src.dbm.getDomains()).length);
  assert.equal((await dst.dbm.getDomainById(3001))?.full_domain, "roundtrip.cn.mt");
  assert.equal((await dst.dbm.getDateOverrides())[0]?.expires_at, "2028-08-08");

  src.sqlite.close();
  dst.sqlite.close();
});

await it("日志写入与按分类过滤", async () => {
  await dbm.writeLog("success", "operation", "适配层自检日志", { probe: 1 });
  const all = await dbm.getLogs(10);
  assert.ok(all.length > 0);
  const ops = await dbm.getLogs(10, ["operation"]);
  assert.ok(ops.every((l) => l.category === "operation"));
  assert.ok(ops.some((l) => l.message === "适配层自检日志"));
});

await it("markDomainRenewed() 更新到期时间与续期时间", async () => {
  await dbm.markDomainRenewed(101, "2029-01-01 00:00:00");
  const row = await dbm.getDomainById(101);
  assert.equal(row?.expires_at, "2029-01-01 00:00:00");
  assert.ok(row?.last_renewed_at);
});

await it("deleteAccount() 依赖外键级联清掉 domains_cache", async () => {
  // 1 号账号下的域名行必须存在，否则这条断言等于没测
  assert.ok((await dbm.getDomains()).some((d) => d.account_id === 1));
  // 另建一个账号与域名行：级联只能清掉被删账号的行，不能误伤别人
  await d1
    .prepare("INSERT INTO accounts (id, alias, api_key, api_secret) VALUES (?, ?, ?, ?)")
    .bind(60, "陪跑账号", "cfsd_other_key", "plain:c2VjcmV0")
    .run();
  await dbm.syncAccountDomains(60, [sub(8001, "survivor")]);

  await dbm.deleteAccount(1);
  assert.equal((await dbm.getAccounts()).some((a) => a.id === 1), false, "1 号账号没被删掉");
  assert.equal(
    (await dbm.getDomains()).some((d) => d.account_id === 1),
    false,
    "外键级联没生效，1 号账号的域名缓存成了孤儿数据"
  );
  assert.ok(
    (await dbm.getDomains()).some((d) => d.id === 8001),
    "级联误伤了其它账号的域名行"
  );
});

sqlite.close();

console.log(
  `\n${passed} 项通过${failed ? `，${failed} 项失败` : "，全部通过"}\n`
);
if (failed > 0) process.exitCode = 1;
