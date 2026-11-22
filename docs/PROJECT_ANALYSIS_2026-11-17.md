# Domain Hub：全仓分析与优化方案

> 后续更新（2026-11-22）：本报告保留初始分析基线，不代表问题仍全部未修或路线已全部完成。安全收尾第 1–3 项分别见 [Node 密钥/启动](./NODE_KEY_STARTUP_PROGRESS_2026-11-22.md)、[CORS/可信代理/初始化授权](./REQUEST_BOUNDARIES_PROGRESS_2026-11-22.md)、[自定义域名唯一性/完整归档](./CUSTOM_DOMAIN_UNIQUENESS_PROGRESS_2026-11-22.md)。实际发布以各提交的 CI、Worker、Docker 结果为准；真实账号写入、通知通道和完整灾备等生产验收仍未完成。

## 1. 结论与分析范围

**建议保留现有 Hono + React + D1/SQLite 架构，先修复安全与数据一致性问题，再完善任务执行、API 契约和前端性能。现在不适合继续以拆文件或新增功能为主要目标。**

- 仓库：`https://github.com/lioil522/domain-hub.git`
- 本地目录：`D:\github\domain-hub`
- 分支：`main`
- 分析基线：`e1ce210`，提交时间 `2026-11-04T02:30:20+08:00`
- 分析日期：2026-11-17
- 本次仅新增本报告，没有修改业务源码、依赖声明、锁文件或部署配置，没有提交、推送或部署。

### 覆盖方式

1. 全仓清点：427 个 Git 跟踪文件，TS/TSX/CSS/MJS/SQL/YML 合计约 50,514 行。
2. 静态解析：382 个非声明 TypeScript/TSX 文件，检查导入关系、类型逃逸、空 catch 等。
3. 深入追踪：入口与中间件、认证与加密、数据库与备份、全部服务商接入边界、DNS 操作、同步与续期、Scanner、搜索、Dashboard、前端状态及请求、主题、CI/CD、Node/Docker。
4. 执行现有全量验证，以及本地 workerd 和 Node 自建运行时冒烟测试。
5. 使用内存 SQLite、模拟上游和故障注入复现关键问题，未调用真实服务商写接口。

**边界说明：**这是全仓范围的代码与配置审查，不等于对每一行业务语义进行了形式化验证。未访问生产数据、测试真实服务商凭据、实际构建 Docker 镜像、执行云端部署或测量浏览器 Core Web Vitals。性能数字中的构建体积是实测；后文优化目标是建议验收值。

## 2. 项目结构与成熟度

| 区域 | 文件量/规模 | 职责与评价 |
|---|---:|---|
| `src/` | 143 个 TS，约 13,978 行 | Hono API、服务、DAO、服务商客户端、同步任务；功能完整，旧实现与新分层并存 |
| `frontend/src/` | 225 个 TS/TSX/CSS，约 32,181 行 | React 控制台、业务 hooks、Scanner、设计系统；页面已拆分，状态与装配仍集中 |
| `server/` | 9 个 TS，约 2,621 行 | Node 自建入口、SQLite 兼容层及回归测试；复用业务代码的方向正确 |
| `tests/` | 11 个 TS，约 308 行 | 不变量和架构测试；关键边界覆盖不足 |
| `.github/` | 3 个工作流，521 行 | 独立 CI、Worker 部署、双架构 Docker 构建 |
| `schema.sql`、配置与文档 | 其余 | 建表与运行时自举重复；部署文档较全，但有行为漂移 |

### 实际技术栈

- 后端：TypeScript、Hono、Cloudflare Workers、D1；Node 自建使用 `node:sqlite`。
- 前端：React 18、Vite 5、Tailwind CSS 3、Lucide、QRCode。
- 服务商：DNSHE、Cloudflare、DigitalPlat、DNSPod、阿里云 DNS、华为云 DNS、Vercel，以及无 API 的自定义分组。
- 数据：11 张核心表；`settings` 同时保存应用配置、认证信息和会话，`cache` 同时承载业务缓存、失败计数和同步游标。

### 值得保留的设计

- Worker 与 Node 共用业务实现，避免维护两套后端。
- SQLite 适配层实现不可变 `bind()`、批量事务回滚、语句缓存上限，并已有真实 SQLite 测试。
- Session 使用随机 token，落库前 SHA-256 哈希；API Secret 支持 AES-GCM。
- DNS Provider Adapter 已形成统一接口；DigitalPlat 的 ETag/幂等处理和多值 RecordSet 回归值得保留。
- 页面 lazy loading、哈希静态资源长缓存、外置主题初始化脚本、CSP、非 root 容器均已落实。
- 前端 Feature/ViewModel/Storage 边界和主题回归检查可以作为后续改造基础。

### 不能把“拆分完成”理解为“架构完全收敛”

- `frontend/src/app/useAppControllerView.tsx` 约 1,680 行，同时组合数据、所有 feature hooks、轮询、卡片渲染和大量弹窗。
- `src/huaweicloud.ts` 约 1,271 行，签名、节点探测、域名及 RecordSet 操作共存。
- `src/routes/domains.ts` 约 539 行，仍直接编排数据库、适配器、同步与审计。
- `AccountService`/Repository 部分方法只是转发，DAO 仍负责上游凭据验证和客户端创建。
- 静态运行时 import/re-export 图未发现强连通循环；这不代表没有逻辑耦合或动态调用耦合。
- AST 发现 37 处 `any`、38 个空 catch、11 处连续类型断言。它们是审查线索，不能一律当作漏洞。

## 3. 实际验证结果

| 验证 | 结果 |
|---|---|
| `npm run verify:all` | 全流程通过 |
| 架构检查、Worker 类型检查与打包 | 通过 |
| `test:invariants` | 21 个 Node test 用例通过 |
| Node 类型检查及现有自检 | 通过；其中 D1/SQLite 自检 36 项通过 |
| 普通前端生产构建 | 通过 |
| `npm --prefix frontend run build:selfhost` | 通过 |
| `npm run build:node` | 通过 |
| 主题层叠、对比度检查 | 通过 |
| 本地 workerd / Miniflare 冒烟 | 状态 200、未认证访问 401、初始化 200、认证后账号接口 200 |
| Node 自建进程冒烟 | `/healthz`、首页、静态资源、初始化与认证访问正常；资源缓存为 immutable |

**测试全绿不代表异常路径安全。**现有测试主要检查正常行为、适配和文件边界，下面多项实际缺陷在测试全绿时仍可复现。

### 构建体积

普通构建实测：

- 主业务 `index` JS：432.49 kB，gzip 131.14 kB。
- React vendor：158.61 kB，gzip 51.59 kB。
- 图标 chunk：23.22 kB，gzip 4.52 kB。
- CSS：86.43 kB，gzip 15.85 kB。
- 液态玻璃背景 JPEG：740,414 bytes。

只计算上述入口 JS 与 CSS，gzip 约 203 kB，不含页面额外 chunk 和背景图。页面已经懒加载，但其 hooks、状态和大量弹窗被 Controller 静态引用，首屏仍包含较多非当前页面业务。

## 4. 优先级定义

- **P0：**优先阻断管理员接管、认证保护失效或明显的数据丢失；建议作为下一次发布的阻断项。
- **P1：**影响结果正确性、任务可靠性、恢复能力或生产安全，紧随 P0 处理。
- **P2：**性能、可维护性、工程化和体验优化。

这是本项目的修复优先级，不是 CVSS 分数。下文“已复现”均指本地隔离环境；不表示已在生产被利用。

## 5. P0：先处理的风险

### P0-01：鉴权配置读取失败，被当作“未初始化”

**位置：**`src/db/dao/auth-dao.ts:25-68`、`src/routes/auth.ts:36-50`。

`getAuthConfig()` 捕获数据库读取异常后仍返回空配置，`initialized` 由空 `passHash` 推导为 false。公开的 setup 接口随后允许重新写管理员信息。

**已复现：**在已有管理员的数据库上，仅注入认证配置查询失败、保留写入可用，未认证 setup 返回 HTTP 200，管理员用户名被替换。

**触发条件：**认证配置读失败而后续写入成功。这里不是正常情况下任意用户都能重置，也没有证明攻击者能够自行制造数据库故障。

**方案：**

1. 区分“成功读到未初始化状态”与“读取失败”；失败抛出明确错误并返回 503，禁止 setup。
2. 初始化与更改密码使用原子写入，避免用户名、哈希和盐分别更新。
3. 用唯一初始化记录/CAS 保证只初始化一次。
4. 首次公网部署增加一次性 setup token，或本地/CLI 初始化，避免合法所有者与外部访问者抢占。
5. 成功完成初始化后关闭 bootstrap 通道，不将应急令牌复用为 setup token。

**验收：**故障注入返回 503，旧凭据不变；20 个并发 setup 请求最多一个成功，其余冲突；失败写入不能返回成功。

### P0-02：已开启的 2FA 密钥能被现有会话直接替换

**位置：**`src/routes/auth.ts:204-228`、`src/db/dao/auth-dao.ts:95-108`。

`/api/auth/2fa/setup` 不校验密码或旧动态码，直接写入 `auth_2fa_secret`。已开启 2FA 时，现用密钥也被替换，且新密钥返回调用者。持有有效会话者可以生成新密钥，再使用自己的动态码关闭或控制 2FA。

**已复现：**预先开启 2FA，用已有会话提交空对象，返回 200；数据库仍为 enabled，但 active secret 已变成响应中的新 secret。

**方案：**

- 分离 active secret 和 pending secret；pending 设置 TTL。
- 已开启时拒绝普通 setup，换绑必须验证密码及旧 TOTP。
- 校验 pending TOTP 后原子激活，不提前覆盖旧密钥。
- 对开启、关闭、换绑增加二次认证、限流和审计；必要时撤销其他会话。
- 固定 Base32/TOTP 编码语义，逐步消除历史“Base32 与原始文本双重接受”的歧义。

**验收：**仅持有 session、没有密码或旧 TOTP，不能改变 active secret 或关闭 2FA；setup 中途退出不破坏旧验证器。

### P0-03：Cloudflare 分页续拉把“本次最后一段”当全量，误删此前缓存

**位置：**`src/services/account-sync-service.ts:29-67`、`src/cron/jobs/daily-sync.ts:116-140`、`src/db/dao/domain-dao.ts:154-176`。

手动同步前几页只增不删并保存游标；续拉结束时，局部 `zones` 只有本次切片，却传给按账号做差集删除的 `syncAccountDomains()`。`hasMore=false` 只代表当前分页抵达末尾，不代表局部数组包含整个同步周期。

**已复现：**模拟 4 页、每页 1 个 zone。首轮缓存 3 条；第二轮拉第 4 页后，缓存只剩 1 条，前 3 页中的 3 条被删除。相对首轮数量从 3 降到 1，完整周期应有 4 条。

这删除的是本地缓存，不是 Cloudflare 上游 zone；但会使域名列表、到期检查和跨来源判断漏项。

**方案：**

1. 立即止损：跨调用续拉结束时禁止直接拿本段数据做全量差集删除。
2. 为每个账号同步创建 `generation/run_id`。
3. 每页 upsert 时写入该 generation。
4. 仅整个周期完整结束后清理本账号未被本 generation 看到的行。
5. 游标、页写入和完成状态形成明确提交边界；失败周期不得执行删除。
6. 通过同账号租约避免手动与 Cron 重叠，不同周期不得相互清理。

**验收：**4 页、100 页、空账号、上游中途失败、进程中断、两次同步并发等场景均无误删；真实上游删除只在完整周期结束后反映。

## 6. P1：正确性与生产可靠性

| 编号 | 问题与证据 | 优化方案及验收 |
|---|---|---|
| P1-01 | Cron 更新累计数量，却未持久化新的 `startPage`。`daily-sync.ts:132-135`；已复现请求 1/2/3 页后游标仍是 1，而应为 4 | 与手动同步共用分页状态机；用单调页码/generation，并测试跨多轮能够到达所有页 |
| P1-02 | `setSetting()` 吞写异常；密码写入 3 次非事务；并发 setup 两个请求都返回 200。`settings-dao.ts:26-35`、`auth-dao.ts:74-80` | 认证/配置写入必须抛错；密码、盐、用户名原子写；不允许写入失败仍签发“成功”会话 |
| P1-03 | 无 `AES_KEY` 时 Secret 退化为 `plain:` + Base64；通知设置加密失败还可能保留原文。`crypto.ts:30-33`、`settings-dao.ts:78-87` | 生产强制密钥；停止新增弱编码，存量兼容读取后受控重加密；加密失败必须终止保存 |
| P1-04 | 默认 CORS 反射任意 Origin，与“仅同源”注释不符；允许方法缺 PATCH。`src/index.ts:76-111`；均已复现 | 默认仅同源，跨域只接受显式名单；补 PATCH；不把 CORS 当认证。当前 Bearer 模式下，这一项本身不证明攻击者能获得会话 |
| P1-05 | 自建版直接信任 `cf-connecting-ip`/`x-real-ip`/`x-forwarded-for`，而端口默认对所有地址开放。`auth-helpers.ts:14-21`、`docker-compose.yml:6-7` | Node 使用真实连接地址及可信代理配置；入口覆盖/清除伪造头；反代部署默认本机绑定；验证伪造 IP 不绕过限流 |
| P1-06 | 过期失败计数下一次失败继续累加。`auth-dao.ts:194-206`；已复现过期 5 次从读取 0 变成新失败后的 6 | UPSERT 根据旧 `expires_at` 判断是否重置为 1；原子限制并发尝试；测试窗口结束后的第一次失败 |
| P1-07 | HTTP 后台全量同步依赖 `waitUntil()`，账号间等待、深度同步和回源可超过生命周期。`routes/domains.ts:158-165`、`account-sync-service.ts:114-139,154-214` | 短任务可保留 waitUntil；长任务使用持久化切片执行、队列/Workflow 或 Node 作业执行器，返回 202 + job ID；必须支持中断恢复 |
| P1-08 | 同步异常被 `resyncAccountsInBackground()` 逐账号 catch 吞掉，外层 `queueResync()` 仍 complete；多数手动同步未接入操作中心。`accounts.ts:25-35`、`account-sync-service.ts:201-214` | 返回逐账号结构化结果，支持部分失败；统一 job/action ID；完成状态由执行器判定，不由“函数返回”判定 |
| P1-09 | Scanner 后端有 jobs 表和状态 API，但 resume 只改状态，未调度 worker；前端扫描未调用 create/update/pause/resume job API。`routes/scanner.ts`、`scanner-service.ts:45-46`、`useScannerBatchScan.ts` | 先明确“浏览器扫描”还是“后台扫描”；推荐真正接入持久任务，不能将状态 CRUD 宣称为后台恢复能力 |
| P1-10 | 批量扫描把非成功响应落入“已注册”分支；429 任务已领取但没有重入队；游标记录领取进度而非连续完成进度。`useScannerBatchScan.ts:186-225,239-242`、`scanner-batch-executor.ts:50-65` | 区分 available/registered/unknown/failed；限流重入队和 Retry-After；持久化低水位与未完成集合；恢复不得漏查 |
| P1-11 | 所有业务 401/403 都清 session，原密码错误、缺少 2FA 等可能导致误退出。`frontend/src/api/client.ts:67-74`；业务 403 已复现清空 token | 只在明确的 session 无效错误码退出；为权限、二次认证、上游错误保留会话；认证错误与授权错误分开 |
| P1-12 | `apiJson()` 遇 HTTP 错误抛异常，但登录 hook 仍期待返回 `need_2fa`/`not_initialized` 对象。`request.ts:50-56`、`useAuthSession.ts:155-163` | 统一错误契约；hook 从 `ApiRequestError.payload` 处理预期业务错误，或使用明确的 Result 类型；测试 401 need_2fa 与 409 初始化引导 |
| P1-13 | 自动建表未创建 `schema.sql` 中的显式索引；每个冷 isolate 仍建表并查 PRAGMA，失败结果未阻止后续路由。`database-manager.ts:48-199`、`index.ts:118-145`；自举库显式索引为 0 已复现 | 引入版本迁移，部署期/启动期执行；运行请求仅检查 schema version；失败 503；新旧库表、字段和索引必须一致 |
| P1-14 | `custom_domains` 的 nullable account_id UNIQUE 不阻止重复；代码先查后插有竞态。`schema.sql:88-99`、`custom-dao.ts:66-85`；并发两次 upsert 产生 2 条 | 使用 account_id IS NULL 的部分唯一索引并采用原子 UPSERT；迁移前处理已有重复，不静默丢弃备注或日期 |
| P1-15 | 缓存默认近一年，外部平台修改不会主动失效；缓存删除失败也吞错；DNS 查询缓存损坏直接 JSON.parse 抛错。`cache-dao.ts:28-48`、`dns-service.ts:11-22` | 按命名空间定义 TTL、版本、刷新时间，支持陈旧缓存再验证；脏缓存回源；写操作后强一致失效或明确降级告警 |
| P1-16 | 提醒标记在实际发送前写入，通知失败仍阻止当天重试；前 100 个 RDAP 缓存预算无轮转。`expiry-check.ts:48-55,136-137`、`daily-sync.ts:367-384` | 用 outbox 和每条消息幂等键；成功发送后标记；失败重试/DLQ；预算采用游标并覆盖全部账号，不能永远只检查头部 |
| P1-17 | 通知先完整 `res.text()` 再截 500 字符；截断 JSON 或非 JSON 的 HTTP 200 可被当成功。`notification.ts:69-88,117-140`；Telegram 非 JSON 200 成功已复现 | 有界读取、超时、严格平台响应 schema；Telegram 必须 `ok===true`；自定义 Webhook 可单独定义 2xx 成功策略 |
| P1-18 | 备份不导出 settings、jobs 等；密文复制但无密钥身份说明；超过 500 行不能导入；preview 永远 conflicts=0。`backup-dao.ts:18-24,135-142`、`backup-service.ts:42-53` | 区分业务迁移与灾备；加入 key ID/schema version/checksum；按业务自然键映射 ID 和检测冲突；分段导入用 staging + 提交，禁止无条件放大 batch |
| P1-19 | 导入后前端只刷 DNSHE 域名与 accountInfo，不刷账号列表和其他服务商；文案误称可能覆盖 2FA，实际不导入 settings。`useDataTransfer.ts:169-170` | 统一使相关 query 失效；所有账号/域名页面反映导入结果；修正文案，明确合并覆盖的风险 |
| P1-20 | Dashboard 漏掉 DNSPod/阿里云/华为云/Vercel；时间轴遍历多来源原始数组未去重。`useDashboardStats.ts:16-26,90-102,194-215` | 用全部服务商统一域名投影与到期语义；总数、到期列表、时间轴共用去重记录；同域多来源只能计一次 |
| P1-21 | 服务端搜索默认只读 DNSHE；DNS 内容搜索又预先受域名名称筛选。`search-service.ts:20-49` | 独立跨来源搜索 repository；DNS 内容检索不能依赖域名名称先命中；补来源、状态、账号、内容搜索契约 |
| P1-22 | 几乎全部服务商 HTTP 请求无统一超时/重试预算；DNSHE 深度同步无限 Promise.all；分页安全截断仍返回不完整数组。`account-sync-service.ts:118-134`、`upstream-sync.ts:54-82` | 共用 HttpClient：超时、取消、预算、有限并发、退避；分页返回完整性信息，中断/截断禁止全量删除；写重试需幂等保证 |
| P1-23 | 非 localhost 且未设置后端地址时，客户端拒绝请求；普通 `npm run build` 不默认注入 `/`，README 手动 Worker 构建因此存在同源站点不能登录的路径。`frontend/src/api/client.ts:35-56`、`frontend/package.json:9` | 默认同源相对 `/api`；仅显式分离部署使用覆盖 URL；将无环境变量的生产构建纳入登录 E2E，而不仅做构建成功检查 |

补充：`domains_cache.id` 是全局数值主键，部分服务商使用 remote ID 的稳定哈希，不含面板账号身份。多凭据覆盖同一远端资源时会覆盖 `account_id`（`domain-dao.ts:119-122`）。这是身份建模风险，未通过随机哈希碰撞证明漏洞；建议长期采用本地主键 + `(account_id, remote_id)` 唯一约束，并在迁移时保留旧 API ID 映射。

## 7. 依赖安全审计

2026-11-17 实际 `npm audit`：

| 包范围 | 结果 | 解读 |
|---|---|---|
| 根包全部依赖 | 6 个受影响包：4 high、2 moderate | 包括 Hono/Node adapter 与 Wrangler/Miniflare 开发依赖链；不是 6 个都可在生产触发 |
| 前端全部依赖 | 5 个受影响包：3 high、2 moderate | 主要为构建/开发工具链 |
| 前端 `--omit=dev` | 0 | 不意味着浏览器业务代码没有缺陷 |

锁文件安装结果：`hono@4.12.32`、`@hono/node-server@2.1.1`、`wrangler@4.127.0`、`vite@5.4.21`。

**处理顺序：**

1. 优先更新运行时 Hono 与 Node adapter，结合本次 advisory，至少覆盖 `hono >=4.13.16`、`@hono/node-server >=2.1.6` 的修复范围；实施时重新审计确定版本。
2. 检查 Hono wildcard middleware / path parsing advisory 与当前路由的实际关联，加入编码路径、路由方法和未认证访问测试。不要把所有 JSX、SSG、WebSocket advisory 都认定为此项目可利用。
3. 更新 Wrangler/Miniflare 的受影响依赖链；测试生产配置和本地工具 API 兼容性。
4. 规划 Vite + React plugin 配套升级。审计推荐的 Vite 修复目标为 8.3.8，属于主版本升级，需要迁移验证。
5. 引入 Dependabot/Renovate、锁文件更新 PR 与审计门槛。**不要直接运行 `npm audit fix --force`。**

部分参考：

- Hono wildcard middleware：<https://github.com/advisories/GHSA-h7mg-cq63-vhpq>
- Node server 路径解释：<https://github.com/advisories/GHSA-jpvv-r467-5p4w>
- Vite Windows 路径风险：<https://github.com/advisories/GHSA-fx2h-pf6j-xcff>

## 8. CI/CD、运行时和部署优化

### 发布门禁

现有 `ci.yml` 后端只做 Node 类型检查，没有运行全部不变量/Worker 构建/主题验证。`deploy.yml` 独立在 main push 触发，不等待 CI 结果，也没有部署 concurrency。

**建议链路：**

```text
安装锁定依赖
  → lint + 类型检查 + 全部测试 + 双运行时冒烟
  → Worker / Node / 前端双模式构建
  → 审计与体积预算
  → staging 迁移与部署
  → staging 验收
  → 生产环境审批
  → 迁移、稳定密钥与配置校验
  → 发布同一份已验证产物
  → 探活与关键只读契约验证
```

- 用同工作流 `needs` 或可复用 workflow 建立因果依赖，不靠“两个工作流同时触发”。
- 生产部署设置 concurrency 与环境保护，避免旧构建覆盖新构建。
- 初始化/迁移失败必须中止发布，不能仅打印 warning。
- 不在生产冒烟中自动创建或修改管理员；初始化测试使用临时数据库。
- 固定 Action commit SHA 和镜像 digest，保留 SBOM/来源证明及构建到 commit 的映射。

### 密钥与数据库准备

`deploy.yml:146-170` 先部署可访问 Worker，后同步 AES_KEY。首次部署或同步失败可能出现没有密钥的可写窗口。

- 发布前准备并验证稳定的 AES_KEY，首次发布可使用受控 bootstrap 版本；应用同时 fail-closed，缺密钥拒绝敏感写入。
- 已有密文时禁止自动换 key；通过 key ID、备份及双密钥迁移完成轮换。
- Node 的数据目录已有数据库但密钥丢失时，应报恢复错误，不应生成新密钥假装正常启动。
- 新库和旧库使用同一套版本迁移；自建版启动完成迁移后再接受请求。

### Worker 配置

`wrangler.toml` 兼容日期仍为 `2024-04-01`，Bindings 为手写类型，未开启 observability/source maps，未声明 staging 环境。

- 在 staging 逐步升级 compatibility date，不直接对生产盲改行为。
- 生成 Worker binding 类型，与 Node 的运行时抽象分离。
- 开启结构化日志、采样 traces、上传服务端 source maps；避免 source maps 暴露到静态资源目录。
- 分离 staging/production 的 Worker、数据库与密钥，显式绑定，不能假定环境继承。
- 仅在代码或依赖确实需要 Node API 时验证 `nodejs_compat`；当前 Web Crypto 代码正常冒烟不构成缺少该 flag 的直接故障。

官方当前约束已核查：免费计划外部子请求 50/调用，内部服务另有预算；HTTP 响应后的 waitUntil 最多延长约 30 秒，Cron 有独立时长约束。**限制并发不等于减少总子请求数；也不能把 HTTP 后台任务与 Cron 生命周期混为一谈。**

### Node/Docker

- 保留非 root、多阶段打包、WAL 和健康检查。
- 配置可靠代理信任、请求体限制、HTTP 超时、日志轮转、资源限制；反代场景避免直接公网开放 8787。
- `DatabaseSync` 会阻塞事件循环：先缩小批次并测量 event-loop lag，大规模同步再考虑独立线程/执行器，不急于更换数据库。
- `waitUntil` 替身需要跟踪未完成任务；shutdown 停止领取新任务、保存游标并等待可控 drain，再关闭数据库。
- 区分 liveness 与 readiness；数据库未迁移或 key 错误不能只因 `SELECT 1` 成功就视为服务 ready。
- Node 当前每天一次定时，Worker 每天两次轮转；把调度策略显式化，避免账号较多时自建版覆盖周期翻倍而文档仍暗示相同。
- Compose 镜像目前固定为作者仓库。提供明确的源码构建 override 和 `IMAGE_REPO/IMAGE_TAG` 支持；README 仅改 IMAGE_TAG 的回滚示例在现有 Compose 中不生效。

## 9. P2：前端性能与架构优化

### 9.1 按业务生命周期拆状态，而非继续机械拆文件

建议结构：

```text
AppShell
  ├── AuthSession / ApiTransport
  ├── SummaryQueries（菜单计数、概览）
  ├── FeatureRoutes
  │     ├── DomainsFeature
  │     ├── ProviderFeature
  │     ├── ScannerFeature
  │     └── SettingsFeature
  └── LazyModalHost
```

- hooks 与 feature 页面一起按需挂载；避免未登录、未访问 Scanner 时初始化词库与全部 feature 状态。
- 将 Account、Domain query、Session、Toast 拆成合理上下文，不让 toast 变化广播到全部数据消费者。
- 引入 TanStack Query 或同等级的 query 层，统一去重、失败重试、取消、staleTime 和 mutation invalidation。
- 登录后先加载当前页及轻量摘要，而不是无条件取所有服务商完整列表。
- 登出、后端地址改变、会话失效时清 query 和内存状态；本地缓存按后端身份隔离，避免跨后端残留。
- 解决请求竞态：旧账号筛选请求不能覆盖新筛选结果；组件卸载和新扫描开始时取消旧任务。

### 9.2 降低入口体积

- 大弹窗、Scanner 词库/拼音/地理数据改为真正按需导入。
- Controller 不静态装配全部 feature 实现；只保留轻量导航和跨模块协议。
- 背景图增加 WebP/AVIF/响应式尺寸，低性能设备提供无 blur/简化模式。
- 懒加载失败加 ErrorBoundary 和重新加载提示；Suspense 不负责异常恢复。

**建议预算：**主业务入口 gzip 从约 131 kB 降到不高于 80 kB；背景图目标不高于 250 kB，以视觉验收为前提。不得通过抬高 Vite warning 阈值代替优化。

### 9.3 大数据列表、搜索和扫描

- 域名 API 增加 keyset pagination，先保留旧响应兼容层；索引依据真实查询计划设计。
- 账号同步轮询改读轻量 job status 或服务端 fingerprint，不每 1.5 秒下载完整域名列表。
- 跨来源搜索加 debounce/取消和有界结果；需要子串检索时评估 FTS，而不是假定普通 B-tree 能优化 `%keyword%`。
- 当前规则最多 300,000 个前缀再乘全部 root，任务数组和 skip pool chunks 都物化；改为生成器/流式任务、小批预取和有限并发。
- 连续结果以小批合并 React 状态并持久化分页结果；大量域名/DNS/Scanner 结果使用虚拟列表。
- 避免 `primeScannerSkipPool()` 对所有余下 chunk 一次性 Promise.all。

### 9.4 时间、主题与可访问性

- 数据库存 UTC ISO/epoch，用户时区仅用于展示；目前 UTC 默认时间、北京时间字符串和无时区上游时间并存。
- 将 `unknown expiry` 与 `permanent expiry` 分开；解析托管平台“不提供到期时间”不等于永久注册。
- 续期阈值、概览 90 天、卡片 30 天分别建明确语义配置，不依赖互相矛盾的注释。
- 为玻璃主题建立 CSS layer/组件语义类，逐步减少按 Tailwind 类名模糊覆写；类名顺序本身不能保证 CSS 优先级。
- 保留主题选中标记、focus trap，并补实际 DOM 的键盘、焦点恢复、屏幕阅读器和减少动效测试。
- 现有对比度脚本不等于真实透明背景上的 WCAG 检测；需浏览器验收，不宣称已通过完整可访问性审计。

## 10. 建议的长期服务边界

```text
Route（鉴权、验证、序列化）
  → UseCase（业务与事务编排）
      → Repository（纯 SQL、明确失败语义）
      → ProviderAdapter（统一能力）
          → ProviderHttpClient（签名、限流、超时、错误）
      → JobRunner（持久任务、租约、重试）
      → Outbox（通知与审计可靠交付）
```

- 用 provider capabilities 表驱动账号表单、域名操作和 DNS 选项；前后端共享可序列化契约，不把服务端代码打进浏览器。
- 用统一 DTO/运行时 schema 校验输入与输出，减少重复类型和 `unknown[]` 之后的强转。
- 明确 `AuthError`、`ValidationError`、`ProviderRateLimitError`、`ConflictError`，保留上游 code/request ID。
- 关键认证状态、同步游标与失败计数不应伪装为可随意丢失的缓存。
- `run_id`、`account_id`、`request_id` 贯穿日志与执行状态；审计保存用户/会话指纹和结果，不保存可重放 token。
- 上游操作成功但审计或缓存失败时，不能简单返回“操作失败”诱发用户重试；设计幂等键、结果记录和待协调状态。
- 保留 `DatabaseManager` 作为过渡 facade，通过使用场景逐步缩小；不一次性重写七家 SDK，也不为减少文件行数增加无价值转发层。

## 11. 测试补强方案

优先补“失败会造成损害”的场景，而不是先追求全仓覆盖率数字。

| 测试域 | 必须新增的场景 |
|---|---|
| 认证 | DB 读写失败、并发 setup、初始化 token、2FA active/pending、旧会话撤销、过期失败计数、可信代理 |
| 同步 | 多调用分页、generation 清理、零结果、截断/失败不删除、Cron/手动并发、租约到期 |
| DNS/Provider | 429/503/超时/非 JSON、写幂等、多值记录并发、ETag 冲突、写成功后审计失败 |
| Scanner | unknown 不能算 registered、429 重入队、暂停/恢复低水位、刷新恢复、reset 取消旧请求、重复 job 执行 |
| 备份 | 不同 key 恢复、ID 冲突、超过 500 行、分段失败回滚、导入后全来源刷新 |
| 搜索/Dashboard | 所有来源覆盖、DNS 内容独立检索、同域去重、未知到期、UTC/用户时区边界 |
| 前端 HTTP | 401 need_2fa、409 not_initialized、403 业务拒绝不退出、旧请求不能覆盖新结果 |
| 部署 | schema/索引一致、缺 key fail-closed、双运行时契约、构建产物与发布 commit 一致 |

工程化：

- 补 ESLint/TypeScript 的 promises、hooks 依赖、空 catch 和未使用代码规则。
- 将简单正则架构门禁逐步提升为 import graph/AST 边界检查；现有 controller 阈值 1,700 行、当前约 1,680 行，无法证明职责单一。
- 增加真实 Workers runtime 测试；现有 Node + SQLite 测试保留，用同一契约分别验证两种运行时。
- 增加前端组件测试与 Playwright E2E；安全/同步核心分支建议达到明确分支覆盖门槛，暂不为全仓设虚假覆盖率。

## 12. 实施路线与验收

按一名熟悉 TS/React/Workers 的开发者估算，不包含真实服务商联调等待；阶段有重叠，预计约 4–6 周。建议每阶段独立 PR，不将安全热修、依赖大版本升级与视觉重构混在一起。

| 阶段 | 建议工期 | 内容 | 出口 |
|---|---:|---|---|
| A：安全与止损 | 3–5 工作日 | P0-01/02/03；关键写入失败语义；AES 与运行时依赖修复 | 不再发生认证故障重初始化、2FA 偷换和分页误删；补回归，安全项阻断发布 |
| B：任务与数据 | 5–8 工作日 | 共用分页/generation；job runner/结果传播；迁移与索引；Scanner 错误分类；备份恢复设计 | 中断后可恢复、失败不显示成功、schema 一致、扫描不漏查 |
| C：契约与工程 | 4–6 工作日 | 统一错误/校验；业务 403；全来源搜索与统计；CI 发布依赖；通知 outbox | 核心异常测试通过，CI 未通过不能发布，同域统计一致 |
| D：性能与体验 | 4–6 工作日 | feature 生命周期与 lazy modal、query 层、分页/虚拟化、背景图、工具链升级 | 入口预算、有限并发、浏览器实际性能与可访问性回归 |

### 建议可量化验收

- 不完整分页周期本地误删数量：0。
- 并发 setup 成功数：最多 1。
- 缺 key 或认证配置读取失败：拒绝敏感写入，不降级为“未初始化”。
- job 显示的成功/失败与逐项结果一致；进程重启可恢复未完成切片。
- Scanner 网络失败/限流不得计为 registered；恢复后任务无遗漏。
- 10,000 个域名列表采用分页和有界 DOM，不全量渲染。
- 主业务入口 gzip 目标 ≤80 kB，资源体积增长通过 CI budget 检查。
- 新库/旧库/Worker/Node 使用一致 schema version 与必要索引。
- 备份方案明确恢复点目标、恢复时长目标，并完成一次隔离恢复演练；具体 RPO/RTO 由部署方确认。
- 浏览器 LCP/INP/CLS 根据统一设备与网络条件记录基线再验收，不将本地构建速度当页面性能。

## 13. 本地分析证据与复查

分析辅助文件放在批准的临时目录，不属于业务仓库：

```text
C:\Users\15017\AppData\Local\Temp\opencode\
  domain-hub-verify.log
  domain-hub-audit-root.json
  domain-hub-audit-frontend.json
  domain-hub-static-analysis.mjs
  domain-hub-static-analysis.json
  domain-hub-review-repro.ts
  domain-hub-review-repro.mjs
  domain-hub-repro-results.txt
  domain-hub-worker-smoke.mjs
  domain-hub-node-smoke.mjs
```

故障复现脚本断言的是“当前缺陷确实存在”，不是未来修复后应长期保留的成功断言。实施修复时要反转断言并迁移成仓库内正式回归测试。

复查基础命令：

```powershell
npm run verify:all
npm run build:node
npm --prefix frontend run build:selfhost
npm audit
npm --prefix frontend audit
```

最新 Cloudflare 官方资料已检索，并核对了本地 Wrangler schema 及最新 `@cloudflare/workers-types@5.20261117.1` 的 D1/Handler 类型：

- Workers 最佳实践：<https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- 运行时限制：<https://developers.cloudflare.com/workers/platform/limits/>
- D1 版本迁移：<https://developers.cloudflare.com/d1/reference/migrations/>

**最终建议：先落实 A 阶段，再决定是否继续增加功能。最有价值的优化不是再拆出几个 hooks，而是让认证故障、安全换绑、分片同步、异步任务和恢复流程具备可证明的正确性。**
