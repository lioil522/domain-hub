# Domain Hub 完整逻辑链

> 从「代码怎么跑起来」到「一次点击背后发生了什么」的全链路说明。
> 面向接手维护者，按 **启动 → 请求 → 数据 → 定时 → 前端** 五层展开。

---

## 0. 一句话架构

**一份共享业务代码（`src/`），两个运行时外壳（Workers / Node），四类上游数据源。**

```
                    ┌─────────────────────────────────────────┐
                    │          共享业务层 src/                 │
                    │  index.ts  Hono 路由（47 个 API）        │
                    │  db.ts     数据库 + 加密 + 鉴权 + 缓存    │
                    │  cron.ts   定时同步 / 续期 / 通知         │
                    │  dnshe.ts / cloudflare.ts / digitalplat.ts│
                    │  dns-provider.ts 托管商识别               │
                    │  punycode.ts     IDN 编解码              │
                    └───────────────┬─────────────────────────┘
                                    │ 同一个 app.fetch()
                ┌───────────────────┴───────────────────┐
                │                                       │
        ┌───────▼────────┐                    ┌─────────▼─────────┐
        │ Cloudflare      │                    │ Node.js 自建       │
        │ Worker          │                    │ server/index.ts    │
        │ src/index.ts    │                    │ server/d1-sqlite.ts│
        │   fetch()       │                    │   fetchHandler()   │
        │   scheduled()   │                    │   setTimeout cron  │
        │ D1 + Cron       │                    │ node:sqlite + 定时器│
        │ [assets] 发前端  │                    │ server/static.ts   │
        └─────────────────┘                    └───────────────────┘
```

**关键设计**：`src/` 里**没有任何 Workers 专属 API**（不用 KV、不用 R2、不用 Durable Objects），只依赖标准 `fetch` / `crypto` / `D1Database` 接口形状。所以 Node 侧只要造一个"D1 长得像的东西" + 一个 `waitUntil` 替身，同一份业务代码就能原样跑。

---

## 1. 启动链（两个运行时各不相同）

### 1.1 Cloudflare Workers

```
wrangler deploy
  ├─ 读 wrangler.toml
  ├─ [assets] directory = ./frontend/dist
  │    → Cloudflare 先把静态资源按路径匹配直接发出
  │    → 命中则【不进 Worker，不计请求数】
  ├─ run_worker_first = ["/api/*"]
  │    → 只有 /api/* 才执行脚本进 Hono
  ├─ [[d1_databases]] 绑定 DB
  └─ [triggers] crons = ["0 2 * * *"]   ← UTC！= 北京时间 10:00
```

请求进来后由 `src/index.ts` 的默认导出分流：

| 入口 | 触发时机 | 做什么 |
|---|---|---|
| `fetch(request, env, ctx)` | 每次 HTTP 请求 | `app.fetch()` → 包一层 `withSecurityHeaders()` |
| `scheduled(event, env, ctx)` | cron 到点 | `ctx.waitUntil(runDailySyncAndRenewal(..., isScheduled=true))` |

### 1.2 Node 自建版

`server/index.ts` 按顺序做 6 件事：

```
1. resolveAesKey()      env AES_KEY → 否则读 /data/aes.key → 否则生成并写盘(0600)
2. new DatabaseSync()   node:sqlite，开 WAL + synchronous=NORMAL + busy_timeout + foreign_keys=ON
3. createD1FromSqlite() 【核心适配】把 node:sqlite 包装成 D1Database 接口形状
4. 建表                 schema.sql（含索引）+ ensureTables()（补 settings 表与字段迁移），双幂等
5. executionCtx 替身    waitUntil → 直接 run Promise + catch（Node 不会因请求结束回收任务）
6. scheduleCron()       msUntilNextUtc(CRON_UTC_HOUR, CRON_UTC_MINUTE) → setTimeout → 跑完再排下一次
```

**适配层的意义**：`server/d1-sqlite.ts` 实现了 `prepare().bind().all()/first()/run()` + `batch()`，并提供 `bind()` 返回新语句的**不可变语义**。有了它，`src/db.ts` 里 1700 行 SQL 一行都不用改。

**启动分流**（`fetchHandler`）：

```
/healthz          → 真读一次 DB（SELECT 1），区分「进程活着」和「库可读」，503 表示库挂了
/api 或 /api/*    → worker.fetch(request, env, executionCtx)  ← 共享业务
其余              → handleStatic()  （SPA 兜底 + ETag + 缓存头）
```

---

## 2. 请求处理链（中间件顺序是理解一切的钥匙）

Hono 中间件**按注册顺序**执行，顺序错了就是安全漏洞。实际顺序：

```
第 1 层  app.use("/api/*")  ①  ← src/index.ts:516
         ├─ new DatabaseManager(c.env.DB, c.env.AES_KEY)   每请求一个实例
         ├─ ensureSchemaOnce(dbManager)                  模块级 Promise 缓存，每 isolate 仅一次
         └─ c.set("db", dbManager)                       注入 context

第 2 层  CORS                                                  ← 同源无需配置
         非 OPTIONS → 直接 next()；OPTIONS → 预检后 204
         ⚠️ 预检与真实响应必须同一套判定，否则「预检过、真实请求被拦」

第 3 层  app.use("/api/*")  ② 鉴权                              ← src/index.ts:701
         ├─ 白名单放行：/api/auth/login、/setup、/status
         ├─ 必须带 Authorization: Bearer <token>
         ├─ 路径 A：token 以 dh_sess_ 开头 → validateSession()
         ├─ 路径 B：ADMIN_TOKEN 静态值 或 其 TOTP 动态码（应急后门）
         └─ 都失败 → 若是「非会话形状」的凭据，按 IP 记失败并限流 429
```

**两个易错点**：

1. `ensureSchemaOnce` 的模块级缓存是**性能关键**——早期每请求都跑 `ensureTables()`（5 条 CREATE + 1 条 PRAGMA，两次串行 D1 往返）给每个请求固定加约 0.5s。现在收敛为每 isolate 一次，且**失败不缓存**（留给下个请求重试，不把偶发失败固化成永久跳过）。
2. 鉴权里 `dh_sess_` 前缀是**限流维度的分界线**：正常会话不受 IP 限流影响，只有乱填凭据/爆破 `ADMIN_TOKEN` 才计数。这是防止应急通道变成无限爆破旁路。

### 2.1 鉴权与加密链（`db.ts`）

```
【初始化一次】POST /api/auth/setup
  用户名 → 存 settings.auth_username
  密码   → PBKDF2(salt, 迭代) → 存哈希，永不明文
  可选 2FA → generateBase32Secret(20字节) → AES-GCM 加密后存 settings.auth_2fa_secret
             同时返回 otpauth:// URI 供前端出二维码

【登录】POST /api/auth/login
  ① 查 PBKDF2 哈希校验密码（timingSafeEqual 防时序攻击）
  ② 若开启 2FA → verifyTOTP(code, secret)：base32 解码 → HMAC-SHA1 → 30s 步长 → 6 位码
  ③ 通过 → createSession() → token = "dh_sess_" + randomUUID() → 存 settings 表 + TTL
  ④ 失败 → recordLoginFailure(ip:xxx)，超阈值 → 锁定 429

【凭据使用】getClientForAccount(id)   ← 全项目凭据出口
  SELECT alias, api_key, api_secret, provider FROM accounts WHERE id = ?
         ↓ decryptText(api_secret, aesKey)   AES-GCM 解密
         ↓ 按 provider 分发
    cloudflare   → new CloudflareClient(apiSecret)     （Token 存在 api_secret 字段）
    digitalplat  → new DigitalPlatClient(apiSecret)    （API Key 存在 api_secret 字段）
    custom       → new DNSHEClient("", "")             ⚠️ 占位对象，禁止发任何上游请求
    dnshe(默认)  → new DNSHEClient(apiKey, apiSecret)
```

> ⚠️ `getClientForAccount` 的 `custom` 分支返回的是**占位 client**，调用方**必须先按 `provider === "custom"` 分流**。历史上这里出过 bug：`/api/whois` 的默认账号筛选漏排 `custom`，拿到空凭据占位 client 去查上游，被 401 拒绝。

**加密降级语义**：`AES_KEY` 未配置时 `encryptText` 退化为弱 Base64 编码存储（不报错、不阻断），所以 README 才反复强调"密钥必须和数据库一起备份"——密钥丢了，库里所有 API Secret 和 2FA 密钥都解不开。

---

## 3. 数据层（8 张表 + 一个关键抽象）

### 3.1 表职责

| 表 | 用途 | 要点 |
|---|---|---|
| `accounts` | API 账号 + 自定义分组 | `provider` 四值：`dnshe`/`cloudflare`/`digitalplat`/`custom`；`api_secret` 加密存储 |
| `domains_cache` | **域名主缓存（全项目数据核心）** | 三源共用：DNSHE 小整数 id、CF zone 哈希 id、DP 域名 id |
| `logs` | 运行日志 | `type`(info/success/warning/error) × `category`(sync/renew/auth/api/system/operation) |
| `settings` | 面板配置 + 鉴权数据 + 会话 | 一表多用：配置项、`auth_*` 凭据、`sess_*` 会话行 |
| `cache` | 上游响应缓存 | 见下方"缓存命名空间" |
| `domain_date_overrides` | RDAP 查不到时的手动日期 | 注册/到期时间 + 来源标记 |
| `custom_accounts` | 自定义分组的账号层 | 仅名称，无凭据 |
| `custom_domains` | 自定义分组的手动域名 | 三层结构的叶子 |

### 3.2 `domains_cache` 的 id 空间设计（重要）

三源共表，但 **id 空间互不相交**：

- **DNSHE**：直接用上游 `subdomain_id`（小整数）
- **Cloudflare**：`zoneIdToNumericId(zoneId)` = 双 FNV-1a 拼出 53 位稳定哈希
  - 32 位 hex 的 zone id 放不进 INTEGER，所以哈希
  - 同一 zone 每次同步得到**相同** id → upsert 幂等
  - 值域 `h1 * 2^21 + (h2 % 2^21)`，恰好落在 JS 安全整数内
- **DigitalPlat**：域名自身 id

仍显式给 DELETE 加 `AND account_id = ?` 做**双保险**——万一未来 id 空间重叠，也不会误删别的账号的行。

### 3.3 缓存命名空间（`cache` 表）

| key 前缀 | 写入者 | TTL | 用途 |
|---|---|---|---|
| `QUOTA_CACHE_KEY` | `refreshAccountQuotaCache` | 默认长 | 各账号配额，避免读操作打上游 |
| `api_cache:dns:<subdomainId>` | `deepSyncAccountDomains` | 默认 | 深度同步回填的解析记录，开 DNS 面板命中即零上游调用 |
| `dp_ns_sync:<域名>` | DP 同步 | **不传 TTL ≈ 366 天（近乎永久）** | DP 域名的 NS 快照，让「修改 NS」弹窗冷启动秒回 |
| `rdap:<版本>:<域名>` | `/api/expiry` | 7 天 | RDAP 到期时间 + 注册商，**只缓存成功结论** |
| `cf_zone_cursor:<accountId>` | cron CF 分支 | 3 天 | CF zone 列表的续拉游标（见 §4） |
| `ip:<ip>` | 登录失败计数 | 锁定窗口 | 登录限流 |
| 查重池 | `/api/whois/pool` | 7 天 | 只缓存"已注册"结论 |

**统一清理**：cron 每次收尾跑 `purgeExpiredCache()`，避免 `cache` 表只进不出。

### 3.4 三态与 `dns_state_known`（数据正确性的关键契约）

上游 `subdomains/list` 返回的 `status` 只有 `active` 这类**注册态**，而前端要显示的是**解析态**三态：

```
已委派   NS 指向非 dnshe.com 的托管商（detectDnsProvider ≠ system）
已解析   NS 是 system（dnshe.com）但区域内已有解析记录
未解析   NS 是 system 且区域内零记录
```

三态**只能由真实解析记录推导**，所以：

- 能拿到解析记录的调用方 → `computeDnsState(records)` → 返回 `dns_state_known: true`
- 拿不到（限流/失败）→ **不带** `dns_state_known`

`buildDomainUpsert` 据此分支：

```
有 dns_state_known → ON CONFLICT 时更新 status / has_dns / dns_provider
无 dns_state_known → ON CONFLICT 时【完全不碰这三列】，保留库里已有结论
                    且 INSERT 时 status 落成中性的「未解析」
                    （宁可少报也不误报——把它显示成假的「已解析 + 系统默认」更糟）
```

这就是 `deepSyncAccountDomains` 注释里强调「不能走 `syncAccountDomains` 全量覆盖」的原因：`subdomains/list` 不返回解析记录，全量覆盖会把同账号下所有「已委派」刷成「已解析 + 系统默认」。

---

## 4. 定时任务链（`cron.ts` 一次触发的全部动作）

```
cron 到点 → runDailySyncAndRenewal(dbManager, webhookUrl, webhookType, isScheduled=true)
  │
  ├─ 0. ensureTables() + 写启动日志
  ├─ 0.5 读配置（DB 优先于环境变量）
  │      renew_threshold_days（默认 90） / auto_renew / webhook_url / webhook_type / tg_token / tg_chat_id
  │
  ├─ 1. 【主任务】for (const acc of accounts)  按 provider 四路分发
  │      ├─ cloudflare   ← 1.5.1 zone 到期提醒（只读缓存，跨账号统一一次）+ 分片续拉，见 §4.1
  │      ├─ digitalplat  ← 定时【跳过上游】，NS 已在 cache；只读库做到期提醒
  │      ├─ custom       ← 无上游，只读库做到期提醒（跨账号统一处理一次）
  │      └─ dnshe        ← fetchAllSubdomainsFromClient → batchedPromiseAll(5) 拉 dns_records
  │                          → computeDnsState → syncAccountDomains 落库
  │
  ├─ 2. 【自动续期】对 DNSHE 域名：剩余 ≤ 阈值 且未过期 → renewSubdomain()
  │      renewal_not_yet_available → 记 info（不推红色警报）
  │
  ├─ 3. 【收尾清理】
  │      pruneExpiredLogs()      清 30 天前日志
  │      purgeExpiredCache()     清过期 cache（含 7 天查重池）
  │      purgeExpiredSessions()  清过期会话 ← 鉴权每请求都查 settings 表，不清会拖慢全站
  │
  └─ 4. 【通知推送】有续期记录 → 续期报告；有提醒记录 → 到期提醒
         都走 sendWebhookNotification / sendTelegramNotification
```

### 4.1 Cloudflare 分片续拉（子请求配额自适应的核心）

**约束**：免费计划每次 Worker 调用硬限 **50 次子请求**，`[limits]` 对免费计划**不生效**。

**策略**：不预估账号规模，先"探一页"。

```
读游标 cf_zone_cursor:<accountId>  →  {startPage, syncedBefore}
for (round = 0; round < CF_ZONE_ROUNDS_PER_RUN(=3); round++) {
    res = client.listZones({ startPage, maxPages: CF_ZONE_PROBE_PAGES(=1) })

    if (!res.hasMore) {
        // 本页没拉满 → 上游列表已完整 → 权威结论
        syncAccountDomains(全部)      ← 只有这里做差集删除（清理上游已删的 zone）
        游标归零 setCache(key, "", ttl=1)
        break
    }
    // 本页满员但被页数预算截断
    upsertAccountDomains(本页)        ← 【只增不删】，否则会误删没轮到的分片
    游标写入 {startPage: nextPage, syncedBefore += 本页数}
}
```

**为什么页数预算故意保守（3 页）**：剩余配额要留给排在后面的 DNSHE / DP 账号。宁可同一个 CF 账号分两天拉完，也不要一次吃光配额把后面的账号全饿死——那正是报错的成因。

**`hasMore` 的语义边界**：它是"上游还有没拉完的页"的**统计事实**，调用方必须以它作为"上游结论是否完整"的**唯一依据**。只有 `hasMore === false` 才能走差集删除。

### 4.2 子请求预算的现实账

| 账号类型 | 单账号子请求 |
|---|---|
| DigitalPlat（定时） | **0**（跳过上游） |
| Cloudflare ≤50 zone | **1** |
| Cloudflare 超大账号 | 每页 1 次，单次最多 3 页 |
| Cloudflare 到期提醒（只读缓存） | **0**（见 §4.1.1） |
| DNSHE | `1`（拉列表）+ **未命中数**（见下方两条快路径） |
| custom | 0 |

**`batchedPromiseAll` 只压并发（每批 5），不减少总量。** 所以真正的瓶颈一直是 DNSHE 的逐域名 `dns_records`，以及"所有账号挤在同一次调用共享 50 次配额"。

### 4.1.1 Cloudflare zone 到期提醒（数据源与预算）

**根本约束**：**CF zone 对象里没有到期字段**（有效期登记在注册商处），上游结构性不提供。这与另外两类有本质差别——DP 的 `domains_cache.expires_at` 由 `listDomains` 带回、custom 的 `custom_domains.expires_at` 是用户录入，两者读库**零子请求**；CF 必须另找数据源。

**两级数据源**（手动覆盖优先）：

| 优先级 | 来源 | 覆盖范围 | 代价 |
|---|---|---|---|
| 1 | `domain_date_overrides` 表 | 用户手动录入的 zone（**子域 zone 只能靠它**） | 0（D1 内） |
| 2 | `cache` 表的 `rdap:4:<domain>` | 仅**注册域**；子域在 RDAP 必然 404 | 0（只读缓存） |

```
1.5.1 段（cfReminderDone 保证跨账号只跑一次）：
    getDomains(provider=cloudflare)                  → 全部 CF zone 行
    getDateOverridesByAccountIds(账号全集)            → 一次 D1 往返，不逐域名查
    isRegistrableDomain() 过滤出注册域，截断到 CF_EXPIRY_BUDGET(=100)
    getRdapExpiryCacheBatch(预算内域名)               → 一次 D1 往返
    for 每个 zone:  expires = 手动 ?? RDAP缓存 ?? 缺失→跳过
                    remainingDays <= renewThresholdDays → writeLog + expiryReminderLogs
```

**⚠️ 关键设计：cron 只读缓存、不主动回源。** CF 域名按 zone 计（线上 10 个 CF 账号 / 55 zone），逐个回源会把免费计划 50 次配额直接打满，而 DNSHE 的解析记录拉取还要共用同一份配额。代价是**「用户没打开过 Cloudflare 页的注册域本轮不提醒」**，换来 cron 额外上游请求恒为 0。回源查询由前端 `/api/expiry` 在用户打开 CF 页时完成并落缓存。

**两种"无结果"都必须如实返回缺失，绝不能当成"不过期"**：`found=false`（子域 zone 的 RDAP 404）、带 `error` 的失败结论（本就不落缓存）。误判成"不过期"会让查不到的 zone 被静默认定为安全。

**预算 `CF_EXPIRY_BUDGET = 100` 为什么存在**：**查缓存本身也走 D1，也算子请求**。不给上限的话，zone 数一多，光查缓存就能吃光配额——那就把"省配额"的优化变成了新的配额黑洞。超出预算的域名本轮不提醒，下轮继续（滚动覆盖而非硬失败）。

**`RDAP_CACHE_PREFIX` 必须两边共用**（`db.ts` 导出，`index.ts` 复用）：cron 与 `/api/expiry` 读写同一批键，版本号漂移会让一边重复回源、另一边永不提醒。

#### 4.1.2 四类域名的到期行为差异

同一个 `renew_threshold_days`（默认 90）阈值，四类域名的处置**完全不同**：

| 类型 | 数据源 | 剩余 ≤ 阈值时的行为 | 是否推送 |
|---|---|---|---|
| **DNSHE** | 上游 `expires_at` | **自动续期**（调 `renewSubdomain`） | 成功/失败都推续期报告 |
| **DigitalPlat** | 库 `domains_cache.expires_at` | 只提醒，**不续期** | 推送【域名到期提醒】 |
| **自定义分组** | 库 `custom_domains.expires_at`（用户录入） | 只提醒，**不续期** | 推送【域名到期提醒】 |
| **Cloudflare** | 手动覆盖 > RDAP 缓存 | 只提醒，**不续期** | 推送【域名到期提醒】 |

- DP / custom / CF 三者共用 `expiryReminderLogs` 同一推送通道（`【域名到期提醒】`），DNSHE 走独立的续期报告（`【DNSHE 域名自动续期报告】`）
- **前提**：必须配 Webhook 或 Telegram，否则只写日志不推送
- **无去重标记** → 窗口内（`remainingDays <= 阈值` 的每一天）**每天重复推一次**
- RDAP 查询链只对**注册域**生效（`isRegistrableDomain()` 过滤），子域 zone 查不到 → 只能靠手动录入

### 4.2.1 已实施的两条快路径（省 DNSHE 的 dns_records）

DNSHE 每同步一个域名要花 1 次子请求拉 `dns_records` 才能推出三态。两条快路径让它不必花：

**腿一 · 已委派到本面板 CF 账号的域名**

`collectManagedCfZones()` 一次查库拿到「本面板所有 CF zone 名 → {真实账号名, zoneId}」，然后按 `DNSHE.full_domain ⟷ CF zone.name` 比对（实测确认 CF zone 的 name 就是完整域名，子域名 zone 亦然）。

- 命中 → 三态恒定 `已委派 / Cloudflare`，**不拉记录**；`provider_account_id` 与 `remote_id` 直接取自同一张表，**判据本身零子请求**
- 查库而非遍历账号 → 判据不受账号遍历顺序影响，不会因某个 CF 账号排在 DNSHE 账号之后而漏判
- `resolveCfZoneOwner()` 兜底：仅当那个 CF 账号尚未同步过、库里没有它的 zone 行时才回源反查

**腿二 · 解析记录缓存复用（`dns_records_cache_mode`，默认开启）**

- **定时任务**：先用 `getDnsRecordsCacheBatch()` 单条 SQL 批量读 `api_cache:dns:<id>`。命中 → 用缓存里的记录重算 `computeDnsState()`（零子请求，且与回源结果**完全等价**，因为缓存的就是当初那份记录）；未命中 → 回源拉取并顺手回填缓存
- **手动同步**（面板按钮 / 绑定后后台同步）→ `isScheduled=false`，**永远全额回源**，保证用户主动点的时候拿到最新真相
- 设置页可关掉（存 `always`），退回旧的全额回源行为

> 缓存键与「打开 DNS 面板」读的是同一个 `api_cache:dns:<id>`，所以面板看过的域名也自动进了缓存池。

**fail-safe 语义**：两条腿漏判都只退化为「多拉一次记录」（结果仍正确），绝不会误判成跳过而写错三态。

### 4.2.2 实测账单（本地库：1 CF 账号 / 24 zone / 15 DNSHE 域名）

| 场景 | DNSHE dns_records 子请求 |
|---|---|
| 优化前 | 15 |
| 首轮（腿一生效，记录缓存为空） | 9 |
| **后续定时任务（腿一 + 腿二全生效）** | **0** |
| 手动同步（仅腿一，强制回源） | 9 |

线上为 10 个 CF 账号 / 55 zone，腿一覆盖面优于本地，总开销从约 51 次降到 50 次以内。

### 4.2.3 账号分批轮转（已实施，解决饿死）

**问题**：账号是**顺序遍历**，谁先耗尽配额谁触发 `break`，后面的账号整批跳过；下次 cron 又从**头**遍历 —— 若开头总是大户，后面账号会**长期饿死**（不是慢，是永远轮不到）。

**解法**：把「一次调用跑完全部账号」改成「一次调用只跑 N 个 + 环状游标推进」。

```
SYNC_ACCOUNT_BATCH_SIZE = 5      // 每轮处理的账号数
ACCOUNT_CURSOR_KEY = "sync:cursor:accounts"   // cache 表，值 { lastId, rounds }
```

游标是**环**不是队列：处理到末尾自动回绕到开头，永不终止。下一轮从 `lastId` 的**后继**开始。

**为什么按 id 环状切而不是「跳过已完成的」**：同步是幂等操作，重复处理一个账号只是多花点配额；漏掉一个账号会让它的数据无限期陈旧。**宁可重复，不可遗漏**。

**⚠️ 配额耗尽时游标必须停在断点，不能推进** —— 否则中途 `break` 会让游标越过那些没跑到的账号，它们要等整整一圈才再次被轮到，那就把「分批」退化成了另一种形式的漏同步。实现上由 `lastProcessedId` + `quotaExhausted` 两个变量协作完成。

**⚠️ 三个 `xxxReminderDone` 去重标志被移除**。原来三类到期提醒（CF / DP / custom）各自挂在「遇到第一个该类型账号」的分支里，靠这三个标志去重。分批后某批次可能完全不含某类型账号 → 提醒被整轮静默跳过，表现为「提醒时有时无」。现在统一抽成 `collectExpiryReminders()`，在账号遍历**之前**执行一次：这三类提醒只读本地库、不产生上游子请求，与批次解耦后行为更稳定。

**手动同步（`isScheduled=false`）不分批** —— 用户显式点「同步」时应立刻看到全部账号的最新数据。

**覆盖能力**：`ceil(账号数 / 5)` 轮覆盖一遍。10 个账号配 2 个触发器 = 一天一轮半，2 天内必定全覆盖。

**两个已实施的方向**：
1. ✅ 账号遍历加「环状轮转游标」→ 无账号饿死
2. ✅ 拆两个 cron 触发器（`0 2 * * *` + `30 2 * * *`）→ 一天两批

⚠️ **Cron Trigger 额度是账号级共享的**：免费计划**整账号**最多 **5 个**（付费 250），**不是每个 Worker 5 个**。当前用掉 2 个。要覆盖更多账号应优先调大 `SYNC_ACCOUNT_BATCH_SIZE`，而不是加触发器。

### 4.2.4 手动同步的 CF zone 分片（已实施）

`index.ts` 的 `syncCloudflareZones` 原先是一路 `for (let page = 1; page <= 50; )` 拉完 —— 最多 50 页 = 50 次子请求，**正好等于免费计划硬限**。一个 2500 zone 的大账号光列表就吃光整份配额，且失败后**没有游标**，下次点击从第 1 页重来，永远拉不完。

现在改为「单次预算 `CF_ZONE_ROUNDS_PER_RUN` 页」，未拉完就写游标返回，提示「剩余部分请再次点击同步继续」：

- 小账号（≤50 zone，绝大多数）：一页拉完，`hasMore=false` 走权威全量 + 差集清理，**行为与以前完全一致**
- 大账号：分多次点按逐步推进，每次都能落地一部分

**⚠️ 游标 key 与 cron 共用同一个（`cfZoneCursorKey`）** —— 两处操作同一账号时必须看到同一份进度。各用各的会导致「手动拉到第 2 页，定时任务又从第 1 页重拉」，互相覆盖白费配额。

---

## 5. 上游客户端链（三家的差异）

### 5.1 DNSHE（`dnshe.ts`）— 唯一支持写操作与续期

```
baseUrl = https://api005.dnshe.com/index.php?m=domain_hub&endpoint=X&action=Y
认证     api_key + api_secret（双头）
```

| 方法 | 用途 |
|---|---|
| `getQuota` / `listApiKeys` | 配额与密钥管理 |
| `listSubdomains(page, perPage, search, status)` | 域名列表（**perPage 上限 500**） |
| `getSubdomain` / `renewSubdomain` / `deleteSubdomain` | 单域名操作 |
| `listDnsRecords` / `createDnsRecord` / `updateDnsRecord` / `deleteDnsRecord` | 解析记录 CRUD |

> `fetchAllSubdomainsFromClient` 循环分页到拉完：数据不足一页 → 停；达到 total → 停；**安全上限 50 页**（25000 条）防死循环。

### 5.2 Cloudflare（`cloudflare.ts`）

```
baseUrl = https://api.cloudflare.com/client/v4
认证     Bearer <API Token>（只支持 Token，不兼容旧式 Global API Key）
```

- **错误翻译**：CF 对"Token 无效"和"Token 缺权限"都回 `code 10000/9109` + `Authentication error`。这里翻译成可操作的中文指引（去控制台加 `Zone:Read` + `Zone DNS:Edit`，确认 zone 范围），而不是甩裸英文。
- **`listDnsRecords` 附带 Worker 识别**：CF 在「Workers 自定义域」绑定 Worker 后会塞一条 `AAAA 100::` proxied 占位记录。真实身份有两条来源，`attachWorkerNames()` 依次尝试：
  1. `GET /accounts/:account_id/workers/domains`（新版 Custom Domains，`hostname` + `service`）
  2. `GET /zones/:id/workers/routes`（旧版 Routes，`pattern` + `script_name`）
  - 只筛 `AAAA + proxied + content === "100::"` 的候选行；两路都失败则**静默降级**（前端仍显示 AAAA 100::），不阻塞解析记录返回
- **结构化记录类型**：SRV / LOC / DNSKEY / DS / SVCB / HTTPS / TLSA / SSHFP / CAA / NAPTR 等要求走 `data` 对象提交。`buildStructuredData()` 把用户按 RFC 惯例空格分隔填的内容拆成字段；**拆不出就保留 `content` 原样提交**，让 CF 返回明确错误（不猜、不吞）。
- **`listZones(opts)` 的签名**就是这个分片续拉改造的产物，返回 `ZonePage { zones, nextPage, hasMore }`。

### 5.3 DigitalPlat（`digitalplat.ts`）

- API Key 认证（`apiKey` 参数不使用，凭据放 `apiSecret`）
- 上游**没有 whoami / keys 接口**，绑定校验用 `GET /domains`（能列出域名即密钥有效）
- 返回的 `nameservers` 用于推导托管商（`digitalplat.org` → DigitalPlat 托管），并随同步持久化到 `dp_ns_sync:<域名>`
- **续期需走注册局支付流程（报价 + 订单），无法静默自动续期** → 只做到期提醒

### 5.4 托管商识别（`dns-provider.ts`）

```
NS 空 或 全是 dnshe.com        → system（系统默认）
vps8.zz.cd                    → vps8（自有 NS，优先于通用规则）
digitalplat.org               → DigitalPlat
ns.cloudflare.com             → Cloudflare
dnspod.net/.com/dnsv.com      → DNSPod
vercel-dns.com                → Vercel
其余                          → external
```

### 5.5 到期时间的四级来源（`/api/expiry`）

```
① 域名自身（DNSHE / DP 同步时上游自带 expires_at）
② 手动覆盖 domain_date_overrides（针对具体域名）
③ RDAP 查询（按注册域，7 天缓存）
④ 前端显示「—」由用户手动补
```

**RDAP 链**：

```
/api/expiry?domains=a.com,b.com
  ├─ toASCII 归一 → isRegistrableDomain 过滤【子域直接跳过】
  │    （注册局只登记注册域，子域查不到也白查）
  ├─ 并发读 D1 缓存 rdap:<版本>:<域名>   ← 并发而非串行，热缓存几十个域名省好几秒
  └─ 未命中并发回源 lookupDomainExpiry():
       RDAP 失败 → 若是 Stackryze 后缀 → fetchExpiryViaStackryze() 兜底
       只缓存【成功结论】（含正常 404）；带 error 的不落缓存，下次重试
```

> **踩坑史**：`rdap.org` 聚合入口对并发有 rate limit（429 随机出现），导致"10 个域名只查到 1 个"。修过两轮（429 退避重试 + 3 路限流并发；直连注册局端点绕过聚合层），但 Worker 环境与本地行为不一致的根因**未最终确认**，相关改动已被回退。

---

## 6. 前端链（`App.tsx` 13765 行单文件）

### 6.1 状态与路由

```
TabKey = "dashboard" | "domains" | "cloudflare" | "digitalplat"
       | "custom" | "accounts" | "register" | "quota" | "logs" | "settings"

路由方式  hash（#/register 可直入）+ useState<TabKey>
侧栏      navItems 数组，badge 显示各源数量
DNSHE 项  带子菜单（域名列表 / 注册·查重），悬停或点击展开
```

### 6.2 后端地址解析（三层优先级）

```
localStorage["DOMAIN_HUB_BACKEND_URL"]   ← 用户在设置页保存的覆盖值
    ↓ 无
import.meta.env.VITE_API_BASE_URL        ← 构建期烘焙
    ↓ 无
""  （同源，走相对路径 /api）
```

> **注意**：这个值一旦登录成功就被**冻结进 localStorage**。早期出现过"改构建期变量不生效"的困惑——根因是旧值已冻结，需在设置页清除。

### 6.3 前后端数据契约

```
后端 successRes()  把 payload 扁平化后附 success: true
前端取值           data.success / data.accounts / data.message ...

错误               errorRes(msg, error_code) → { success: false, message, error_code }
```

**契约意义**：`successRes` 的扁平化让前端不用区分"顶层字段"和"嵌套字段"，但反过来说**新增接口必须走这两个封装**，否则前端取值失配。

### 6.3.1 三个同步入口的语义边界

手动同步有三条路径，**粒度不同，别混用**：

| 接口 | 粒度 | 前端入口 | 日志措辞 |
|---|---|---|---|
| `POST /api/domains/sync` | **全量**（所有账号 + 续期 + 通知） | **概览页**「同步所有账号」 | 定时任务那套措辞 |
| `POST /api/providers/:provider/sync` | **单服务商**（该 provider 全部账号） | DNSHE 页 / CF 页 / DP 页的「同步域名」 | `手动同步：…` |
| `POST /api/accounts/:id/sync` | **单账号** | 账号行的同步图标 | `手动同步：…` |

**三个服务商页的按钮文案统一是「同步域名」**，且都走 provider 级接口 —— 页面属于哪个服务商，就只同步哪个。DNSHE 页原先掛的是全量入口（文案「同步所有账号」），在 DNSHE 页点一下会连带把 CF / DP 也回源一遍；现已改为 `/api/providers/dnshe/sync`，全量入口独占概览页。

**`/api/providers/:provider/sync` 是后补的**。在此之前 CF 页与 DP 页的同步按钮都调 `/api/domains/sync`（全量），与按钮所在页面的语义不符 —— 用户在 CF 页点同步却连带同步了 DNSHE / DP，且在免费计划下更容易撞 50 次子请求上限。`provider` 走白名单校验（`dnshe` / `cloudflare` / `digitalplat`），`custom` 明确返回「无需同步」而非静默成功。

**⚠️ 后台同步必须写 `writeLog`**：`resyncAccountsInBackground` 原先只有 `console.log`，而 console 在 Workers 里进的是实时日志（wrangler tail / 仪表盘），**不落 D1 的 `logs` 表** —— 结果是面板日志页看不到任何手动同步痕迹，用户以为没跑。cron 那条路径每步都有 `writeLog`，所以只有定时任务有日志。这个差异是缺陷，已修。

### 6.3.2 概览「到期统计」的唯一可信数据源是 `cfExpiryMap`

概览的「已过期」计数与「到期预警」列表**不能直接读 `d.expires_at`**：

- **Cloudflare zone 没有任何到期字段** —— 有效期登记在注册商处，CF API 不返回；早先代码把 CF 一律当「永久未过期」（`record(z.full_domain, false)`）。
- **DNSHE 对部分域名返回空串** —— 上游本身就没有这个值。
- 真正查到的到期时间只存在于 **`cfExpiryMap`**（RDAP 自动查询结果 + 用户手动录入的 `domain_date_overrides`），按注册域缓存 7 天。

因此前端抽出 `resolveExpiry()` 复用 `cfZoneDateInfo` 的优先级链：**手动覆盖 > DNSHE 上游 > DigitalPlat 上游 > RDAP 自动查询**；统计与预警共用同一张去重表。

**另一个隐形坑**：`dashboardStats` 的 `useMemo` 依赖数组原先**漏了 `cfExpiryMap`** —— 即便取值链修对了，RDAP 异步查完也不会触发重算，界面仍显示 0。改统计口径时务必同步检查依赖数组。

### 6.4 跨源搜索与跳转

```
crossSourceSearch (useMemo)  同时搜 4 源：domains / cfZones / dpDomains / customDomains
domainMatchesKeyword()       大小写不敏感 + punycode 兼容（中文与 xn-- 两种形态都能命中）
SearchResultGroups           按源分组，每源最多 8 条，来源色：DNSHE 紫 / CF 橙 / DP 绿 / 自定义 琥珀

跳转定位
  DNSHE  → gotoDnsheDomain()  切页 → 展开所属账号 → setDnsheHighlightDomainId → scrollIntoView + 4s 清除
  CF     → gotoCfZone()
  DP     → gotoDpDomain()
  自定义 → 仅切页（三级结构定位未实现）
```

### 6.5 国际化域名显示（`displayDomainSmart`）

Punycode 解码不能盲目做，`xn--` 前缀有三种情况：

| 输入 | 解码结果 | 显示策略 |
|---|---|---|
| `xn--fiq64b` | 中信（可见中文） | 正常解码 |
| `xn--zug` | U+200B 零宽字符 | 用 `◌` 占位显示 |
| `xn--aa` | U+0080 控制字符 | **保留 xn-- 原文**（否则显示成不可见空白） |
| `xn--c` | 非法 Punycode | 保留原文 |

逐标签判定：`isPrintableVisible()` 排除 C0/C1 控制字符、DEL、空白。

### 6.6 概览页去重统计

```
normalizeDomainKey(full_domain) 做 Map 去重
  ← 同一域名可能同时在 DNSHE + CF + DP + 自定义四个来源，直接相加会重复计数
到期状态取 OR（任一来源过期即算过期）；CF 恒永久算未过期；0000 前缀 = 永久
```

---

## 7. 安全链（汇总）

| 层 | 措施 |
|---|---|
| 传输 | 全站 HTTPS（Workers）/ 建议反代加 TLS（自建） |
| 密码 | PBKDF2 加盐哈希；`timingSafeEqual` 防时序攻击 |
| 2FA | TOTP（HMAC-SHA1 / 30s / 6 位），密钥 AES-GCM 加密存储 |
| 会话 | `dh_sess_` + randomUUID，存 `settings` 表带 TTL，cron 定期清理 |
| 凭据 | AES-GCM 加密 API Secret；`AES_KEY` 缺失时降级为 Base64（不阻断，但需备份密钥） |
| SQL | 全部参数化绑定；DELETE 显式带 `account_id` 防跨账号误删 |
| 限流 | 登录失败按 `ip:<ip>` 计数，超阈值 429；会话 token 不受此维度影响 |
| 响应头 | `withSecurityHeaders`：X-Content-Type-Options / Permissions-Policy 等 |
| CORS | 默认仅同源；`ALLOWED_ORIGIN` 逗号分隔白名单；预检与真实响应同一判定 |
| 应急后门 | `ADMIN_TOKEN`（静态值或其 TOTP），未配置则完全禁用该通道 |

---

## 8. 部署链

### 8.1 GitHub Actions → Workers（`deploy.yml`）

```
push main / 手动触发
  → Checkout → Node 22 + 双 lockfile cache
  → Install（root ci + frontend ci）
  → D1 自动查询/创建 + sed 替换 wrangler.toml 占位符 database_id
  → 检测是否绑定自定义域名（绑了就关 workers.dev 与预览 URL）
  → Build（npm run build = frontend install + vite build）
  → wrangler-action deploy（后端脚本 + 前端静态资源同一次上传）
  → AES_KEY 自动生成/同步 → 可选 Secrets 同步
```

**必配 Secrets**：`CLOUDFLARE_API_TOKEN`（需 Workers + D1 权限）、`CLOUDFLARE_ACCOUNT_ID`
**可选**：`CLOUDFLARE_D1_DATABASE_ID` / `AES_KEY` / `ADMIN_TOKEN` / `WEBHOOK_URL` / `ALLOWED_ORIGIN`

**建表自举**：部署后**无需手动建表**——`ensureTables()` 全 `IF NOT EXISTS` 幂等，每个 isolate 首次 `/api/*` 请求自动触发。

### 8.2 Docker 自建（`docker.yml`）

三阶段构建：前端（vite build）→ 后端（esbuild 打包为**单文件约 244KB**）→ 运行时（`node` 用户 uid 1000，非 root，**不含 node_modules**）。

### 8.3 三个部署形态的对应关系

| | Cloudflare Workers | Docker 自建 |
|---|---|---|
| 数据库 | D1 (SQLite) | `node:sqlite` |
| 定时任务 | Cron Trigger | 进程内 `setTimeout` |
| 前端发布 | 同一 Worker 的 `[assets]` | `server/static.ts` 同端口 |
| 请求数计费 | 静态资源不计，只算 `/api/*` | 无此概念 |
| 迁移 | ↔ 表结构完全一致，导出 D1 放入 `/data` 即可，**`AES_KEY` 必须一致** | |

---

## 8.4 业务数据导入 / 导出（面板内自助备份）

面向"换部署环境"和"定期备份"两类场景，在**设置页**提供自助导出/导入，不依赖 wrangler 或容器卷。

### 接口

| 方法 | 路径 | 2FA | 说明 |
|---|---|---|---|
| `POST` | `/api/data/export` | **强制** | 未开 2FA 直接 403，不降级 |
| `POST` | `/api/data/import` | 已开才验 | 兼容未开 2FA 的旧环境 |

**2FA 走请求体字段，不走 query**——query 会进访问日志、Referer 和浏览器历史。

### 导出范围（`DATA_EXPORT_VERSION = 1`）

只导 **5 张业务表**：`accounts`、`domains_cache`、`custom_accounts`、`custom_domains`、`domain_date_overrides`。

**刻意排除**：

| 表 | 原因 |
|---|---|
| `settings` | 混装 2FA 密钥、密码哈希、`sess_*` 会话——导出去等于把整套凭据复制一份 |
| `logs` | 纯运行痕迹，无迁移价值，且体量大 |
| `cache` | 可重建（RDAP / DNS 记录缓存），且带 TTL，导过去反而制造过期数据 |

**因此备份文件不等于完整灾备**——恢复环境仍需 `AES_KEY`，否则 `accounts.api_key`（AES-GCM 密文）解不开。这一点与 §8.1 的密钥纪律是同一件事。

### 导入语义：合并 upsert

按外键顺序 `accounts → custom_accounts → custom_domains / domains_cache / domain_date_overrides` 逐表 upsert，冲突键为 `id`：

- **只增改，绝不 DELETE** —— 导入不会清空目标环境已有数据
- **幂等** —— 同一份文件重复导入不会产生重复行
- **全批原子** —— 走 `db.batch()`，任一语句失败整批回滚，不留半截数据
- **版本校验** —— `version` 不匹配直接抛错，**不静默降级**（避免把 v1 结构塞进 v2 表）
- **单次上限 500 行** —— 超了报错要求分批，防止单请求打爆 D1 的执行预算
- **列名硬编码白名单**，值统一 `bind` —— 备份文件内容不可信，不拼 SQL

### 2FA 校验复用限流

`dataOpScope(c)` = `dataop:<客户端IP>`，与登录失败计数共用同一套 `countLoginFailures` / `recordLoginFailure` / `clearLoginFailures`：

- 同一 IP 连续 5 次错码 → 锁 15 分钟（`LOGIN_MAX_FAILURES` / `LOGIN_LOCK_WINDOW_SECONDS`）
- **防止把导出接口当成 TOTP 爆破入口**——这是强制 2FA 必须配限流的原因，否则 6 位码可以无限试

---

## 9. 关键约定与已知陷阱（维护必读）

### 约定

1. **`src/` 只用标准 API**——一旦引入 Workers 专属 API，Node 侧立刻跑不起来。
2. **写入 `domains_cache` 必须经 `dns_state_known` 契约**——拿不到解析记录就不带它，避免三态被误刷。
3. **`hasMore` 是"结论完整性"的唯一依据**——只有它为 false 才允许差集删除。
4. **分片写入用 `upsertAccountDomains`（只增不删）**，全量写入才用 `syncAccountDomains`。
5. **`custom` provider 的 client 是占位对象**，调用方必须先分流。
6. **新增接口必须走 `successRes` / `errorRes`**，否则前端取值失配。
7. **cron 表达式是 UTC**，`"0 2 * * *"` = 北京时间 10:00。
8. **备份文件不含 `settings`**——跨环境恢复必须自备 `AES_KEY`，否则业务数据里的密文全部解不开。

### 已知陷阱

| 陷阱 | 后果 | 规避 |
|---|---|---|
| `wrangler.toml [limits]` 对免费计划不生效 | 以为调了上限其实没生效 | 靠应用侧分片，别指望配置 |
| DNSHE `perPage` 上限 500 | 超了静默截断 | `fetchAllSubdomainsFromClient` 已按 500 分页 |
| RDAP 只登记注册域 | 子域白查 | `isRegistrableDomain` 先过滤 |
| `batchedPromiseAll` 只压并发不降总量 | 误以为能省配额 | 真正的解法是缓存或分次调用 |
| 前端后端地址冻进 localStorage | 改构建期变量不生效 | 设置页清除覆盖值 |
| `AES_KEY` 丢失 | API Secret / 2FA 密钥全部解不开 | **必须和数据库一起备份** |
| 备份文件当完整灾备用 | 换环境后密文全解不开 | 备份**不含** `settings`，`AES_KEY` 必须另外保管 |
| 误以为「每 Worker 5 个 Cron」 | 拆一堆 Worker 却挂不上定时 | Cron Trigger 是**账号级**共享 5 个（付费 250） |
| 分批轮转时配额耗尽仍推进游标 | 断点后的账号要等一整圈才轮到 | 已处理：`quotaExhausted` 时游标停在断点 |

### 待办 / 改进方向

1. **[高]** DNSHE `dns_records` 按域名缓存（TTL 6h）→ 把子请求 N 降到接近 0
2. **[中]** 修正 `wrangler.toml` 与 README 里 cron 时区的说明（当前注释说"凌晨 2 点"，实际是北京时间 10:00）
3. **[中]** `schema.sql` 只有 7 张表，缺 `settings` 表（代码自举建表是权威，影响小但易误导）
4. **[低]** 自定义服务的三级结构定位未实现（跨源搜索跳转只切页）
5. **[低]** 拆分 `App.tsx`（13765 行单文件）
