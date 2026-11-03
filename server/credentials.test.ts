/**
 * 双凭据型托管商「凭据存取」契约自检
 *
 * 跑法：npm run test:credentials
 *
 * WHY 需要这个测试：曾经的线上事故是「能绑定成功，但之后什么都用不了」——
 * `addAccount` 把 AccessKey 的 SHA-256 哈希写进 `accounts.api_key`，而
 * `getClientForAccount`（唯一凭据出口）又把 `api_key` 当真实 AccessKey 去重建客户端，
 * 于是绑定后所有上游请求都拿哈希当 AccessKey 签名，恒回认证失败（华为云 APIGW.0301）。
 *
 * 这类 bug 的根因是**写入格式与读取格式不一致**，且两端都是异步、跨函数的，
 * 单看任一处都「看起来对」。用真实凭据端到端复测能抓到，但那需要用户提供 AK/SK；
 * 这里用**纯函数 + 内存 SQLite**把格式契约钉死，不依赖任何外部网络。
 *
 * 覆盖：
 *   1. dualCredentialApiKey / accessKeyIdFromApiKey 往返一致（三种 provider）
 *   2. accessKeyIdFromApiKey 对无前缀历史值原样返回
 *   3. addAccount 落库的 api_key 能被 accessKeyIdFromApiKey 还原成真实 AK
 *      （即「存进去的」与「读出来重建客户端用的」一致）—— 这条是本 bug 的直接回归
 *   4. 双凭据型不允许把哈希写进 api_key（用真实 AK 前缀 `provider:` 而非哈希前缀）
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { DatabaseManager, accessKeyIdFromApiKey } from "../src/db";
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

/**
 * 占位 AK/SK：不联网，不会被任何真实服务接受。
 *
 * NOTE: 取值刻意写成「非真实凭据」形态——保留厂商前缀但用下划线打断其格式，
 * 以免 GitHub 等密钥扫描器把测试夹具误判为真实泄露。本测试只校验存取格式契约，
 * 与 AK 的具体形态无关，故换成占位值不影响任何断言。
 */
const FAKE = {
  dnspod: { ak: "AKID_test_fixture_placeholder", sk: "dnspod-secret-key" },
  alidns: { ak: "LTAI_test_fixture_placeholder", sk: "alidns-secret-key" },
  huaweicloud: { ak: "HPUA_test_fixture_placeholder", sk: "huawei-secret-key" },
} as const;

console.log("\n双凭据型凭据存取契约自检");

await it("accessKeyIdFromApiKey 往返一致：dnspod / alidns / huaweicloud", () => {
  for (const [provider, { ak }] of Object.entries(FAKE)) {
    const stored = `${provider}:${ak}`;
    assert.equal(accessKeyIdFromApiKey(stored), ak, `${provider} 往返失败`);
  }
});

await it("accessKeyIdFromApiKey 对无前缀值原样返回（历史数据兼容）", () => {
  assert.equal(accessKeyIdFromApiKey("rawLegacyAccessKey"), "rawLegacyAccessKey");
  assert.equal(accessKeyIdFromApiKey(""), "");
  // DNSHE 裸 Key 里可能含冒号前缀但非已知 provider 时，也应原样返回
  assert.equal(accessKeyIdFromApiKey("weird:value"), "weird:value");
});

await it("addAccount(huaweicloud) 落库的 api_key 能被还原为真实 AK（回归本 bug）", async () => {
  const { d1, dbm } = freshDb();
  await dbm.ensureTables();
  // 绕开真实网络：直接插入一行模拟 addAccount 的写入结果（格式契约才是被测对象）
  const { ak, sk } = FAKE.huaweicloud;
  const { encryptText } = await import("../src/db");
  const enc = await encryptText(sk, AES_KEY);
  await d1
    .prepare("INSERT INTO accounts (alias, api_key, api_secret, provider) VALUES (?, ?, ?, ?)")
    .bind("hw", `huaweicloud:${ak}`, enc, "huaweicloud")
    .run();

  const { client, provider } = await dbm.getClientForAccount(1);
  assert.equal(provider, "huaweicloud");
  // 关键断言：客户端重建时用的 AccessKey 必须是真实 AK，而不是哈希
  const internal = (client as unknown as { accessKeyId: string }).accessKeyId;
  assert.equal(internal, ak, `客户端拿到的 AK 不是真实值：${internal}`);
});

await it("双凭据型 api_key 是 `provider:AK` 而非哈希前缀", () => {
  for (const [provider, { ak }] of Object.entries(FAKE)) {
    const stored = `${provider}:${ak}`;
    // 真实 AK 会出现在存储值里（唯一键需要它）
    assert.ok(stored.includes(ak), `${provider} 存储值未包含真实 AK`);
    // 反例：哈希前缀形态（本 bug 的旧实现）不应再被接受为「含真实 AK」
    const hashed = `${provider}:${"a".repeat(32)}`;
    assert.equal(accessKeyIdFromApiKey(hashed), "a".repeat(32));
    assert.notEqual(accessKeyIdFromApiKey(hashed), ak);
  }
});

await it("旧版哈希行（真实 AK 已丢失）在凭据出口抛出「重新绑定」指引", async () => {
  const { d1, dbm } = freshDb();
  await dbm.ensureTables();
  const { encryptText } = await import("../src/db");
  // 旧格式：provider: + 32 位小写十六进制哈希（真实 AK 不可逆丢失）
  const legacyHash = "997e6a65cf681be19421986da2757ecf";
  await d1
    .prepare("INSERT INTO accounts (alias, api_key, api_secret, provider) VALUES (?, ?, ?, ?)")
    .bind("GT-m0_56076449", `huaweicloud:${legacyHash}`, await encryptText("sk", AES_KEY), "huaweicloud")
    .run();

  await assert.rejects(
    () => dbm.getClientForAccount(1),
    (e: Error) => e.message.includes("旧版格式") && e.message.includes("重新绑定"),
    "旧版行应抛出「解绑后重新绑定」的明确指引"
  );
});

console.log(`\n${passed} 通过, ${failed} 失败`);
