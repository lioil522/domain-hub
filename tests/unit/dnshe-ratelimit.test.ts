/**
 * DNSHE 客户端限速 / 429 / 520 分流测试
 *
 * 全部基于 mock fetch，不访问真实上游 —— 因为需要构造 429/520 这类
 * 真实环境里不可控的状态，且真实上游有 30 次/分钟限流，反复打会污染数据。
 *
 * 断言依据的契约全部来自 2026-10-29 的实测取证：
 *  · 限流 30 次/分钟，429 返回 JSON 带 limit/remaining/reset_at
 *  · **没有 Retry-After 头**，退避必须靠 reset_at
 *  · reset_at 是北京时间（UTC+8）字符串
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DNSHEClient,
  DnsheOriginError,
  DnsheRateLimitError,
  DnsheAuthError,
  isDnsheOriginError,
  parseDnsheResetAt,
  DNSHE_MIN_INTERVAL_MS,
  resetDnsheRateLimiterForTest,
  setDnsheCooldownStore,
  getDnsheCooldownUntil,
  clearDnsheCooldown,
} from "../../src/dnshe";

/** 构造一个 Response 假对象 */
function mockResponse(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

/** 记录每次 fetch 的时间戳，用于验证限速 */
interface FetchLog {
  at: number;
  url: string;
}
let fetchLog: FetchLog[] = [];
let queue: Array<Response | (() => Response)> = [];

function installFetch(): void {
  fetchLog = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchLog.push({ at: Date.now(), url: String(input) });
    const next = queue.shift();
    if (!next) throw new Error("mock fetch queue 已空（实际请求次数多于预期）");
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
}

function enqueue(...items: Array<Response | (() => Response)>): void {
  queue.push(...items);
}

test.beforeEach(async () => {
  queue = [];
  installFetch();
  resetDnsheRateLimiterForTest();
  setDnsheCooldownStore(null);
  await clearDnsheCooldown();
});

// ── reset_at 解析 ──────────────────────────────────────────────

test("parseDnsheResetAt: 北京时间字符串按 +08:00 解析", () => {
  // 实测样本：reset_at = "2026-10-29 18:06:59"（对应 UTC 10:06:59）
  const ts = parseDnsheResetAt("2026-10-29 18:06:59");
  assert.notEqual(ts, null);
  assert.equal(new Date(ts as number).toISOString(), "2026-10-29T10:06:59.000Z");
});

test("parseDnsheResetAt: 非法输入返回 null", () => {
  assert.equal(parseDnsheResetAt(undefined), null);
  assert.equal(parseDnsheResetAt(""), null);
  assert.equal(parseDnsheResetAt("not-a-date"), null);
  assert.equal(parseDnsheResetAt(12345), null);
});

// ── 正常路径 ───────────────────────────────────────────────────

test("正常响应直接返回，不做多余请求", async () => {
  enqueue(mockResponse(200, { success: true, quota: { used: 15, total: 21 } }));
  const client = new DNSHEClient("k", "s");
  const res = await client.getQuota();
  assert.equal(res.success, true);
  assert.equal(res.quota?.used, 15);
  assert.equal(fetchLog.length, 1);
});

// ── 429 限流 ───────────────────────────────────────────────────

test("429 时按 reset_at 退避后重试并成功（不再依赖不存在的 Retry-After）", async () => {
  const resetAt = new Date(Date.now() + 600); // 600ms 后
  const bj = new Date(resetAt.getTime() + 8 * 3600_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

  enqueue(
    mockResponse(429, {
      success: false,
      error_code: "rate_limit_exceeded",
      limit: 30,
      remaining: 0,
      reset_at: bj,
    }),
    mockResponse(200, { success: true, quota: { used: 1 } })
  );

  const client = new DNSHEClient("k", "s");
  const res = await client.getQuota();
  assert.equal(res.success, true);
  assert.equal(fetchLog.length, 2, "应重试 1 次后成功");
});

test("429 连续触发超过重试上限后抛 DnsheRateLimitError", async () => {
  // reset_at 设为很远的未来 → 直接抛错，不会傻等
  const farFuture = new Date(Date.now() + 3600_000 + 8 * 3600_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

  enqueue(mockResponse(429, { success: false, limit: 30, reset_at: farFuture }));

  const client = new DNSHEClient("k", "s");
  await assert.rejects(
    () => client.getQuota(),
    (e: unknown) => {
      assert.ok(e instanceof DnsheRateLimitError, "应为 DnsheRateLimitError");
      assert.equal(e.limit, 30);
      return true;
    }
  );
  // reset_at 远在未来时不应重试，直接失败
  assert.equal(fetchLog.length, 1);
});

test("429 响应体缺少 reset_at 时走默认退避，不崩溃", async () => {
  enqueue(
    mockResponse(429, { success: false, limit: 30 }), // 无 reset_at
    mockResponse(200, { success: true, quota: { used: 1 } })
  );
  const client = new DNSHEClient("k", "s");
  const res = await client.getQuota();
  assert.equal(res.success, true);
  assert.equal(fetchLog.length, 2);
});

// ── 520 上游不可达 ─────────────────────────────────────────────

test("520 抛 DnsheOriginError 且绝不重试", async () => {
  enqueue(mockResponse(520, "error code: 520"));
  const client = new DNSHEClient("k", "s");

  await assert.rejects(
    () => client.getQuota(),
    (e: unknown) => {
      assert.ok(e instanceof DnsheOriginError);
      assert.ok(isDnsheOriginError(e));
      return true;
    }
  );
  assert.equal(fetchLog.length, 1, "520 不能重试 —— 重试只会加重上游负担");
});

test("520 同族状态码（521/522/523/524）同样按上游不可达处理", async () => {
  for (const status of [521, 522, 523, 524]) {
    queue = [];
    installFetch();
    resetDnsheRateLimiterForTest();
    setDnsheCooldownStore(null);
    await clearDnsheCooldown();

    enqueue(mockResponse(status, `error code: ${status}`));
    const client = new DNSHEClient("k", "s");
    await assert.rejects(() => client.getQuota(), (e: unknown) => e instanceof DnsheOriginError);
    assert.equal(fetchLog.length, 1);
  }
});

test("520 之后进入冷却期，冷却内不再发任何上游请求", async () => {
  // 用内存 store 验证（未注入 D1 时的降级路径）
  const apiKey = "k-cooldown";
  enqueue(mockResponse(520, "error code: 520"));
  const client = new DNSHEClient(apiKey, "s");

  await assert.rejects(() => client.getQuota(), (e: unknown) => e instanceof DnsheOriginError);
  assert.equal(fetchLog.length, 1, "第一次真的发了请求");

  const until = await getDnsheCooldownUntil(apiKey);
  assert.ok(until > Date.now(), "应写入冷却");

  // 冷却期内再调用：应立即抛错，且 fetch 次数不变
  await assert.rejects(() => client.getQuota(), (e: unknown) => e instanceof DnsheOriginError);
  assert.equal(fetchLog.length, 1, "冷却期内不应再发请求");
});

test("clearDnsheCooldown 后可恢复正常请求", async () => {
  enqueue(mockResponse(520, "error code: 520"));
  const client = new DNSHEClient("k", "s");
  await assert.rejects(() => client.getQuota());

  await clearDnsheCooldown();
  enqueue(mockResponse(200, { success: true, quota: { used: 3 } }));
  const res = await client.getQuota();
  assert.equal(res.success, true);
  assert.equal(fetchLog.length, 2);
});

test("注入的冷却 store 会被读写（模拟 D1 跨 isolate 共享）", async () => {
  const store = new Map<string, string>();
  setDnsheCooldownStore({
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  });

  enqueue(mockResponse(520, "error code: 520"));
  const client = new DNSHEClient("k", "s");
  await assert.rejects(() => client.getQuota());

  const cooldownKeys = [...store.keys()].filter((k) => k.startsWith("dnshe:origin:cooldown"));
  assert.ok(cooldownKeys.length > 0, "冷却状态应写入注入的 store");
  // 键中不应出现明文 Key
  assert.ok(!cooldownKeys.some((k) => k.includes("k")), "冷却键不应含明文凭证");

  // 新建另一个客户端实例、同一个 Key（模拟另一个 isolate），应同样看到冷却
  enqueue(mockResponse(200, { success: true }));
  const client2 = new DNSHEClient("k", "s");
  await assert.rejects(() => client2.getQuota(), (e: unknown) => e instanceof DnsheOriginError);
  assert.equal(fetchLog.length, 1, "跨实例共享冷却，不应发第二次请求");
});

// ── 401 凭证 ───────────────────────────────────────────────────

test("401 抛 DnsheAuthError 且不重试", async () => {
  enqueue(mockResponse(401, { success: false, message: "Invalid API key", error_code: "auth_invalid_credentials" }));
  const client = new DNSHEClient("bad", "bad");
  await assert.rejects(
    () => client.getQuota(),
    (e: unknown) => {
      assert.ok(e instanceof DnsheAuthError);
      assert.match(e.message, /凭证无效/);
      return true;
    }
  );
  assert.equal(fetchLog.length, 1);
});

// ── 限速 ───────────────────────────────────────────────────────

test("串行调用按全局时间片限速（间隔 >= DNSHE_MIN_INTERVAL_MS）", async () => {
  enqueue(
    mockResponse(200, { success: true }),
    mockResponse(200, { success: true }),
    mockResponse(200, { success: true })
  );
  const client = new DNSHEClient("k", "s");
  await client.getQuota();
  await client.getQuota();
  await client.getQuota();

  assert.equal(fetchLog.length, 3);
  const gap1 = fetchLog[1].at - fetchLog[0].at;
  const gap2 = fetchLog[2].at - fetchLog[1].at;
  // 允许少量调度抖动
  const slack = 120;
  assert.ok(gap1 >= DNSHE_MIN_INTERVAL_MS - slack, `第 1→2 次间隔 ${gap1}ms 应 >= ${DNSHE_MIN_INTERVAL_MS}ms`);
  assert.ok(gap2 >= DNSHE_MIN_INTERVAL_MS - slack, `第 2→3 次间隔 ${gap2}ms 应 >= ${DNSHE_MIN_INTERVAL_MS}ms`);
});

test("并发调用也被时间片串行化（防止上层忘记批处理）", async () => {
  enqueue(
    mockResponse(200, { success: true }),
    mockResponse(200, { success: true }),
    mockResponse(200, { success: true })
  );
  const client = new DNSHEClient("k", "s");
  await Promise.all([client.getQuota(), client.getQuota(), client.getQuota()]);

  assert.equal(fetchLog.length, 3);
  const sorted = fetchLog.map((f) => f.at).sort((a, b) => a - b);
  const gaps = [sorted[1] - sorted[0], sorted[2] - sorted[1]];
  for (const g of gaps) {
    assert.ok(g >= DNSHE_MIN_INTERVAL_MS - 120, `并发请求的实际间隔 ${g}ms 应 >= ${DNSHE_MIN_INTERVAL_MS}ms`);
  }
});

test("限速按 API Key 独立分桶 —— 不同 Key 互不阻塞", async () => {
  // 实测依据：KeyA 打到第 45 次触发 429 的同一秒，用 KeyB 请求仍返回 200；
  // 无效 Key 得到的是 401（鉴权先于限流），说明限流按 Key 而非按 IP。
  enqueue(mockResponse(200, { success: true }), mockResponse(200, { success: true }));

  const a = new DNSHEClient("key-A", "s1");
  const b = new DNSHEClient("key-B", "s2");

  const started = Date.now();
  await Promise.all([a.getQuota(), b.getQuota()]);
  const elapsed = Date.now() - started;

  assert.equal(fetchLog.length, 2);
  const gap = Math.abs(fetchLog[1].at - fetchLog[0].at);
  // 不同 Key 各有独立时间片，总耗时应接近单次 RTT，而不是 2 × 2.2s
  assert.ok(
    elapsed < DNSHE_MIN_INTERVAL_MS,
    `不同 Key 应并行（实际耗时 ${elapsed}ms，若共享队列会 >= ${DNSHE_MIN_INTERVAL_MS}ms）`
  );
  assert.ok(gap < 300, `不同 Key 的请求间隔应很小（实际 ${gap}ms）`);
});

test("同一 Key 的两个客户端实例仍共享该 Key 的配额", async () => {
  enqueue(mockResponse(200, { success: true }), mockResponse(200, { success: true }));

  // 同一 Key 起两个实例（模拟同一账号在两处被用到）
  const a1 = new DNSHEClient("same-key", "s");
  const a2 = new DNSHEClient("same-key", "s");

  await Promise.all([a1.getQuota(), a2.getQuota()]);

  const sorted = fetchLog.map((f) => f.at).sort((x, y) => x - y);
  const gap = sorted[1] - sorted[0];
  assert.ok(
    gap >= DNSHE_MIN_INTERVAL_MS - 120,
    `同一 Key 的并发调用应被串行化（实际间隔 ${gap}ms）`
  );
});

test("冷却按 Key 分桶 —— 一个 Key 的 520 不波及其它 Key", async () => {
  // Key A 遇到 520
  enqueue(mockResponse(520, "error code: 520"));
  const a = new DNSHEClient("key-A", "s");
  await assert.rejects(() => a.getQuota(), (e: unknown) => e instanceof DnsheOriginError);
  assert.equal(fetchLog.length, 1);

  // Key A 在冷却期：不发请求
  await assert.rejects(() => a.getQuota(), (e: unknown) => e instanceof DnsheOriginError);
  assert.equal(fetchLog.length, 1, "Key A 应处于冷却");

  // Key B 不应受 Key A 的冷却影响
  enqueue(mockResponse(200, { success: true, quota: { used: 2 } }));
  const b = new DNSHEClient("key-B", "s");
  const res = await b.getQuota();
  assert.equal(res.success, true, "Key B 不应被 Key A 的冷却连坐");
  assert.equal(fetchLog.length, 2);
});
