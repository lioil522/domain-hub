/**
 * 华为云 SDK-HMAC-SHA256 签名自检
 *
 * 跑法：npm run test:signature
 *
 * 为什么值得单独钉住：这类代码「看起来对」与「真的对」之间只差一个字符，
 * 而错任何一个字符，症状**完全一样** —— 网关一律回 APIGW.0301「认证失败」。
 * 于是所有签名 bug 都伪装成「AK/SK 填错了」，逼着用户去控制台反复核对凭据，
 * 而凭据根本没问题。真正能确诊的只有外部金标准：华为云官方《API 签名指南》
 * 里给出的那个规范请求哈希。
 *
 * 本文件的核心就是那一条金标准断言 —— 它曾直接定位出「规范 URI 漏了尾斜杠」
 * 这个让华为云账号**永远绑不上**的缺陷。
 */
import assert from "node:assert/strict";

import { buildHuaweiCanonicalRequest, HuaweiCloudClient } from "../src/huaweicloud";

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

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 请求体为空字符串的 SHA-256（GET / DELETE 用） */
const EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// ── 华为云官方文档示例（《API 签名指南》2.2 构造规范请求，VPC 查询列表接口）──
const DOC = {
  method: "GET",
  path: "/v1/77b6a44cba5143ab91d13ab9a8ff44fd/vpcs",
  query: { limit: 2, marker: "13551d6b-755d-4757-b956-536f674975c0" },
  headers: [
    ["content-type", "application/json"],
    ["host", "service.region.example.com"],
    ["x-sdk-date", "20191115T033655Z"],
  ] as Array<[string, string]>,
  /** 文档给出的 HashedCanonicalRequest —— 不可改动，这是外部金标准 */
  expectedCanonicalHash: "b25362e603ee30f4f25e7858e8a7160fd36e803bb2dfe206278659d71a9bcd7a",
};

async function main(): Promise<void> {
  console.log("华为云 SDK-HMAC-SHA256 签名");

  await it("规范请求与华为云官方文档示例逐字节一致（金标准哈希）", async () => {
    const { canonicalRequest, signedHeaders, canonicalQuery } = buildHuaweiCanonicalRequest({
      method: DOC.method,
      path: DOC.path,
      query: DOC.query,
      headers: DOC.headers,
      payloadHash: EMPTY_BODY_HASH,
    });

    assert.equal(await sha256Hex(canonicalRequest), DOC.expectedCanonicalHash);
    assert.equal(signedHeaders, "content-type;host;x-sdk-date");
    assert.equal(canonicalQuery, "limit=2&marker=13551d6b-755d-4757-b956-536f674975c0");

    // 规范消息头每条都以换行结尾（含最后一条），叠加 join 的分隔换行 →
    // SignedHeaders 之前必然出现一个空行。文档原文：「因此会出现一个空行」。
    assert.ok(
      canonicalRequest.includes("x-sdk-date:20191115T033655Z\n\ncontent-type;host;x-sdk-date"),
      "规范消息头与 SignedHeaders 之间应有一个空行"
    );
  });

  await it("签名用的规范 URI 必须补尾斜杠（这就是曾经绑不上华为云的原因）", async () => {
    const withSlash = buildHuaweiCanonicalRequest({
      method: DOC.method,
      path: DOC.path,
      query: DOC.query,
      headers: DOC.headers,
      payloadHash: EMPTY_BODY_HASH,
    });
    assert.equal(withSlash.signedPath, `${DOC.path}/`);
    assert.equal(await sha256Hex(withSlash.canonicalRequest), DOC.expectedCanonicalHash);

    // 反证：漏掉尾斜杠会算出另一个哈希 —— 网关永远算不出这个值，于是恒判认证失败。
    const noSlash = buildHuaweiCanonicalRequest({
      method: DOC.method,
      path: `${DOC.path}/`,
      query: DOC.query,
      headers: [...DOC.headers],
      payloadHash: EMPTY_BODY_HASH,
    });
    assert.equal(noSlash.signedPath, `${DOC.path}/`, "已带尾斜杠时不得重复追加");

    const stripped = ["GET", DOC.path, withSlash.canonicalQuery, "content-type:application/json\nhost:service.region.example.com\nx-sdk-date:20191115T033655Z\n", "content-type;host;x-sdk-date", EMPTY_BODY_HASH].join("\n");
    assert.notEqual(await sha256Hex(stripped), DOC.expectedCanonicalHash);
  });

  await it("规范查询串按 RFC 3986 编码：空格为 %20，保留字额外编码", () => {
    // encodeURIComponent 会把空格编成 %20（正确），但会漏掉 !'()* —— 需要补编
    const { canonicalQuery } = buildHuaweiCanonicalRequest({
      method: "GET",
      path: "/v2/zones",
      query: { name: "a b", remark: "it's(1)*", "!" : "z" },
      headers: [["host", "dns.myhuaweicloud.com"], ["x-sdk-date", "20191115T033655Z"]],
      payloadHash: EMPTY_BODY_HASH,
    });
    assert.ok(!canonicalQuery.includes("+"), "空格不得编码成表单式的 +");
    assert.ok(canonicalQuery.includes("a%20b"));
    assert.ok(canonicalQuery.includes("it%27s%281%29%2A"));
    // 参数名按字符码升序：! (0x21) 排在 name / remark 之前
    assert.ok(canonicalQuery.startsWith("%21=z&"), `实际: ${canonicalQuery}`);
  });

  await it("空值查询参数被丢弃，不产生 `key=` 空串", () => {
    const { canonicalQuery } = buildHuaweiCanonicalRequest({
      method: "GET",
      path: "/v2/zones",
      query: { limit: 100, offset: 0, marker: undefined, name: null, status: "" },
      headers: [["host", "dns.myhuaweicloud.com"], ["x-sdk-date", "20191115T033655Z"]],
      payloadHash: EMPTY_BODY_HASH,
    });
    // offset=0 必须保留 —— 0 是合法值，只有 undefined/null/"" 才算缺省
    assert.equal(canonicalQuery, "limit=100&offset=0");
  });

  await it("请求走全局终端节点，且签名与实际下发的查询串完全一致", async () => {
    const realFetch = globalThis.fetch;
    const seen: Array<{ url: string; auth: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: String((init?.headers as Record<string, string>)?.Authorization || "") });
      return new Response(JSON.stringify({ zones: [], metadata: { total_count: 0 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const client = new HuaweiCloudClient("AKGLOBALENDPOINTTEST", "not-a-real-secret-value");
      const zones = await client.listDomains();
      assert.deepEqual(zones, []);

      assert.equal(seen.length, 1);
      // 默认必须是全局节点（同时服务中国站与国际站），而不是写死的华北-北京四
      assert.ok(seen[0].url.startsWith("https://dns.myhuaweicloud.com/v2/zones?"), seen[0].url);
      assert.ok(seen[0].url.includes("limit=100"), seen[0].url);
      assert.ok(seen[0].url.includes("type=public"), seen[0].url);
      assert.ok(seen[0].auth.startsWith("SDK-HMAC-SHA256 Access=AKGLOBALENDPOINTTEST, SignedHeaders=host;x-sdk-date, Signature="));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await it("终端节点不可达时自动顺延到下一个候选节点", async () => {
    const realFetch = globalThis.fetch;
    const hosts: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const host = new URL(String(input)).host;
      hosts.push(host);
      if (host === "dns.myhuaweicloud.com") throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ zones: [{ id: "z1", name: "example.com." }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const client = new HuaweiCloudClient("AKFALLBACKTEST", "not-a-real-secret-value");
      const zones = await client.listDomains();
      assert.equal(zones.length, 1);
      assert.deepEqual(hosts, ["dns.myhuaweicloud.com", "dns.cn-north-4.myhuaweicloud.com"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await it("认证失败不在候选节点间重试（凭据结论与节点无关）", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ error_code: "APIGW.0301", error_msg: "Incorrect IAM authentication information: Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      const client = new HuaweiCloudClient("AKAUTHFAILTEST", "not-a-real-secret-value");
      await assert.rejects(() => client.listDomains(), /华为云认证失败/);
      // 4 个候选节点全试一遍会让用户白等 4 倍时间，且错误信息一模一样
      assert.equal(calls, 1, "认证失败应只请求一次就抛出");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  console.log(`\n${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

await main();
