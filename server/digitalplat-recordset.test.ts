import assert from "node:assert/strict";
import { DigitalPlatClient, normalizeDpName } from "../src/digitalplat";

async function runTests() {
  console.log("DigitalPlat RRset 自动合并与精准操作自检");

  const originalFetch = globalThis.fetch;
  try {
    let memoryRecords: Array<{
      id: string;
      name: string;
      type: string;
      values?: string[];
      value?: string;
      ttl: number;
      etag: string;
      protected?: boolean;
    }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;

      // GET /domains/:domain/dns/records
      if (path.match(/^\/api\/v1\/domains\/[^/]+\/dns\/records$/)) {
        if (method === "GET") {
          return new Response(JSON.stringify({ success: true, data: memoryRecords }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (method === "POST") {
          // 真实上游保护：若同名同类型已存在，POST 直接报 409 冲突
          const conflict = memoryRecords.find(
            (r) =>
              normalizeDpName(r.name, "example.dpdns.org") === normalizeDpName(body.name, "example.dpdns.org") &&
              r.type.toUpperCase() === body.type.toUpperCase()
          );
          if (conflict) {
            return new Response(JSON.stringify({ success: false, error: "Record already exists (409 Conflict)" }), {
              status: 409,
              headers: { "Content-Type": "application/json" },
            });
          }

          const newRec = {
            id: `dp-rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: body.name,
            type: body.type,
            values: body.values || (body.value ? [body.value] : []),
            ttl: body.ttl || 300,
            etag: `etag-${Date.now()}`,
          };
          memoryRecords.push(newRec);
          return new Response(JSON.stringify({ success: true, data: newRec }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // PATCH/DELETE /domains/:domain/dns/records/:id
      const recordMatch = path.match(/^\/api\/v1\/domains\/[^/]+\/dns\/records\/([^/]+)$/);
      if (recordMatch) {
        const recId = recordMatch[1];
        const target = memoryRecords.find((r) => r.id === recId);
        if (!target) {
          return new Response(JSON.stringify({ success: false, message: "Record not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (method === "PATCH") {
          if (body.values) {
            target.values = body.values;
            delete target.value;
          } else if (body.value !== undefined) {
            target.values = [body.value];
            target.value = body.value;
          }
          if (body.ttl) target.ttl = body.ttl;
          target.etag = `etag-${Date.now()}`;
          return new Response(JSON.stringify({ success: true, data: target }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (method === "DELETE") {
          memoryRecords = memoryRecords.filter((r) => r.id !== recId);
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      return new Response(JSON.stringify({ success: false, message: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const client = new DigitalPlatClient("dp_live_test_key");

    // 1. 测试单条创建与自动并入
    await client.createDnsRecord({
      domain: "example.dpdns.org",
      type: "A",
      name: "hk",
      content: "47.57.187.226",
    });
    assert.equal(memoryRecords.length, 1);
    assert.deepEqual(memoryRecords[0].values, ["47.57.187.226"]);

    // 第二条同名同类型，应自动并入现有 values 数组
    await client.createDnsRecord({
      domain: "example.dpdns.org",
      type: "A",
      name: "hk",
      content: "47.57.241.115",
    });
    assert.equal(memoryRecords.length, 1);
    assert.deepEqual(memoryRecords[0].values, ["47.57.187.226", "47.57.241.115"]);

    // 重复值明确抛出异常，杜绝静默假成功欺骗前端
    await assert.rejects(
      async () => {
        await client.createDnsRecord({
          domain: "example.dpdns.org",
          type: "A",
          name: "hk",
          content: "47.57.187.226",
        });
      },
      /该解析记录已存在/
    );
    assert.deepEqual(memoryRecords[0].values, ["47.57.187.226", "47.57.241.115"]);
    console.log("  ✓ 单条添加遭遇同名同类型时自动合并 values，重复添加时明确报错杜绝假成功");

    // 2. 测试列表展开精准下标
    const listRes = await client.listDnsRecords("example.dpdns.org");
    const recs = listRes.records || [];
    assert.equal(recs.length, 2);
    const recId = memoryRecords[0].id;
    assert.equal(recs[0].id, `${recId}#0`);
    assert.equal(recs[1].id, `${recId}#1`);
    console.log("  ✓ listDnsRecords 正确为多值展开行分配 #idx 唯一下标");

    // 3. 测试批量创建 batchCreateDnsRecords
    memoryRecords = []; // 重置
    const batchRes = await client.batchCreateDnsRecords({
      domain: "example.dpdns.org",
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
    assert.equal(memoryRecords.length, 1);
    assert.equal(memoryRecords[0].values?.length, 5);
    console.log("  ✓ 批量添加多条同名同类型记录自动聚合入同一个 RRset");

    // 4. 测试精准修改：修改下标 #1（47.57.241.115 -> 1.1.1.1）
    const rsId = memoryRecords[0].id;
    await client.updateDnsRecord({
      domain: "example.dpdns.org",
      record_id: `${rsId}#1`,
      content: "1.1.1.1",
    });
    assert.deepEqual(memoryRecords[0].values, [
      "47.57.187.226",
      "1.1.1.1",
      "8.217.113.169",
      "47.243.195.5",
      "47.83.157.126",
    ]);
    console.log("  ✓ 修改多值 RRset 中的某一行时，只替换该行，同组其余值完整保留");

    // 5. 测试精准删除：删除下标 #0（47.57.187.226）
    await client.deleteDnsRecord("example.dpdns.org", `${rsId}#0`);
    assert.equal(memoryRecords.length, 1);
    assert.deepEqual(memoryRecords[0].values, [
      "1.1.1.1",
      "8.217.113.169",
      "47.243.195.5",
      "47.83.157.126",
    ]);
    console.log("  ✓ 删除多值 RRset 中的某一行时，只移除该行，剩余值完整保留");

    // 6. 测试当只剩 1 项时删除
    memoryRecords[0].values = ["1.1.1.1"];
    await client.deleteDnsRecord("example.dpdns.org", `${rsId}#0`);
    assert.equal(memoryRecords.length, 0);
    console.log("  ✓ 当多值 RRset 只剩 1 项时删除，正确触发上游整条 DELETE");

    // 7. 测试修改主机记录（跨主机名迁移与批量合并）
    await client.batchCreateDnsRecords({
      domain: "example.dpdns.org",
      items: [
        { type: "A", name: "hk", content: "47.243.195.5", ttl: 300 },
        { type: "A", name: "hk", content: "47.83.157.126", ttl: 300 },
      ],
    });
    assert.equal(memoryRecords.length, 1);
    const dpHkId = memoryRecords[0].id;
    assert.equal(memoryRecords[0].name, "hk");
    assert.deepEqual(memoryRecords[0].values, ["47.243.195.5", "47.83.157.126"]);

    // 单独修改第一条主机记录：hk -> hkcf
    await client.updateDnsRecord({
      domain: "example.dpdns.org",
      record_id: `${dpHkId}#0`,
      type: "A",
      name: "hkcf",
      content: "47.243.195.5",
      originContent: "47.243.195.5",
    });
    assert.equal(memoryRecords.length, 2);
    const hkRemain = memoryRecords.find((r) => r.name === "hk");
    const hkcfNew = memoryRecords.find((r) => r.name === "hkcf");
    assert.ok(hkRemain);
    assert.ok(hkcfNew);
    assert.deepEqual(hkRemain.values, ["47.83.157.126"]);
    assert.deepEqual(hkcfNew.values, ["47.243.195.5"]);
    console.log("  ✓ 单独修改 DigitalPlat 记录的主机名时，旧主机名保留剩余值，新主机名独立创建");

    // 批量修改第二条：把剩余的 hk 记录也改名为 hkcf
    await client.updateDnsRecord({
      domain: "example.dpdns.org",
      record_id: `${dpHkId}#1`,
      type: "A",
      name: "hkcf",
      content: "47.83.157.126",
      originContent: "47.83.157.126",
    });
    // 此时原 hk 已无记录被自动删除，hkcf 成功自动合并这两个 IP
    assert.equal(memoryRecords.length, 1);
    assert.equal(memoryRecords[0].name, "hkcf");
    assert.deepEqual(memoryRecords[0].values, ["47.243.195.5", "47.83.157.126"]);
    console.log("  ✓ 批量修改 DigitalPlat 整组记录主机名时，防下标漂移并成功自动合并入新主机名");

    // 8. 核心回归测试：把主机记录“us”改为已有主机“cf”（上游返回带主域名的 FQDN 记录）
    // 模拟真实的 DigitalPlat 上游状态：记录名为 cf.example.dpdns.org 和 us.example.dpdns.org
    memoryRecords = [
      {
        id: "dp-rec-cf",
        name: "cf.example.dpdns.org",
        type: "A",
        values: ["1.1.1.1"],
        ttl: 300,
        etag: "etag-cf",
      },
      {
        id: "dp-rec-us",
        name: "us.example.dpdns.org",
        type: "A",
        values: ["2.2.2.2"],
        ttl: 300,
        etag: "etag-us",
      },
    ];

    // 将 us 改名为相对名 "cf"
    await client.updateDnsRecord({
      domain: "example.dpdns.org",
      record_id: "dp-rec-us",
      type: "A",
      name: "cf",
      content: "2.2.2.2",
      originContent: "2.2.2.2",
    });

    // 验证：
    // 1. 原 us 记录集被安全清除
    // 2. cf 记录集成功合并了 2.2.2.2，同时保留 1.1.1.1
    assert.equal(memoryRecords.length, 1);
    const mergedCf = memoryRecords[0];
    assert.equal(mergedCf.id, "dp-rec-cf");
    assert.deepEqual(mergedCf.values, ["1.1.1.1", "2.2.2.2"]);
    console.log("  ✓ 真实场景测试通过：将主机记录 us 改为已有主机 cf 时，消除 FQDN 差异，两个 IP 成功合并且原 us 优雅删除");

    // 9. 事务安全原子性测试（Add-Before-Delete）：当目标主机合并失败时，原记录绝对不被删除
    memoryRecords = [
      {
        id: "dp-rec-full",
        name: "full.example.dpdns.org",
        type: "A",
        // 模拟已满 16 个记录值
        values: Array.from({ length: 16 }, (_, i) => `192.0.2.${i + 1}`),
        ttl: 300,
        etag: "etag-full",
      },
      {
        id: "dp-rec-us-safe",
        name: "us.example.dpdns.org",
        type: "A",
        values: ["8.8.8.8"],
        ttl: 300,
        etag: "etag-us-safe",
      },
    ];

    // 尝试改名为 full，预期因目标达到 16 个上限而报错
    let errorCaught = false;
    try {
      await client.updateDnsRecord({
        domain: "example.dpdns.org",
        record_id: "dp-rec-us-safe",
        type: "A",
        name: "full",
        content: "8.8.8.8",
      });
    } catch (err: any) {
      errorCaught = true;
      assert.match(err.message, /已达上限/);
    }
    assert.ok(errorCaught, "应抛出超出上限异常");

    // 验证原记录“us”完好无损，没有被先删！
    const safeUs = memoryRecords.find((r) => r.id === "dp-rec-us-safe");
    assert.ok(safeUs, "目标添加失败时，原记录集绝不能被删除");
    assert.deepEqual(safeUs.values, ["8.8.8.8"], "原记录的值必须完整保留");
    console.log("  ✓ 事务安全保障：目标添加/合并失败时，原记录毫发无损，彻底避免数据丢失");

  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("\n全部 DigitalPlat RRset 自检测试通过！");
}

runTests().catch((e) => {
  console.error("测试失败:", e);
  process.exit(1);
});
