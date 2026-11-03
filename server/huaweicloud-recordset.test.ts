import assert from "node:assert/strict";
import {
  HuaweiCloudClient,
  formatHuaweiRecordContent,
  HuaweiApiError,
} from "../src/huaweicloud";

async function runTests() {
  console.log("华为云 RecordSet 自动合并与批量操作自检");

  // 1. formatHuaweiRecordContent
  assert.equal(formatHuaweiRecordContent("A", "1.2.3.4"), "1.2.3.4");
  assert.equal(formatHuaweiRecordContent("CNAME", "target.com"), "target.com.");
  assert.equal(formatHuaweiRecordContent("CNAME", "target.com."), "target.com.");
  assert.equal(formatHuaweiRecordContent("MX", "mail.example.com", 10), "10 mail.example.com.");
  assert.equal(formatHuaweiRecordContent("MX", "10 mail.example.com."), "10 mail.example.com.");
  console.log("  ✓ formatHuaweiRecordContent 格式化正常");

  // 2. 模拟 fetch 测试 createDnsRecord / batchCreateDnsRecords / updateDnsRecord / deleteDnsRecord
  const originalFetch = globalThis.fetch;
  try {
    let memoryRecordSets: Array<{
      id: string;
      name: string;
      type: string;
      ttl: number;
      records: string[];
      line?: string;
    }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;

      // GET /v2/zones/:zone_id/recordsets/:id
      const singleMatch = path.match(/^\/v2\/zones\/([^/]+)\/recordsets\/([^/]+)$/);
      if (singleMatch) {
        const [, , rsId] = singleMatch;
        if (method === "GET") {
          const found = memoryRecordSets.find((r) => r.id === rsId);
          if (!found) {
            return new Response(JSON.stringify({ error_code: "DNS.0305", error_msg: "Recordset not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify(found), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (method === "PUT") {
          const found = memoryRecordSets.find((r) => r.id === rsId);
          if (!found) {
            return new Response(JSON.stringify({ error_code: "DNS.0305", error_msg: "Recordset not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
          // 严格断言：华为云 UpdateRecordSet API 严禁传递 name / type / line
          assert.equal(body.name, undefined, "PUT 请求体严禁包含 name 字段");
          assert.equal(body.type, undefined, "PUT 请求体严禁包含 type 字段");
          assert.equal(body.line, undefined, "PUT 请求体严禁包含 line 字段");
          found.records = body.records;
          found.ttl = body.ttl || found.ttl;
          return new Response(JSON.stringify(found), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (method === "DELETE") {
          memoryRecordSets = memoryRecordSets.filter((r) => r.id !== rsId);
          return new Response(null, { status: 204 });
        }
      }

      // GET/POST /v2/zones/:zone_id/recordsets
      if (path.match(/^\/v2\/zones\/([^/]+)\/recordsets$/)) {
        if (method === "GET") {
          const nameQuery = url.searchParams.get("name");
          const typeQuery = url.searchParams.get("type");
          let list = [...memoryRecordSets];
          // 模拟华为云公网域名真实规范：若带末尾点查询，上游无法匹配返回空
          if (nameQuery) {
            if (nameQuery.endsWith(".")) {
              list = [];
            } else {
              list = list.filter((r) => r.name.toLowerCase().includes(nameQuery.toLowerCase()));
            }
          }
          if (typeQuery) list = list.filter((r) => r.type.toUpperCase() === typeQuery.toUpperCase());
          return new Response(JSON.stringify({ recordsets: list }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (method === "POST") {
          const exists = memoryRecordSets.find(
            (r) => r.name.toLowerCase() === body.name.toLowerCase() && r.type.toUpperCase() === body.type.toUpperCase()
          );
          if (exists) {
            // 真实华为云在线环境：HTTP 400 + DNS.0312 冲突响应
            return new Response(
              JSON.stringify({
                error_code: "DNS.0312",
                error_msg: `This record set name already exists.Conflicts with Record Set '${exists.name}' type '${exists.type}' in line 'default_view'.`
              }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }
          const newRs = {
            id: `rs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: body.name,
            type: body.type,
            ttl: body.ttl || 300,
            records: body.records || [],
            line: body.line,
          };
          memoryRecordSets.push(newRs);
          return new Response(JSON.stringify(newRs), { status: 201, headers: { "Content-Type": "application/json" } });
        }
      }

      return new Response(JSON.stringify({ error_code: "DNS.9999", error_msg: "Unknown route" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const client = new HuaweiCloudClient("AKTEST", "SKTEST", "dns.myhuaweicloud.com");

    // 2.1 测试单条创建与冲突自动并入
    const res1 = await client.createDnsRecord({
      zoneId: "zone-123",
      zoneName: "example.com",
      type: "A",
      name: "hk",
      content: "47.57.187.226",
    });
    assert.equal(res1.success, true);
    assert.equal(memoryRecordSets.length, 1);
    assert.deepEqual(memoryRecordSets[0].records, ["47.57.187.226"]);

    // 第二条同名同类型，应自动并入，不报错
    const res2 = await client.createDnsRecord({
      zoneId: "zone-123",
      zoneName: "example.com",
      type: "A",
      name: "hk",
      content: "47.57.241.115",
    });
    assert.equal(res2.success, true);
    assert.equal(memoryRecordSets.length, 1);
    assert.deepEqual(memoryRecordSets[0].records, ["47.57.187.226", "47.57.241.115"]);

    // 再次添加重复值，应幂等成功
    const res3 = await client.createDnsRecord({
      zoneId: "zone-123",
      zoneName: "example.com",
      type: "A",
      name: "hk",
      content: "47.57.187.226",
    });
    assert.equal(res3.success, true);
    assert.deepEqual(memoryRecordSets[0].records, ["47.57.187.226", "47.57.241.115"]);
    console.log("  ✓ 单条添加遭遇同名同类型时自动合并并入并保持幂等");

    // 2.2 测试批量创建 batchCreateDnsRecords
    memoryRecordSets = []; // 重置
    const batchRes = await client.batchCreateDnsRecords({
      zoneId: "zone-123",
      zoneName: "example.com",
      items: [
        { type: "A", name: "hk", content: "47.57.187.226" },
        { type: "A", name: "hk", content: "47.57.241.115" },
        { type: "A", name: "hk", content: "8.217.113.169" },
        { type: "A", name: "hk", content: "47.243.195.5" },
        { type: "A", name: "hk", content: "47.83.157.126" },
      ],
    });
    assert.equal(batchRes.successCount, 5);
    assert.equal(batchRes.failCount, 0);
    assert.equal(memoryRecordSets.length, 1);
    assert.equal(memoryRecordSets[0].records.length, 5);
    assert.deepEqual(memoryRecordSets[0].records, [
      "47.57.187.226",
      "47.57.241.115",
      "8.217.113.169",
      "47.243.195.5",
      "47.83.157.126",
    ]);
    console.log("  ✓ 批量添加 5 条同名同类型记录全部成功合并入同一 RecordSet");

    // 2.3 测试精准修改：修改下标 #1（即 47.57.241.115 -> 1.1.1.1）
    const rsId = memoryRecordSets[0].id;
    await client.updateDnsRecord({
      zoneId: "zone-123",
      zoneName: "example.com",
      record_id: `${rsId}#1`,
      type: "A",
      name: "hk",
      content: "1.1.1.1",
    });
    assert.deepEqual(memoryRecordSets[0].records, [
      "47.57.187.226",
      "1.1.1.1",
      "8.217.113.169",
      "47.243.195.5",
      "47.83.157.126",
    ]);
    console.log("  ✓ 修改多值 RecordSet 中的某一行时，只替换该行，同组其余值完整保留");

    // 2.4 测试精准删除：删除下标 #0（即 47.57.187.226）
    await client.deleteDnsRecord("zone-123", `${rsId}#0`);
    assert.equal(memoryRecordSets.length, 1);
    assert.deepEqual(memoryRecordSets[0].records, [
      "1.1.1.1",
      "8.217.113.169",
      "47.243.195.5",
      "47.83.157.126",
    ]);
    console.log("  ✓ 删除多值 RecordSet 中的某一行时，只移除该行，剩余值完整保留");

    // 2.5 测试彻底删除：当只剩 1 项时删除
    memoryRecordSets[0].records = ["1.1.1.1"];
    await client.deleteDnsRecord("zone-123", `${rsId}#0`);
    assert.equal(memoryRecordSets.length, 0);
    console.log("  ✓ 当多值 RecordSet 只剩 1 项时删除，正确触发上游整条 DELETE");

    // 2.6 测试修改主机记录（跨主机名迁移与批量合并）
    // 重新创建一条包含两个 IP 的 hk 记录集
    await client.batchCreateDnsRecords({
      zoneId: "zone-123",
      zoneName: "example.com",
      items: [
        { type: "A", name: "hk", content: "47.83.157.126", ttl: 300 },
        { type: "A", name: "hk", content: "47.243.195.5", ttl: 300 },
      ],
    });
    assert.equal(memoryRecordSets.length, 1);
    const hkRsId = memoryRecordSets[0].id;
    assert.equal(memoryRecordSets[0].name, "hk.example.com.");
    assert.deepEqual(memoryRecordSets[0].records, ["47.83.157.126", "47.243.195.5"]);

    // 修改第一条：hk -> hkcfcdn（前端勾选时的第一行下标为 #0）
    await client.updateDnsRecord({
      zoneId: "zone-123",
      zoneName: "example.com",
      record_id: `${hkRsId}#0`,
      type: "A",
      name: "hkcfcdn",
      content: "47.83.157.126",
      originContent: "47.83.157.126",
      ttl: 1, // 模拟前端传非法 TTL=1，验证华为云底层安全兜底到 300
    });
    // 此时应有两个 RecordSet：hk 剩下 47.243.195.5，hkcfcdn 拥有 47.83.157.126，且 TTL 兜底为 300
    assert.equal(memoryRecordSets.length, 2);
    const hkAfter = memoryRecordSets.find((r) => r.name === "hk.example.com.");
    const hkcfcdnAfter = memoryRecordSets.find((r) => r.name === "hkcfcdn.example.com.");
    assert.ok(hkAfter);
    assert.ok(hkcfcdnAfter);
    assert.deepEqual(hkAfter.records, ["47.243.195.5"]);
    assert.deepEqual(hkcfcdnAfter.records, ["47.83.157.126"]);
    assert.equal(hkcfcdnAfter.ttl, 300);
    console.log("  ✓ 修改多值记录的主机名时，旧主机名保留剩余值，新主机名独立创建且 TTL 安全兜底");

    // 修改第二条：在前端选中的第二行初始分配的下标是 #1！
    // 此时原 RecordSet 已只剩 1 个值，但携带 originContent 能够精准定位，并自动并入刚创建的 hkcfcdn
    await client.updateDnsRecord({
      zoneId: "zone-123",
      zoneName: "example.com",
      record_id: `${hkRsId}#1`,
      type: "A",
      name: "hkcfcdn",
      content: "47.243.195.5",
      originContent: "47.243.195.5",
    });
    // 此时原 hk 已无记录被自动删除，hkcfcdn 成功自动合并这两个 IP
    assert.equal(memoryRecordSets.length, 1);
    assert.equal(memoryRecordSets[0].name, "hkcfcdn.example.com.");
    assert.deepEqual(memoryRecordSets[0].records, ["47.83.157.126", "47.243.195.5"]);
    console.log("  ✓ 批量修改整组记录主机名时，防下标漂移并成功触发 409 自动并入");

    // 2.7 真实截图场景复现测试：
    // 已存在 hk.example.com.，线路为华为云官方的 "default_view"，包含 3 个 IP
    // 用户在表单新增同名 hk 记录（line 为 "default"），上游 POST 抛出 409
    // 验证 client 能够精确检索到并成功合并为 4 个 IP，绝不抛出 409 错误
    memoryRecordSets = [
      {
        id: "rs-hk-exist",
        name: "hk.example.com.",
        type: "A",
        ttl: 300,
        records: ["47.57.241.115", "8.217.113.169", "47.83.157.126"],
        line: "default_view", // 华为云真实默认线路值
      },
    ];

    const resHk = await client.createDnsRecord({
      zoneId: "zone-123",
      zoneName: "example.com",
      type: "A",
      name: "hk",
      content: "47.57.187.226",
      line: "default",
    });
    assert.equal(resHk.success, true);
    assert.equal(memoryRecordSets.length, 1);
    assert.deepEqual(memoryRecordSets[0].records, [
      "47.57.241.115",
      "8.217.113.169",
      "47.83.157.126",
      "47.57.187.226",
    ]);
    console.log("  ✓ 真实截图场景：华为云 default_view 线路与表单 default 线路冲突时 100% 自动并入");

    // 2.8 真实截图场景 2：行内修改将其它记录更名为已有主机 hk，同样 100% 自动并入
    // 增加一条单独的 hkcf 记录
    memoryRecordSets.push({
      id: "rs-hkcf-exist",
      name: "hkcf.example.com.",
      type: "A",
      ttl: 300,
      records: ["1.2.3.4"],
      line: "default_view",
    });
    assert.equal(memoryRecordSets.length, 2);

    await client.updateDnsRecord({
      zoneId: "zone-123",
      zoneName: "example.com",
      record_id: "rs-hkcf-exist",
      type: "A",
      name: "hk",
      content: "1.2.3.4",
      originContent: "1.2.3.4",
      line: "default",
    });
    // 原 hkcf 应被清理，hk 应包含 5 个 IP
    assert.equal(memoryRecordSets.length, 1);
    assert.equal(memoryRecordSets[0].name, "hk.example.com.");
    assert.deepEqual(memoryRecordSets[0].records, [
      "47.57.241.115",
      "8.217.113.169",
      "47.83.157.126",
      "47.57.187.226",
      "1.2.3.4",
    ]);
    console.log("  ✓ 真实截图场景 2：行内修改改名为已有主机名，先加后删安全完成并入");

  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("\n全部华为云 RecordSet 自检测试通过！");
}

runTests().catch((e) => {
  console.error("测试失败:", e);
  process.exit(1);
});
