# 代码优化实施进度与兼容说明

> 2026-11-04：已验证 schema 自举优化与日志表格修正纳入 GitHub 发布准备，不直接部署生产。fork 手动 main 部署无需 SHA 输入或 production 环境，默认使用自己的 workers.dev；下文保留历史阶段结果，当前部署见 [README](../README.md)。

日期：2026-11-03。审阅基线：`56f5b11c026673e6eb30545813511a782f3a2ff7`。

## 最新：授权依赖升级与双版本完整复验（2026-11-03）

- 用户授权确认安全兼容版本后升级：Hono4.13.16/Node adapter2.1.6、Wrangler4.156.2与配套Miniflare5 beta/types/workerd、Vite6.4.5/PostCSS8.5.32/selector6.1.5；保留React18/Tailwind3及Node engines，不使用unsafe overrides/强制audit fix。清单、锁文件和工作流pin已回填，业务源码不改。
- Node24.15.0与22.23.4分别13道完整门禁全绿、20组661项零失败/取消/跳过、另13浏览器/108主题/12隔离HTTP冒烟；双树审计均0漏洞。Node22首次types逗号传递失败及Windows冒烟脚本初始失败保留，修正编排后重验，不放宽测试。可选Sharp WASM三项树诊断保留并核对，不称根树无诊断。
- 独立`dependency-upgrade-verify-20261102-TY29X5`使用自身依赖，Node24/Node22分别快照，原661/618冻结与文档收口收据不覆盖。491非Markdown文件中仅授权5份清单/配置变化；新源码/文档/日志/产物收据见[升级验收](dependency-upgrade-acceptance.md)。
- 用户确认DNSHE30/min、同账号多Key共享、到期前180天免费，按[契约记录](provider-contract-evidence.md)接受。**跨Key账号归并仍未实现**，缺可靠主体/映射，不按别名猜；不设置续期窗口/执行写入。DP/Huawei等调查和实际云端staging/容量/部署主动暂缓，不自动继续。
- 23:58:53原PID22636/health/首页与5静态资源200/原哈希匹配；工作区node_modules/原运行产物和数据库/AES不更新。未打开原库/AES、重启/切换、真实同步/续期/删除/清历史、提交/推送/部署；不声称用户期间全表不变。

## 前批：后续计划整批离线交付（2026-11-02 23:20）

- 全局≤25跨页顺序账号流池（最多一页待派发）、密集DNS/坏ID边界、三个深历史增量索引、500行/8MiB跨密钥迁移/本地ID映射/原子审计和预览确认UI、辅助批次止损/not_sent、非分片取消409已完成。详情和口径见[整批验收](follow-up-all-acceptance.md)。
- 最终完整**20组、661项零失败**，另13项浏览器合成通过；Worker/Node类型构建、前端类型构建、规模helper类型和主题108项均通过。初次完整门禁4项旧Node迁移自检失败保留，修正有效密文/时间字段及不覆盖契约后全绿，新增CF真实apex/未知日期往返；没有删测试或伪造日期。
- 最终合成2000任务历史预览7855.22→15.43ms，索引10000任务75.72ms；资格结果/query plan不变，不宣称云端scanned/billed rows或Free CPU达标。13浏览器中的可见性/请求为合成，真实OS后台节流/崩溃和旧真实任务续跑仍未验收。
- 发布只接受手动main精确SHA、production审批及verify/security，显式已有D1 UUID、原AES元信息在部署前检查；移除自动域名探测改访问策略/创建D1/轮换AES与可选Secret。真实staging/备份/解密/容量/上线另验。根/frontend审计仍6包（4high/2moderate）与5包（3high/2moderate），security失败关闭，不安装升级依赖或绕过门禁。
- DNSHE公开180天窗口确认但GET列表续期例和V2POST/PUT及赎回收费矛盾未解；多Key身份/30与60、DP生产分页和Huawei限频仍缺契约。见[契约证据](provider-contract-evidence.md)、[依赖政策](dependency-remediation.md)、[发布回退](release-and-migration.md)。辅助反向补偿不安全，停止/只读核验而非自动撤销。
- 独立`follow-up-all-verify-20261102`，504门禁时文件/491非Markdown冻结源码，661项收据`acceptance-receipt.json`及`final-full-*`，浏览器`sync-lifecycle-browser-SOYBrI/receipt.json`。新未启用Node bundle `E5F7F3A2885E1E40BDDC5927ACAE7C428B8BBD6FD1B2B60E4B7A60BFAE7257D1`；文档仅工作区收尾，不改冻结验收副本。
- **23:20:45原PID22636、healthz/首页和5静态资源均200/哈希匹配**，原bundle仍`1D62A02257721888EAF512A64DB3D62F1129028B28C5814B84B96520FB9FA36B`。未读写原数据库/AES、切换/重启服务、真实请求、清历史/恢复Scanner、安装升级、提交/推送/部署；原用户活动和密码保持现状，不能声称期间全表未变。

以下是各批历史记录；当前状态以本文件最上方“授权依赖升级”节为准。A–F/F06本轮对账见第4节，不把历史“待实现”误当当前未做。

## 前批：P2 保守历史维护与跨轮回归（2026-11-02 22:40）

- 用户要求继续，完成安全有界维护入口，详见 [历史维护说明](sync-history-maintenance.md)。新增 `POST /api/sync/history/maintenance`，走现有管理员鉴权，JSON最多1024字节；默认只预览，执行必须 `dryRun:false` 和明确确认。保留30–3650天，每表每片1–100行，不接Cron/登录/同步完成或前端自动调用。本轮未清任何真实历史。
- 旧DAO三项新回归先红：按rowid判断最新会误删创建时间最新的导入任务、最后成功任务、遗留owner/损坏cursor终态。修复为创建时间/rowid排序，按账号/mode保留最新任务、最近实际成功和最大的继承新鲜度记录；所有活动/blocked断点、owner/lease及损坏cursor不删除。片段/索引先有界删除，空任务才删，不触发大批级联；执行资格在每条事务SQL中重检，不信任旧预览。
- 每片删除与一条操作审计处于同一batch；SQL/审计失败整片回滚，未知提交不重发。默认预览无删除/维护日志。合成205片段+205索引分三片100/100/0、100/100/0、5/5/1；121个空历史任务分100+20删除，最新任务和业务表/cache/Actions/原成功日志保留。本地workerd生产HTTP含鉴权每片3次D1、external=0，参数/大小/确认与审计回滚通过。
- 新增10项Node维护回归、2项workerd和2项前端跨轮回归，完整门禁 **20组、618项零失败**（604+14）；独立Chromium/React **7项通过**。Worker/Node/前端类型与构建、主题108项、规模helper类型门禁通过。559/1115片响应fixture分别跨2/3轮，每轮≤500、始终同taskId，仅最终回调完成一次；不算真实上游等待/全链路大账号验收，未修改前端推进逻辑。
- 独立副本 `C:\Users\15017\AppData\Local\Temp\opencode\follow-up-p2-maintenance-verify-20261102`：498文件基线、499文件冻结源码、`acceptance-receipt.json`、红/绿/完整门禁日志。浏览器收据 `sync-lifecycle-browser-oFsZiw/receipt.json`；上一P2冻结497文件与收据仍经哈希核验不变。新维护说明与进度文档仅在工作区随后更新，不覆盖冻结证据。
- 新验证Node bundle `55C3617BDD067326FDAA8645D674A4858E305A7C7F1AED79A905EB533538E3F7` **未启用**；22:40:00 PID22636/健康与原静态资源均正常（200），仍是原冻结构建，证据 `service-unchanged.json`。没有读取原数据库、重启、真实请求、开启Cron/Scanner、安装或升级依赖、提交、推送或部署。原密码恢复后数据保持当前状态，不用旧备份覆盖。
- 本轮只约束样本/删除行数和调用，不宣称扫描行、云端CPU/计费有界。跨计划页仍须等待本页流全部收尾，公平调度、密集DNS、远端rows/CPU/额度及真实恢复验收继续待办；D1/external40、DNSHE30/60s、25账号页、500片/轮、两分钟窗口不放宽。

## 前批优化：P2 合成规模与查询路径（2026-11-02 22:20）

- 用户要求“继续项目优化”，按后续计划推进P2第一轮离线规模、调用、耗时和存储评估；详见 [规模评估](sync-scale-assessment.md)。新增可选 `npm run bench:sync`，使用合成内存SQLite、每片严格40/40预算和禁止真实出站的fixture，明确区分应用D1调用、batch内SQL、返回/变更行和云端计费。未访问原数据库/AES或真实账号。
- 确认并修复两处查询热点，生产变更仅 `src/services/sliced-sync-service.ts`：三处域名join先整数主键定位，再保留精确文本匹配；每有界账号只查询一次最新任务，保留创建时间/rowid tie规则。不改schema、generation/cursor/fencing或完整seen/碰撞验证，不提高预算、不清协调状态。
- 旧源码两处query-plan回归先红后绿；新增5项Node和1项workerd HTTP回归覆盖整数查询、分页/历史tie/过滤、正负/0/最大安全ID、非规范文本不别名，以及列表读后新增跨账号碰撞仍在事务中阻断/回滚。已有缺片、损坏、并发写、旧owner/unknown结果保护均继续通过。
- 合成1000域场景累计本地耗时 **10328→475ms**，发布单片最高 **200.56→1.97ms**；500域发布最高80.51→2.85ms。75账号×100历史任务的25账号计划页约12.88–13.23→0.82–1.49ms。前后页/片/D1/SQL/逻辑增长和SQLite总变更数断言一致；这不是云端CPU或真实API延迟证据。
- 真实本地workerd/D1经合成有效会话、生产路由、原CF客户端/admission验证26账号计划和两个105域分页快照：22个HTTP同步片、236次D1、6个合成GET，单片D1最高13/external≤1，reservation归零。未向服务商发真实请求。
- 发现但未自动处理：完成任务/片段/seen/candidate随generation累积，`purgeSyncHistory()`生产只有定义无调用；500/1000域需559/1115片，超过前端每轮500片，大账号要沿原任务跨轮，跨页公平性/密集DNS/云端rows与CPU仍待评估。保留两分钟手动窗口和DNSHE30/60s策略，基准不模拟真实等待，不宣称生产容量通过。
- 完整门禁 **20组、604项零失败**（598+6）；Chromium/React **7项独立通过**。Worker/Node类型和构建、前端类型/构建、主题108项及规模helper类型通过。新独立副本 `C:\Users\15017\AppData\Local\Temp\opencode\follow-up-p2-verify-20261102`，497文件冻结、`acceptance-receipt.json`、红/绿日志、`benchmark-comparison.json`和完整门禁收据保留；基准前/后目录 `sync-scale-2koe8z` / `sync-scale-PYFywv`，浏览器 `sync-lifecycle-browser-X0V1Fe/receipt.json`，均在opencode Temp。测试初稿问题也保留，不混作生产缺陷。
- 新验证Node bundle `C8CCBAB5C36302180AFAE385F6B4C7E914CADA6A992F2D92AF41CCCBEE304B94` **未切换**；22:20:37健康/原静态入口均200，当前PID22636仍运行原冻结构建，证据 `service-unchanged.json`。未重启、操作真实账号、开启Cron/Scanner、安装或升级依赖、提交、推送或部署。文档仅在工作区收尾更新，不覆盖冻结副本或原密码恢复后的数据。

## 最新运行状态：用户授权密码恢复（2026-11-02 22:02）

- 用户忘记密码并明确要求重置。仅重置原管理员密码，用户名保持原值；盐与 PBKDF2-HMAC-SHA256 哈希按现有格式原子更新，撤销 **3** 个旧会话、清除 **3** 个登录失败计数，记录一条本地恢复日志。初始化标志、2FA配置、原账号/域名/任务、AES及服务商限频/Scanner状态不变；不重新开放 setup、不关闭2FA、不换Key或恢复旧库。
- 操作前确认无活动任务/Scanner/租约，定点停止原 PID **25812** 后成对备份最新数据库/AES，再执行原子恢复并用 WebCrypto 独立核验新密码哈希；明文临时密码不写入文档、脚本或收据。使用原冻结启动脚本恢复服务，当前 PID **22636**，**22:02:16** 健康和 `/api/auth/status` 均200，已初始化、2FA仍关闭。代理、`127.0.0.1:8787`、`DISABLE_CRON=1`保持原配置，未代用户登录或发起服务商请求。
- 恢复收据/恢复前成对备份：opencode Temp 下 `password-reset-1793628097905-917b8b31`；**22:02:52** 恢复后全表与事务预期一致，最新成对备份为其 `after-backup` 子目录，证据 `after-backup-receipt.json`。不要用早前备份覆盖新密码及最新操作记录。停机/恢复健康证据为 `password-reset-20261102-stop.json` / `password-reset-20261102-service.json`；后台任务 `sh_19c90ec00001LuYf5GPehlF2Ks`。服务保持运行；下文 PID 25812 为本轮密码恢复之前的历史进程。

## 前批进度：浏览器测试恢复与 P1 生命周期补充验收（2026-11-02）

- 用户要求“开一个浏览器测试并继续后续任务”后，先通过原启动脚本 `-VerifyOnly`，核对 595 项验收产物/冻结源码及原数据库/AES；启动前无 8787 监听或活动任务。北京时间 **21:41:34** 使用原脚本、原数据和冻结验证产物启动测试服务 PID **25812**，仍为 `127.0.0.1:8787`、`DISABLE_CRON=1`、原代理。**21:42:11** 健康/首页/入口资源均 200，入口资源 SHA-256 匹配，随后打开默认浏览器。未登录或代用户输入凭据，也未启动真实同步、续期或 Scanner。
- 启动前后只读核对所有表逐行哈希/AES/任务断点与原停机存档一致；**21:49:30** PID 25812 仍监听，健康 200。服务保留运行，后续不得同库重复启动。启动及健康证据为 opencode Temp 下 `follow-up-browser-start-20261102-{before.log,after.log,health.json,final-health.json}`；后台任务 `sh_19c7e5d9d001S7G3xk3R9sIydF`。首次健康脚本误用只读 `$HOME` 变量，修正变量名后通过；属于检查脚本失败，不是服务失败。
- P1 新增 **3 项**文件 SQLite 关闭重开验收：列表已拉取/待发布、DNS 多页中间片段、已领取但遗留的 owner 租约。新连接与每片新 40 次预算保留原 taskId/generation/cursor/片段；有效租约不提前抢占，只在合成 fixture 中模拟过期。完成后列表只读一次、DNS 页 `0/second` 各一次，成功日志只一条；已完成 taskId 的再次读取不创建新任务。不是实际进程崩溃或旧真实 taskId 的验收。
- 新增可独立运行的 `npm run test:browser:lifecycle`：真实 Chromium **156.0.8078.79** 和 React effects 挂载/卸载，**7 项通过**，覆盖默认关闭/StrictMode、五账号独立推进、隐藏/恢复后同 taskId、退出会话、卸载重挂、已知冷却及当前 HTTP 流失败不重发。使用合成 API/会话/可见性事件及缩短等待，不访问真实数据库或服务商；不宣称操作系统后台标签节流、完整两分钟实测、服务端中断取消或远端撤销已验收。使用独立浏览器 profile，仅关闭该测试浏览器，不关闭用户默认浏览器。
- 浏览器首轮在 Chrome 随机选到 Fetch 禁用端口 6669 时失败；测试启动器改为安全范围端口，并固定 fixture 的 `import.meta.env`，未放宽网络策略。失败日志 `browser-first.log` 保留；最终验收只使用独立副本绿色日志。可选浏览器门禁不加入默认 CI，也不下载浏览器或安装依赖，说明见 `tests/browser/README.md`。
- 新独立验证副本 `C:\Users\15017\AppData\Local\Temp\opencode\follow-up-p1-verify-20261102`：完整 `verify:all` **20 组、598 项，零失败**（595 + 3，不把浏览器 7 项累加进去），Worker/Node 类型及构建、前端构建/类型、主题 108 项通过。494 文件冻结及副本比对一致；源码验证期间未变，最后仅更新工作区文档，不覆盖冻结副本。收据 `acceptance-receipt.json`、冻结 `final-source-hashes.json`、日志 `final-verify-all.log` / `final-build-node.log` / `final-frontend-typecheck.log` / `final-browser-lifecycle.log`；浏览器最终收据 `C:\Users\15017\AppData\Local\Temp\opencode\sync-lifecycle-browser-KY8ZJj\receipt.json`。
- 本轮只改测试、浏览器测试编排和文档；生产源码、原产物、依赖声明/lockfile 与本轮开始时一致，未安装/升级依赖。新副本 Node bundle 与当前服务均为 `1D62A02257721888EAF512A64DB3D62F1129028B28C5814B84B96520FB9FA36B`；没有切换新产物或第二次重启，也没有提交、推送或部署。
- 浏览器打开后出现 **5 条登录失败日志**。**21:50:17** 只读快照为 5 账号、37 域名、83 Actions、**183 logs、88 cache**、77 tasks、534 fragments、1068 items；五账号最新任务仍为原 completed/done、待续跑集合为空，AES 不变。相比旧停机存档只有 cache/logs/sqlite_sequence 改变；旧快照比对因此拒绝通过，不能将其当数据库损坏或恢复旧数据。本轮保留最新登录记录并另做成对备份，证据 `follow-up-current-state-20261102.json`，备份 `follow-up-current-state-20261102-backup`，均在 opencode Temp。没有代用户登录、清失败计数或重置密码。
- P1 的上述补充离线验收完成；真实旧 taskId 连续恢复、真实请求去重与 runtime 崩溃仍需单独授权/验证。下一优先项为 P2 合成规模/耗时/成本，再按 [后续计划](follow-up-plan.md) 处理契约和发布安全；不据此宣称全部 A–F 或生产容量验收完成。

以下“已停机/未经授权不启动”等为 **00:51 存档及更早批次的历史状态**，当前以本节的用户授权启动和最新观察为准。原停机、冻结及验收收据不覆盖。

## 历史存档：任务进度、后续计划与测试服务收尾（2026-11-02）

- P1–P6 分片同步、操作中心/增量日志、预算等待空转/计数/安全续跑，以及 DNSHE 过期 REAL 租约兼容均已完成。最新独立门禁 **20 组、595 项，零失败**；Node/Worker 类型和构建、前端构建/类型、主题 108 项通过。不是阶段 A–F 或生产容量全部验收。
- 用户随后授权重启：2026-11-02 北京时间 **00:36:16** 切换到 `dnshe-lease-verify-20261102`，PID 36884；Node bundle SHA-256 `1D62A02257721888EAF512A64DB3D62F1129028B28C5814B84B96520FB9FA36B`。健康/首页/入口资源均 200 且匹配验证产物，所有表逐行哈希、AES 与当时暂停断点一致；Cron 保持关闭。重启收据 `C:\Users\15017\AppData\Local\Temp\opencode\dnshe-lease-restart-20261102-receipt.json`。
- 本次存档前只读观察（北京时间 **00:49:03**）：五账号最新任务均 completed/done。账号 1 于 **00:41:18** 完成 DNS **16/16**，taskId `66c9bf09-e80a-4ac3-a349-b5cb0bcbc689`、version 44；账号 2–5 为 6/6、5/5、5/5、5/5，完成时间 00:41:09–00:41:11。这是数据库中最新任务完成的证据，不据此声称旧 taskId 的连续恢复已做真实验收；真实请求由用户操作产生，本轮仅查询。
- 当前 5 账号、37 域名、83 Actions、178 logs、77 tasks、534 fragments、1068 items；无实际活动请求/Scanner/租约，待续跑断点集合为空。已成对备份**最新**数据库/AES，不恢复任何旧快照。关闭前记录与备份前缀 `C:\Users\15017\AppData\Local\Temp\opencode\dnshe-lease-close-20261102`。
- 后续按 [后续任务计划与恢复说明](follow-up-plan.md) 执行：优先补齐生命周期/中断恢复验收，再评估规模成本、服务商契约、备份迁移/发布安全及独立续期验收。任务计划保存不等于授权执行，真实同步/续期/Scanner/部署和再次启动均须另行确认。
- 已按用户要求先保存文档（北京时间 **00:50:45**），再于 **2026-11-02 00:51:14.6367901+08:00** 停止 Domain Hub 测试服务 PID 36884；进程已退出，8787 无监听。关闭前后所有表逐行哈希、AES 及断点一致，最新数据库/AES成对备份保留；未停止其他项目进程，未删除目录、数据、构建或日志。停机原始证据为同前缀 `-process.json`，汇总与最终文档哈希见 `-receipt.json`。未经另行授权不重新启动。

以下各批“未重启/旧 PID/待授权”等描述是**当批验证时的历史状态**；当前状态以本节和关闭收据为准。冻结的验证副本及原验收收据不被本次文档更新覆盖。

## 历史批次：DNSHE 过期 REAL 租约兼容（2026-11-02）

- 只读调查确认账号 1 最近两次暂停为本地凭据排队超时、`request_sent=false`，不是 DNSHE 官方 429 或各 40 次预算耗尽。已过期的租约是安全整数值的 JSON real，原准入 SQL 只接受 integer，JS 解析却接受，造成持续等待至超时。能复现产生 REAL 的写入路径，不据此推断历史清理失败的确切原因。
- `dnshe-account-scheduler.ts` 对 leaseUntil 接受 integer/real，但仍必须非负、处于安全整数范围并与 INTEGER CAST 相等；新领取显式 CAST 参数，避免清理失败后留下同类状态。保留原 owner/事件上限/损坏检查、已满滚动窗口/冷却/取消/未知结果/fencing 及 D1/external 各 40；不改通用数字适配，不清缓存、换 Key、迁移或重置任务。
- 独立副本 `C:\Users\15017\AppData\Local\Temp\opencode\dnshe-lease-verify-20261102`：**20 组、595 项测试，零失败**，比前批 572 项新增 23 项（Node 调度 19、暂停 DNS 12/16 同 taskId 续跑 1、workerd/D1 3）。Worker/Node 类型及构建、前端构建/类型、主题 108 项通过；收据 `acceptance-receipt.json`、完整日志 `final-verify-all.log`。
- 新增回归在旧代码上稳定失败 4 项（`red-scheduler.log`）；修复后全量通过，不删除旧覆盖。模拟的 12/16 暂停任务只读剩余 4 域，不重新读列表或前 12 域，原 generation/taskId 与旧缓存保留，每个新执行预算不超过 40。
- 将原账号 1 状态只读复制到独立内存，使用修复后的真实调度器验证：30 条历史事件在领取时保留；原租约/事件均过期，6 次 SQLite 调用、无需等待便完成一次授权与释放。只做内存协调，不 fetch、不修改原状态；证据 `copied-state-recovery.json`。
- 原构建产物、当前运行副本和依赖清单哈希不变。旧 PID 2728 仍运行；本轮未重启、部署、提交、推送、真实同步/续期或恢复 Scanner，未修改原数据库/AES或 `DISABLE_CRON=1`。旧暂停退避不追溯修改，修复须另行获授权重启才生效；离线验证不替代生产 API/云端 CPU/容量验收。

## 历史批次：预算诊断与安全续跑（2026-11-02）

- 修复 DNSHE 秒级数据库时钟与 `+1ms` 滚动窗口到期边界的短等待查询空转；不放宽每 Key 30/60s，不清限频状态。
- 预算错误保存拒绝时的类别、原因、已用、预留、上限、剩余和请求成本；同步任务/日志包含 phase。仅断点保存及权威读取均确认的预算耗尽返回可续跑的暂停状态，原游标不变；关闭预算、未知上游结果、保存/读取失败或 fencing 冲突仍返回错误。
- 页面继续同一 taskId，沿用可见会话、2 分钟等待窗口、每账号每轮 500 片；连续三个预算暂停且未返回 queued 分片时停止并提示。不自动开启同步设置，不将分片暂停当完整成功。
- 独立验证目录：`C:\Users\15017\AppData\Local\Temp\opencode\budget-resume-verify-20261101`。完整 `npm run verify:all` 通过 **20 组、572 项，零失败**（前一操作中心批次 554 项，新增 18 项）。Worker/Node 类型、前端构建/类型、Worker/Node 构建及主题 108 项通过。日志 `final-verify-all.log`、`final-build-node.log`；验收收据 `acceptance-receipt.json`。
- 首轮全量测试通过，但副本拷贝排除规则误跳过前端 `features/data` 源码，导致前端构建缺模块；已补齐独立副本及静态资源后完整重跑通过。原失败记录保留；没有跳过测试或改动原产物。
- 本轮只编辑源码及使用合成上游验证。原数据库/AES、运行副本及依赖清单未改，不发起真实同步/续期或恢复 Scanner，不重启、提交、推送或部署。D1/external 各 40 和 `DISABLE_CRON=1` 保持原策略。离线验证不证明此次历史错误的确切触发步骤，也不替代真实 API、生产容量或 Workers Free CPU 验收。

## 历史批次：Cron 只提醒续期与页面分片同步（P2–P6）

**P2–P6 源码及文档已完成，最终离线门禁通过：20 组、532 项测试，零失败。原服务未重启、未部署；没有真实同步/续期/API 调用或 Scanner 恢复。** 登录后自动同步默认关闭，明确续期窗口默认 0；HTTP/Cron 源码默认严格 external/D1 各 40 预算。

实现、设置与兼容接口变化见 [Cron 与页面分片完整同步](cron-sliced-sync.md)及工作区方案。Cron 仅读本地提醒并做有界 DNSHE 续期/未知结果 GET 核验；手动和登录后页面逐片推进完整同步，不带续期。绑定/换凭据不再返回长任务 Action；既有脚本须消费计划与 `sync-step`。

新增保护包括：单调 mutation/tombstone、generation/revision/version/owner fencing、完整列表 seen/候选条件删除、DNS 连续片段完整发布与原子断言、跨账号 ID 冲突失败关闭、续期发送前再次 fencing、已保存账号不因审计或预算耗尽误报失败、通知去重/退避和积压警告。全部使用合成上游；旧长任务测试只作显式历史回归，不导入生产。

以下正文包含 10 月 31 日、11 月 1 日早前批次的历史记录（旧 Cron 长同步、双槽、Action 等），**不代表当前新入口语义**；不覆盖或改写当时真实测试和获授权重启证据。离线通过不等于 Workers Free 10 ms CPU、生产容量或真实续期验收。

### 最终验证与收据

- 独立源码副本：`C:\Users\15017\AppData\Local\Temp\opencode\cron-sync-p2-p6-verify-20261101`；完整绿色日志 `verify-final-v4.log`。`npm run verify:all` 通过 **20 组、532 项**（此前 P1 494 项 + 新增 38 项）；包括预算/任务/automation 63、安全 107、workerd/D1 80、前端安全 22，及其余完整原门禁。Worker/Node 类型、Worker/前端 production 构建、Node 六组原自检和主题 108 项均通过；另有 `node-build-final-v2.log` 与 `frontend-type-final.log`。
- 红→绿修正均保留原覆盖：旧同步回归改为真实 `sync-step` 推进、不跳过故障测试；workerd fixture 的 secret 改用离线 `plain:` 编码；续期确认适配 D1 trigger 更新计数，并保留 409/上游类型错误。最后一轮旧协调期限回归暴露 timer 小数毫秒舍入后已超时阶段仍可能领取下一 SQL 的边界，改为阶段 timeout 永久关闭，不放宽期限或跳过回归。
- 本轮前 469 文件哈希基线保留，未删除基线文件；最终 482 个非依赖/非产物文件与验证副本 SHA-256 一致。最终冻结 `cron-sync-p2-p6-source-final-20261101.json`、收据 `cron-sync-p2-p6-final-receipt-20261101.json` 位于上述 opencode Temp 根目录。`package.json` 仅增加 automation 测试编排；依赖声明/engines 与既有副本一致，lockfile 未变，未安装或升级依赖。
- 原 `dist-node/server.mjs` SHA-256 仍为 `D511B52CF0054730078C40BB47A3E83AF0BF007F35C65F86C662C447871EAAA3`；所有构建只在独立副本，不覆盖原前端/Node 构建产物、不操作原真实数据库或 AES，不提交、推送、部署或重启，不恢复 Scanner，原 `DISABLE_CRON=1` 保持不变。
- 仍待可靠契约/独立授权：DNSHE 同登录身份多 Key 归并、允许续期窗口、DigitalPlat 生产分页/meta、华为云精确限频、少量真实同步/续期和云端 CPU/容量验收。历史残留域名 `dhauditmvw6efey9dec48dns.us.ci`（ID `4739823932`）删除 403，仍需后台/管理员处理，本轮未操作。

**本轮新方案：DNSHE 改为独立凭据通道与滚动 30/60s 控制，取消生产 DNSHE 的部署级双槽和 Scanner 的固定两路；其他服务商政策不变。** 这是用户在真实五账号测试后提出的新优化，不改写 10 月 31 日测试时的保护配置和历史证据。当前按 Key 协调，并不宣称已解决同登录账号多 Key 的身份归并；代码与离线验证完成后，按用户授权重启原本地 Node 服务启用新构建，未追加真实 API 请求或自动恢复扫描。重启核验见下文。

**累计交付包括核心修复、同步结果/Action/前端闭环、五家服务商列表完整性保护、七家统一传输层、部署级共享并发准入/429 冷却、五家已确认业务限流码识别、数据库协调等待期限及浏览器发现的 DNSHE 同步/Scanner 自拥塞修复，不是阶段 A–F 全部完成，也不是 F06 全部验收或上线验收。** 业务源码已修改；未提交、未推送、未部署。本批回归只使用本地数据库、本地 workerd 与合成上游响应，没有由回归发起真实服务商调用；用户同期自行在浏览器使用真实账号，不能将用户操作算作离线 fixture。此前传输层批次曾发生旧 mock 漏接的真实阿里云请求，失败且未创建资源，详情见下文；修复后服务商 Node 测试默认禁止真实 fetch。此前真实 DNSHE 实测是单独的已授权阶段。

## 1. 已实施内容

### 鉴权与数据库故障边界

- 鉴权配置读取异常、部分密码行、启用 2FA 却缺少可用密钥均失败关闭，不能重新开放匿名初始化。
- 初始化 claim 与用户名、密码 hash/salt 在一个数据库事务中完成；并发 setup 只允许一个请求成功。修改密码也改为原子写入。
- 会话签发必须写入成功；明确过期返回 `401 session_expired`，会话存储异常返回 503。
- API schema 自举失败阻断业务请求；readiness 按 D1 binding 缓存，不共享一个全局布尔值。

主要路径：`src/db/dao/auth-dao.ts`、`src/routes/auth.ts`、`src/index.ts`。

### Cloudflare 跨轮 zone 同步

- 手动与 cron 共用 `src/services/cloudflare-sync.ts`；每页 upsert 与下次游标原子提交，最后一页才允许 prune。
- version 2 快照保留整个周期的 seen IDs 和初始删除候选；周期后新增行、候选中途修改的行不被旧快照删除。
- 同账号持久化租约防止并发；过期 owner 不能复活或写入，旧 runner 的 finally 不能释放新 owner 的锁。
- 协调读取使用严格 SQL，失败直接终止。旧/损坏游标和凭据 scope hash 不匹配时从第一页重新建立快照。
- 重复页、页内重复 ID、跳页等不完整结果不能用于 prune；上游/游标写入失败保留之前已提交的页面。
- Cloudflare DNS 拉取耗尽页数时抛错，不再把已拉取片段返回为成功完整列表。

主要路径：`src/db/dao/sync-dao.ts`、`src/db/dao/domain-dao.ts`、`src/cloudflare.ts`、`src/cron/jobs/daily-sync.ts`。

### DNSHE 契约、限频与 DNS 缓存

- 域名 offset 与 DNS cursor 分页拉全后才返回完整结果；有效页长、total、游标重复、矛盾元信息、跳页和 50 页耗尽均有保护。
- `ProviderApiError` 保留上游 status、错误码、details 与 Retry-After；面板鉴权状态与服务商权限失败分开。
- DNSHE 请求配置 20 秒超时；续期窗口按错误码识别；写操作不自动重试。
- 10 月 31 日旧批次：生产账号客户端接入 D1-backed 每 Key 请求预算，默认间隔 2.1 秒、预约最多等待 4 秒；429 cooldown 跨客户端共享。11 月 1 日生产构建入口改用下述独立通道，旧类与升级兼容测试保留。
- 浏览器测试暴露的同步自拥塞已修复：绑定/换 Key/单账号深度同步及 daily-sync 的 DNSHE 逐域 DNS 拉取改为串行。前序配额/列表已占用下一次 2.1 秒预约时，两路拉取会让第二路排到约 4.2 秒，超过 4 秒上限；不扩大预约窗口或跳过真实预算。offset/cursor 分页仍拉全，cron 缓存快路径不变；外部并发/真实 429/共享冷却仍报告 partial 并保留最后成功缓存，不承诺串行能消除全部限流。
- DNSHE 读取失败、缺失 records、明确 `complete=false` 不得覆盖最后成功 DNS 缓存；域名列表的权威空结果仍可正常清理过期本地域名。
- DNS 完整缓存替换与 dirty 标记清除改为严格原子事务，写入失败保留旧缓存和 dirty。
- DNS 输入采用字段白名单，服务端决定 domain/record 定位字段；结构化 SRV/CAA 可不传 content，TXT 空白、IDN 与通配名称保留。

主要路径：`src/dnshe.ts`、`src/cron/jobs/upstream-sync.ts`、`src/services/dnshe-request-budget.ts`、`src/services/dns-snapshot.ts`、`src/services/dns-input.ts`、`src/services/dns-service.ts`、`src/routes/dns.ts`。

### DNSPod / 阿里云 / 华为云 / Vercel / DigitalPlat 列表保护

- `CompleteList<T>` 统一验证显式数组、必要字段、唯一标识、稳定总数和空页进度；页数耗尽、重复条目、缺失/矛盾元信息均抛 `incomplete_response`，不发布拉取片段。
- DNSPod 域名请求显式 `Type=ALL`，按 `DomainCountInfo.AllTotal` 完成；DNS 校验 `RecordCountInfo.TotalCount/ListCount`。短页按实际条数推进 offset，不按请求页长跳过数据。
- 阿里云修复“请求 JSON 却按 XML 解析”的成功响应读空问题；JSON/XML 归一化后校验 `TotalCount/PageNumber/PageSize`，拒绝短非末页。JSON 写响应保留 DomainId/RecordId。XML 兼容仅支持受限 RPC 外壳，拒绝 DTD、截断、重复字段和未知列表子项，不猜测恢复坏文档。
- 华为云域名及原始 Recordset 共用 `metadata.total_count` 和实际 offset 校验；可选 next link 与已收集条数不能矛盾，不携带凭据跟随上游 URL。详情只有字段有效且 ID 匹配才采用，最终完整列表查询失败向上传播，不吞为“目标不存在”。批量写前与冲突合并查询共享这些保护；未新增 DNS 写重试。
- Vercel 改用 `pagination.next` 作为 `until` 向旧记录续拉，校验 count 和严格递减游标；只有显式 `next=null` 才终止，不依赖短页、最后条目的 createdAt 或 since。DNS 记录支持官方 uid 字段。
- DigitalPlat 保留列表完整外壳，未知分页/非空 meta 明确拒绝；不套用未经确认的 Domain-OSS page/per_page 契约。合法空 TXT 值不再丢失，展开 IDs 保留原 RRset 下标，scalar 空值参与合并时也保留；protected 记录仍不展示编辑入口，标志必须是布尔值。
- 五家 DNS adapters 及 legacy domain adapter 接入完整 DNS 结果校验，补齐后者的提供商定位参数；不再用 `records || []` 把失败包装为成功空结果。

主要路径：`src/providers/list-integrity.ts`、`src/providers/alidns-response.ts`、五家客户端、`src/providers/dns/`、`src/providers/domain/legacy-client-adapter.ts`。

### 七家统一请求传输层与写入止损

- DNSHE、Cloudflare、DNSPod、阿里云、华为云、Vercel、DigitalPlat 的 fetch 均进入 `requestProviderText()`，默认 20 秒贯穿响应头等待和响应体读取，不在拿到头后重新计时。单次响应按实际字节限制为 4 MiB，Content-Length 超限可提前拒绝；UTF-8 分片解码，拒绝损坏/截断编码，阿里云继续兼容受限 XML。
- 使用请求局部 AbortController，并清理 timer、caller signal listener 与 reader 锁；超时/调用方取消尽力取消 body，非协作 fetch 晚到的 body 也取消。网络异常不透出原异常文本、请求 URL 或凭据。请求期限不包括 DNSHE 的共享预算排队，预算预约完成后才开始计时。
- 七家上游 HTTP/业务失败传播 `ProviderApiError`，保留 status、原 error_code 与合法 Retry-After；秒数、标准 HTTP 日期、零与已过日期支持，负数、小数、非有限数、溢出整数和无效日期拒绝。HTTP 200 的普通业务错误仍保留上游 status=200，面板响应为 502，不视为业务成功；下述已确认业务限流例外映射为面板 429。
- DNSHE 既有 D1 per-key 预算及 429 cooldown 保留；429 的非 JSON、超大或慢体错误仍阻断该 Key 后续请求。上一批只统一传输；本批另接入下述部署级 scheduler，仍未新增优先级队列、通用读重试或 DNS 写自动重试。
- DigitalPlat POST 创建仅在可读、合法外壳、明确 `success=false` 且 HTTP 409 的 API 冲突后允许 PATCH 合并；超时、网络、权限、429、412，以及不可读/超大/坏 UTF-8 的 409 均不触发第二次写入。ETag 和明确冲突合并行为保留。
- 华为云仅 GET 保留网络/404 节点探测，候选共享一次总期限；超时立即传播，401/403/429 不换节点。POST/PUT/PATCH/DELETE 的失败结果不换节点重发；明确 API 冲突后的业务合并保留，权限错误即使包含冲突词也不进入合并。
- `HuaweiApiError` 现在继承 `ProviderApiError`；通用 `code` 为 `upstream_*`，原上游码使用 `error_code`，保留 `httpStatus` 与 `rawMessage` 供现有内部消费。新增最后一个可选构造参数配置请求限制，不改现有公开路由或凭据签名。
- 增加真实七家客户端 → 单项 DNS HTTP / 两个同步 Action 入口 / SQLite 缓存回归：失败保留最后成功缓存和既有 dirty，Action 不误结算为 completed；完整空 DNS 响应仍可替换缓存并清除 dirty。批量 DNS 结果目前仍以逐项 message 汇总，不宣称逐项错误 details 已统一。

主要路径：`src/providers/provider-request.ts`、七家客户端、`tests/unit/provider-request.test.ts`、`tests/helpers/provider-transport.ts`、`tests/workers/provider-request.test.mjs`、`tests/integration/safety-regressions.test.ts`。

### 七家部署级共享请求准入与冷却

- 新增 `SharedProviderRequestScheduler`，同一数据库部署、同一服务商共用两张 permit，限制**跟踪中的本地传输尝试**。不同账号/Token/Key 不分桶，其他服务商不受该桶影响；满额立即返回 429，不创建调度等待队列，不新增每分钟猜测配额。并发上限不是请求速率限制，不能保证首次上游 429 不会发生。
- 两个槽位存于既有 cache 的 `provider_scheduler:v1:<provider>:slot:<0|1>`。SQL 原子检查 cooldown 并领取 permit，UUID owner 条件释放；期限为传输预算加 5 秒余量并向秒取整。过期可恢复遗留槽位，旧 owner 的清理不能删除新 owner。慢 claim 若已不足以覆盖传输预算，释放后拒绝发送。
- DAO 的七家生产客户端、绑定校验及更换凭据校验都注入 scheduler，覆盖 DNS、配额、WHOIS/Scanner、手动与 cron 同步的共同客户端出口。`custom` 不调用上游；独立直接构造的客户端仍可不传 scheduler，兼容原调用签名，不宣称所有外部库使用方自动拥有共享保护。
- 收到 HTTP 429 响应头后、读取或信任响应体前，向 `provider_scheduler:v1:<provider>:blocked` 原子写入共享 cooldown。合法 Retry-After 缺失时默认 60 秒，零/已过日期至少 1 秒，只延长不缩短；HTML、超大或慢体不绕过这一步。冷却不撤销已在途请求。
- DNSHE 原 per-key 2.1 秒/最多预约等待 4 秒的预算保留；有效 `details.reset_at`（UTC+8）也延长部署级冷却。非法/归一化日期忽略，不产生 NaN，也不覆盖原 429。本地 `scheduler_busy/cooldown` 不再被误当作上游 Key 冷却，但原预算预约仍在共享准入之前，可能已占用下一次预约。
- `scheduler_busy` / `scheduler_cooldown` 对外为 `upstream_*`、HTTP 429、带 Retry-After，details 标明 `scope=deployment_provider` 和 `request_sent=false`。数据库协调故障为 `upstream_scheduler_unavailable` / 502；claim 失败不发请求，损坏 cooldown 失败关闭且不被后续 block 静默修复。
- 429 冷却写失败不声称跨请求冷却已持久化，返回协调错误并尽力取消未读 body。释放失败保留原传输错误；若传输原本成功则返回可能已发送/需先核对的协调错误，遗留 permit 等待过期，不重发 DNS 写。此时后续请求不一定已经被冷却。
- 单账号创建/更新保留类型化错误；批量绑定保持 HTTP 200 汇总外壳，每项增加可选 `error_code/status/retry_after_ms/details`，`status` 为面板状态，上游状态在 details 中，凭据仍脱敏。未成功保存的账号不启动同步 Action。
- **边界**：本批已补 acquire/block/release 独立协调等待期限，细节见下文；HTTP 429 与业务限流 block 仍同时参与传输超时 race，但超时不能撤销已开始的数据库写入。20 秒不是整个请求、同步或 Action 的硬截止。permit 过期、abort 或 runtime 中断不能证明上游写已停止；可靠续跑、协作式取消、精确配额分桶、未确认业务限流码、优先级及通用读重试仍待补齐。

主要路径：`src/services/provider-request-scheduler.ts`、`src/providers/provider-request.ts`、`src/db/dao/account-dao.ts`、`src/dnshe.ts`、`src/routes/accounts.ts`、`tests/unit/provider-scheduler.test.ts`、`tests/workers/`、`tests/integration/safety-regressions.test.ts`。

### 五家已确认业务限流码与共享冷却

| 服务商 | 精确识别范围与依据 |
|---|---|
| DNSHE | 合法 `success=false` 外壳的 `error_code=rate_limit_exceeded`，来自本地原始 V2.0 文档的错误表；`quota_exceeded` 不作为业务速率限制识别 |
| DNSPod | `Response.Error.Code` 为 `RequestLimitExceeded`、`RequestLimitExceeded.GlobalRegionUinLimitExceeded`、`RequestLimitExceeded.IPLimitExceeded`、`RequestLimitExceeded.UinLimitExceeded`、`RequestLimitExceeded.BatchTaskLimit`、`RequestLimitExceeded.CreateDomainLimit`、`RequestLimitExceeded.RequestLimitExceeded`，依据 [DNSPod 官方错误码](https://www.tencentcloud.com/document/product/1157/49044)；不做任意前缀匹配 |
| 阿里云公网 DNS | JSON 或受限 XML `<Error>` 外壳的 `Code=Throttling` / `Throttling.User`，依据 [Alidns 2015-01-09 公共错误码](https://help.aliyun.com/zh/dns/api-alidns-2015-01-09-errorcodes)，不是 PrivateZone 或其他产品的错误表 |
| 华为云 | `error_code` / `code=APIGW.0308`，依据 [DNS 错误表](https://support.huaweicloud.com/intl/zh-cn/api-dns/ErrorCode.html) 所链接的 [API 签名通用错误码](https://support.huaweicloud.com/intl/zh-cn/devg-apisign/api-sign-errorcode.html)；仅确认错误语义，不套用通用网关的默认配额 |
| Vercel | `error.code=rate_limited`，依据 [REST API Errors](https://vercel.com/docs/rest-api/errors)；官方作用域为 endpoint，本地部署级冷却仍更保守 |

- `recognizeProviderRateLimit()` 只观察完整、有界、合法 UTF-8 响应，且在释放 permit 前完成共享冷却写入；业务冷却仍参与同一次传输期限。不从 message、相近码、数组/截断外壳或成功响应中的孤立错误码猜测。Cloudflare / DigitalPlat 暂不新增未经确认的业务码。
- 正常传播时保留原 `ProviderApiError.status/error_code` 与 `details.upstream_status/upstream_code`；新增 `rateLimited=true`、`details.rate_limited=true`，面板 `statusCode=429`。例如 Alidns 原 400、DNSPod 原 200 均不会被伪造成上游 429。非 DNSHE 客户端的明确限流译文优先于权限/冲突/配额的旧文本猜测，DNSHE 继续保留上游消息。
- 冷却使用合法 Retry-After，缺失时默认 60 秒、至少 1 秒；DNSHE 的严格 UTC+8 `details.reset_at` 与 Vercel 的安全整数 epoch `error.limit.reset`（秒）/`resetMs`（毫秒）只能延长，不缩短该次默认/头部冷却。非法/溢出/归一化时间忽略，不产生 NaN。DNSHE 业务限流同时进入原 per-key 预算。
- 普通资源配额（DNSHE `quota_exceeded`、DNSPod `LimitExceeded.*`、华为云 `DNS.0403/0404` / `APIGW.0501`）与华为云锁竞争 `DNS.0021` 不按业务码冷却。**已有七家 HTTP 429 头阶段保守冷却策略保持不变**：即便该 429 后续被解释为配额，仍冷却，但不凭配额码新增 `rateLimited` 标记。
- 华为云明确业务限流不换节点、不进入冲突合并，Recordset 详情备用路径也不吞掉限流/协调失败。没有新增 DNS 写重试或通用读重试；协调写失败仍返回 `scheduler_unavailable`，不声称共享冷却已成功，慢写超时也不能撤销在途数据库操作。
- DNS HTTP / 单账号与批量绑定保留原状态、码及冷却信息；批量绑定仍为 HTTP 200 外壳、每项面板状态为 429，不保存失败账号或启动同步。同步 `SyncIssue.status` 继续为原上游状态，新增可选 `panelStatus` 与明确业务限流的 `rateLimited`；Action 不误结算 completed，最后成功缓存与 dirty 保留。

主要路径：`src/providers/provider-rate-limit.ts`、`src/providers/provider-request.ts`、`src/errors/provider-api-error.ts`、五家客户端、`src/services/sync-result.ts`、`tests/unit/provider-scheduler.test.ts`、`tests/workers/provider-request.test.mjs`、`tests/integration/safety-regressions.test.ts`。

### 数据库协调等待期限（本批）

- `CoordinationDeadline` 默认 2000ms，使用单调时钟；每个协调阶段的多个 SQL 共用一个期限，不逐 SQL 重新给满预算。timer、微任务执行前及结果返回后都检查期限；成功、失败和超时均清理 timer，晚到拒绝已被消费，不透出 SQL、URL 或凭据。
- 共享 scheduler 的 acquire 阶段包括最多两个槽位 claim 与 cooldown 诊断查询；block 和 release 各有独立 2 秒协调等待上限。领取超时返回 `upstream_scheduler_timeout` / 502、`request_sent=false`，绝不发上游请求，也不继续领取另一个槽。损坏状态/明确 DB 失败仍为原 `scheduler_unavailable`。
- 晚到 claim 返回本次 UUID owner 时仅尝试一次有界 owner 条件删除；晚到空结果不继续循环。清理本身有独立 2 秒期限，失败或 Worker 中断时只依赖持久化 permit 过期恢复，不承诺清理完成。原慢 claim 的“剩余租约不足”保护保留，拒绝前的清理也有界。
- release 超时不触发重发，不能删除新 owner；原网络/读取/传输超时等主错误优先保留。传输原本成功则返回可能已发送、需先刷新核对的协调错误，不能称为“DNS 写未发生”。遗留许可直到删除晚到或过期才恢复。
- 共享 block 超时报告 `coordination_operation=block`、`coordination_timeout_ms=2000`、`cooldown_persisted=unknown`，不声称冷却已持久化。在途 block 可能在返回错误后才成功；单调冷却 SQL 不变，晚到短冷却不能覆盖长冷却。传输期限更短时仍优先返回既有传输超时，并尽力取消未读 body。
- DNSHE per-key 预算同步加入有界协调：hash/预约/满额诊断共用 2 秒阶段；原最多 4 秒预约等待保持不变，实际等待后冷却检查另有 2 秒阶段；未等待时检查沿用预约阶段期限。block 的 hash、原子双行 batch 与两行确认读共用 2 秒，不能因某个确认读挂起无限等待。预约晚到不撤销或删除共享预算，可能额外占用下一次预约，但不发请求。
- DNSHE 使用 `upstream_budget_timeout` / `budget_unavailable`、面板 502 与 `scope=dnshe_key`；预约失败标明未发送，冷却失败标明可能已发送/需核对。不可读 429 等已有主传输错误不被辅助 per-key 冷却故障覆盖；此时也不保证 cooldown 持久化。正常业务限流后的冷却协调失败仍显式传播。
- 原 Node/SQLite 预约 SQL 使用 REAL 加法再转 TEXT，历史值可能为 `5200.0`；只兼容精确的合法整数 `.0` 后缀，新预约显式整数运算、block 写回规范整数。任意分数、指数、负数、空值和超安全整数均失败关闭，不用 NaN 或无限等待静默放行；不修改 schema 或清除已有预算。
- **期限不是数据库取消或任务硬截止**：D1 `first/run/batch` 没有在此传入 AbortSignal；同步 SQLite 和事件循环阻塞不能被 JS timer 抢占。默认实现只限制异步协调等待，不涵盖其它 DAO、通知、缓存、整个 HTTP/客户端方法或 Action。直接注入的第三方 scheduler/budget 也不自动获得这些期限。可靠持久化续跑、协作式取消和未知写结果对账/补偿仍未实现。

主要路径：`src/services/coordination-deadline.ts`、`src/services/provider-request-scheduler.ts`、`src/services/dnshe-request-budget.ts`、`src/dnshe.ts`、`tests/helpers/coordination-fault.ts`、`tests/unit/provider-scheduler.test.ts`、`tests/unit/dnshe-contract.test.ts`、`tests/workers/`、`tests/integration/safety-regressions.test.ts`。

### 结构化同步结果与统一 Action

- 新增 `SyncIssue`、`AccountSyncResult`、`SyncSummary` 与 `IncompleteSyncError`。账号结果区分 completed/partial/failed/skipped；多个账号去重汇总，完整空账号仍为成功。
- DNSHE 域名已落库但逐域 DNS 读取失败时保留最后成功缓存，并报告 partial，不再以域名总数掩盖 DNS 失败。`deepSyncAccountDomains(): Promise<number>` 保留签名，但未完整完成会抛 typed error。
- Cloudflare 分片未完成及后续分页异常保留已提交数据，并携带继续页/失败原因；不会将一个已提交分片误报为完整同步。
- 全量手动同步仍执行既有续期、到期提醒、通知与清理，结束后以结构化结果结算；scheduled 模式保留账号轮转并返回本轮结果，不承诺一个 cron 周期覆盖全部账号。
- 统一 `queueSyncAction()` 编排单账号、批量账号、换凭据及手动同步入口，返回可查询的 `actionId`。自定义分组绑定明确 skipped，不创建无意义同步 Action。
- Action 新增 partial；PATCH 只更新显式提供的字段，忽略 undefined、允许显式 null，并校验 progress。终态不可再被晚到 runner 或 PATCH 覆盖。
- 账号已保存但 Action 创建/登记失败时，返回保存成功结果和 `syncWarning`，不误报绑定或凭据更新失败。`waitUntil` 同步抛错时不执行上游任务，并尝试结算为 failed。
- 补齐 Vercel `api_secret` 单凭据更新的校验、加密存储与同步触发。

主要路径：`src/services/sync-result.ts`、`src/services/sync-action-service.ts`、`src/services/account-sync-service.ts`、`src/services/cloudflare-sync.ts`、`src/cron/jobs/daily-sync.ts`、`src/services/action-service.ts`、`src/repositories/action-repository.ts`、`src/routes/accounts.ts`、`src/routes/domains.ts`、`src/routes/actions.ts`、`src/db/dao/account-dao.ts`。

### 前端同步结果消费

- 绑定、批量绑定、各家凭据更新及手动同步统一消费 `actionId`，不再用固定延迟或域名指纹变化推断完成；操作中心补齐 partial 文案与警告图标。
- 轮询只接受匹配 ID 的有效 Action，区分 completed/partial/failed/cancelled，处理 HTTP 错误、缺 ID、启动警告、超时和会话变化。
- 默认最多等待 60 秒，间隔 1500ms，单次查询最多 10 秒；超时明确提示“未确认完成，任务可能已中断”，不自动重复上游操作。
- 已确认终态后刷新缓存视图；全量刷新返回并等待 `Promise.all`。成功提示仅为“同步完成”，不承诺所有列表读取成功；部分列表读取函数仍会自行捕获错误。
- 账号保存后收到 `syncWarning` 时仅刷新视图并展示警告，不轮询不存在的任务，不提示同步成功。旧会话返回不能触发新会话的同步结果通知。

主要路径：`frontend/src/lib/sync-action.ts`、`frontend/src/app/useAppControllerView.tsx`、各 provider hooks、`frontend/src/features/accounts/components/bind-schema/`、`frontend/src/components/patterns/ActionCenter.tsx`。

### Scanner、错误展示与 CI

- WHOIS 不再使用假公共凭据；WHOIS/DNS 单项 HTTP 路由保留上游错误元信息。CORS 允许 PATCH。
- 业务 403 不强制登出；只有明确面板会话错误才清除当前会话，旧请求不能清除新会话。
- Scanner 要求有效账号，失败归为未知而非已注册；429 任务保留在队列，仅用户显式继续才重试；并发断点只越过连续成功任务。
- 浏览器五账号扫描原来每账号一路、同时发起五个 WHOIS，与部署级同服务商双槽准入不匹配。现同一扫描运行最多两路请求，保留各账号至少 2.1 秒起始间隔；前端候位有界于账号数，等待中的账号在暂停/停止后不领取或发送新任务。后端仍满额立即拒绝，不新增服务端等待队列，也不保证其他标签页/后台同步不占名额。
- Scanner 暂停提示按精确错误码区分本地 `scheduler_busy`、`scheduler_cooldown`、DNSHE `rate_limited` 预算、上游 `rate_limit_exceeded` 与配额不足；未知 429 只报告来源未确认，不再一律归因为上游限流/配额上限。合法响应 `retry_after_ms` 展示建议等待时间，不自动恢复；日志断点使用实际最早未完成候选，而不是碰巧报错的并发候选。同一暂停阶段仅弹一次警告，不保证在途请求被取消。
- 后台账号同步按上述结构化结果汇总，避免外层把全部账号异常或 DNS 部分失败当作成功。
- 新增共享 `.github/workflows/verify.yml`；CI 调用完整验证，deploy 必须等待 verify 成功，并设置发布 concurrency。

### DNSHE 独立凭据通道（2026-11-01，新方案）

- 新增 `src/services/dnshe-account-scheduler.ts`；绑定校验、换 Key 校验、正常账号客户端三个生产构建点统一接入。WHOIS、同步、配额和写操作共享同一 Key 的数据库状态，不再争抢两个 DNSHE 总槽。每 Key 只跟踪一个在途尝试，各 Key 独立；没有单次 invocation 的无界上游 fan-out，也不承诺无限资源。
- 滚动 60 秒最多 30 次发送授权，不按整分钟重置。数据库保存至多 30 个有界事件，SHA-256 索引不包含明文凭据；owner 租约、条件写和最终冷却检查在共享数据库协调，跨客户端/标签页/后台任务/同库 Node 连接共用额度，不以进程内 Map 作为权威预算。
- 不再预约未来发送：竞争同 Key 的调用只等待；拿到通道后才确认本次发送授权。D1/SQLite 的时钟用于额度和租约，不依赖不同 Node 主机的客户端墙钟。SQL 与外部 fetch 无法组成原子事务，故事件保留至“最晚允许发送时间 + 60 秒 + 1 ms”，发送前同步检查授权期限；协调默认 2 秒，加 1 秒覆盖数据库整秒时钟舍入。失败、取消、超时或过期授权不退款，可能略低于理论 30/min，但不会为了补足次数重发。
- 每次等待有独立 65 秒期限，数据库各协调阶段仍共用 2 秒期限；总等待另有单调时钟保护，睡眠按至多 1 秒分片检查取消。同 Key 通道竞争最多每 10 秒重查一次，避免大量 SQL 轮询；不是严格 FIFO，也不是持久化任务队列。超时明确未发送，无法保证每个竞争调用都在期限内获准；无新增 DNS 写自动重试。
- 新的上游 429/确认业务限流只写当前 Key 单调冷却，不再将一个账号的失败广播给所有 DNSHE Key。读取并尊重既有 per-key blocked 与部署级 blocked：旧全局冷却未结束时仍全局阻断，不删除旧状态；损坏状态和协调失败均失败关闭。
- 旧预算只记录预约时间而没有滚动历史。首次使用新通道且发现旧预算时，保守等到旧预约时间后一个完整分钟再发送，兼容历史整数 `.0`，不清空预算。升级时需使所有使用该数据库的旧生产实例停止旧调度后再启用新构建；旧、新版本同时发送不能保证一个统一滚动模型，不能靠清缓存绕过此边界。
- Scanner 取消固定总两路，按不同 account ID 各一路，仍保留前端每账号至少 2.1 秒的节奏；重复 ID 不创建重复流水线。后端明确 `dnshe_key` 的冷却/额度失败只停本轮该账号，其他账号继续；未完成项保留最早断点，不自动恢复或重试冷却账号。旧全局/未知 429 仍全局暂停。慢账号没有共享槽可阻塞其他账号。
- 手动暂停、全局自动暂停和重置发出 pending WHOIS AbortSignal；WHOIS 路由/服务/客户端向后端等待与 fetch 传递请求信号。暂停后不领取新候选；已发送请求的取消不能证明上游已终止，客户端断连向服务端传播也取决于运行时，不将其描述成可靠远端撤销。未确认结果不能计作已注册/成功，断点不跨过失败项。
- **身份边界**：当前只有绑定 Key，没有可靠 DNSHE 登录账号 ID。同 Key 不能通过多个客户端扩大额度；同登录账号不同 Key、换 Key、不同数据库部署及面板之外的程序仍可能合计超过登录账号配额。没有以别名或本地行 ID 猜测上游身份；一个账号一把 Key 时与此次五账号测试模型一致，多 Key 身份归并仍待可靠契约或显式映射设计。因此本轮不能宣称“任意登录账号全局 30/min”已完成。
- 离线验证新增 1000 独立凭据/前端流水线、跨 SQLite 连接、跨 workerd/D1 invocation、滚动窗口/分钟边界、慢账号、冷却隔离/继承、损坏状态、late SQL、取消、未知写结果不覆盖及无重试；没有读取真实凭据发出上游请求。1000 通道合成测试不是 1000 账号生产压测，不保证源站、代理或平台对大量账号同时访问的承载能力。
- 本轮有意修改旧 425 文件冻结中的 16 个文件，新增调度与专用测试；其余旧冻结文件未变，旧冻结 JSON 和真实报告不覆盖。调度跨连接测试的临时目录在 Windows 仍使用已批准的 opencode 路径，其他系统使用系统 temp fallback，去掉既有测试对 Linux CI 不适用的 `LOCALAPPDATA` 强制要求；未将 Windows 验证宣称为 Linux 运行验收。旧服务数据库只读检查仍为 3 个既有 partial Action、0 活动 permit、0 未来预算、5 个账号；原数据库/AES/账号/域名/DNS/扫描断点未清空或覆盖。代码验证阶段仅更新构建产物，当时未重启旧 Node 进程；随后用户单独授权的本地重启见下文。未打开浏览器运行新 Scanner、提交、推送或部署云端。

**本轮验证结果**：`npm run verify:all` 完整通过，19 组共 **453 项 invariant，fail 0**；含 safety 107、workerd/D1 69、DNSHE 契约 13、服务商列表 25、统一传输 117、既有 scheduler 59、新 DNSHE 通道 19、前端安全 17、Scanner executor 8 等组。架构检查、Worker 类型与构建、Node 类型与六组自检、前端 production 构建和主题检查（108 项，失败 0）通过。随后仅修正两个跨 SQLite 连接测试的临时目录平台兼容，相关 **59 + 19** 项重新构建执行均通过，不重复累加总测试数；没有再修改生产代码。独立 `build:node`、前端 `typecheck` 与顺序执行的 `build:selfhost` 通过，没有与 production 构建并发写产物。tracked 和两个新增 DNSHE 文件空白检查通过。

- 完整绿色日志：`C:\Users\15017\AppData\Local\Temp\opencode\dnshe-independent-verify-all-225d4c86744642bdb1cf4769f54406a0.log`；新 427 文件冻结：同目录 `dnshe-independent-source-freeze-36eef2c6fac4457d83dcf436067bd794.json`，冻结后源码比对无变化。旧 425 文件冻结仍保留，16 项有意变更，其余未变；不是继续要求新源码与旧策略哈希相同。
- 本轮红→绿包括：专用测试最初错误地要求 late CAS 被 owner 清理拒绝后仍新增额度；修正为验证已有历史不能丢失。另修正 1000 lane 测试 Promise 初始化顺序、跨账号旧共享冷却预期和 React hook 测试渲染方式（真实 useRef 不能作为普通函数调用，SSR browser 入口避免 ESM 动态 `require(stream)`）。第一轮 invariant 在旧跨 Key 冷却断言停止，后续一次完整门禁在 SSR 测试构建失败停止；这些失败日志不作为绿色证据，最终上述日志完整跑至主题检查。
- 既有旧预算/双槽的显式 fixture 保留为兼容与统一传输回归，不把它们误称为新生产 DNSHE 调度验收。新通道通过专用 Node/D1 测试、生产 DAO/HTTP 入口及前端执行器/真实 hook 验证；仅有 1000 lane 合成样本，不是官方并发容量测试。
- 原五分钟 715 次及前次 82 次报告再做离线时间序列/哈希核验通过，没有重跑 live；453 项是应用离线测试，不加上 715 次官方请求。该代码验证阶段的原服务活动检查未发现新的任务或预算，当时未重启、继续扫描或部署。
- 参考当前 Workers best practices、D1 prepared statements 和 Workers limits；已检索最新 Workers types `5.20261031.1` 的 D1 接口。构建仍用项目已有依赖，没有擅自升级依赖或修改兼容日期。

### 用户授权的本地重启（2026-11-01）

- 用户要求“重启旧服务”后再次 `npm run build:node` 成功。安全脚本核对旧 PID **6776** 的 Node 路径、命令行、创建时间及 `127.0.0.1:8787` 监听归属，确认没有活动 Action、有效 permit、未来旧预算或新通道租约，才定点停止旧进程；新进程 PID **10752** 于本地时间 `2026-11-01 00:17:33 +08:00` 启动，旧 PID 已不存在。
- 沿用原 `domain-hub-browser-test-20261031-214529/domain-hub.db` 与同目录 `aes.key`，显式使用原数据路径、项目 schema 和最新 `frontend/dist`；清除与原启动配置不符的 AES/管理员 Token/默认账号/webhook 环境覆盖。启动日志确认读取原 AES 文件，仍只监听 `127.0.0.1:8787`，`DISABLE_CRON=1`。
- 仅请求本地 `/healthz` 和 `/`：均 HTTP **200**，健康响应为 `{"ok":true}`，首页返回 HTML；启动日志无错误，仅有原 AES 备份提醒。前后只读 `PRAGMA integrity_check` 均为 `ok`，全部 **12 张表**的逐行内容摘要与 AES 文件 SHA-256 一致：5 个账号、37 条域名缓存、72 条 cache、3 个既有 partial Action 等均未改变。后端 `scanner_jobs` 前后均为 0；没有打开或刷新浏览器，也没有改动浏览器本地扫描断点。
- 重启前后摘要、启动日志和 PID/构建哈希记录保存在 `C:\Users\15017\AppData\Local\Temp\opencode\dnshe-independent-restart-20261101-001731-749-{before.json,after.json,stdout.log,stderr.log,receipt.json}`，摘要仅含行数与哈希，不输出凭据。运行中的 Node bundle 与启动记录哈希一致。首页首次 PowerShell 检查误用只读 `$HOME` 变量而导致检查脚本报错，改名后重新检查通过；这是本地检查脚本错误，不是服务启动失败。旧后台命令的退出通知属于被停止的旧服务，不是新 PID 的启动错误。
- 没有登录触发同步、WHOIS、注册域名、写 DNS、改 Key、恢复扫描或追加真实上游请求；未提交、推送或云端部署。此结果只证明新构建在原本地数据上完成启动与只读健康核验，不是新调度的真实上游或长期承载验收。浏览器需要用户 `Ctrl+F5` 加载新前端，扫描仍由用户手动决定是否继续。
- **随后访问失败与恢复**：用户反馈“无法访问此网站”时，核查发现首次新 PID 10752 已消失、8787 无监听，日志只有正常启动信息，没有足以定位退出原因的记录；此前 200 仅证明检查当时可用，不能证明进程持续存活。改用 harness 管理的后台任务直接运行 Node，而非 `Start-Process` 脱离启动脚本的子进程。当前 PID **34496**（本地时间 `2026-11-01 00:23:36 +08:00`），仍监听 `127.0.0.1:8787`；首页和 `/healthz` 再次返回 200。恢复前后 12 张表内容哈希及原 AES 哈希一致，cron 禁用，没有恢复扫描或发起真实上游请求。只读摘要为 opencode temp 下 `dnshe-independent-managed-20261101-{before,after}.json`，后台任务 ID 为 `sh_192c60b24001aKzv2hwENN0EzO`；此启动依赖后台任务生命周期，不宣称已安装 Windows 自启动服务。

下面的表格与冻结日志是 **10 月 31 日旧双槽批次** 的历史结果，不是新方案的验收结果。

## 2. 验证与证据

| 验证 | 本轮结果 |
|---|---|
| `npm run test:safety` | 107/107；新切片新增真实预算/虚拟时钟/双槽准入的 deep、绑定后、两种 HTTP Action、cron 两种缓存模式，多域 offset/cursor 完整同步；外部预算/真实合成 429→partial/缓存/dirty/无重发，缓存快路径及五账号真实 WHOIS 路由无自拥塞；保留此前 91 项回归 |
| `npm run test:workers` | 66/66；新切片新增 deep、绑定后与 cron 两模式的真实 workerd fetch/D1/预算串行分页回归；保留此前 62 项传输/业务限流/D1/协调期限/鉴权/Action 回归 |
| `npm run test:dnshe-contract` | 13/13；本批新增预约/满额查询/等待后检查超时、batch/确认读挂起与主传输错误优先、坏状态/失败 batch、历史整数 `.0` 兼容；保留分页、异常与共享预算 |
| `npm run test:provider-contract` | 最终源码复验 25/25；五家域名/DNS 契约、分页预算、JSON/XML、写前查询保护和空 TXT 原始下标 |
| `npm run test:provider-request` | 117/117；七家真实客户端读写期限、大小、分片 UTF-8、坏体、非 JSON、HTTP/业务失败、Retry-After；helper 清理/取消/晚到 body、DNSHE 排队与 cooldown、华为只读候选总期限及两家冲突/未知写结果保护 |
| `npm run test:provider-scheduler` | 59/59；本批新增阶段期限/非法配置、claim 前后/晚到拒绝/第二槽与诊断查询、清理失败/过期恢复、释放挂起/原传输错误优先、头/业务冷却挂起及晚到结果、较短传输期限优先；保留原 48 项共享准入与业务限流回归 |
| `npm run test:frontend-safety` | 15/15；新增精确暂停来源分类/合法建议等待与真实 hook 的双槽竞争暂停/最早断点/不发候位任务；保留此前 13 项 Action/Scanner/403 回归 |
| `npm run test:unit:scanner-batch-executor` | 5/5；新增五账号最多两路、停止后不领候位任务、每账号间隔保留；保留原分发/停止回归 |
| `npm run verify:all` | 新切片源码冻结后完整门禁通过；含架构检查、Worker 类型/构建、18 组共 426 项 invariant 测试（fail 0）、Node 类型及六组自检、前端 production 构建与主题检查（对比度 108 项、失败 0） |
| `npm run build:node` | 本批业务源码冻结后通过 |
| `npm --prefix frontend run build:selfhost` | 本批完整门禁结束后通过，未与 production 构建并发写入产物 |
| `npm --prefix frontend run typecheck` | 本批业务源码冻结后通过 |
| `git diff --check` | tracked 修改通过；另对 31 个未跟踪文件执行 `git diff --no-index --check`（CRLF 视作合法行尾），无空白错误。LF/CRLF 提示不代表失败，no-index 返回 1 但无诊断表示文件有差异，不作为空白失败 |
| actionlint 1.7.12 | 三份变更 workflow 通过；未启用外部 shellcheck/pyflakes，仅语法/依赖校验，未远端执行 workflow |

Workers 测试使用实际 `wrangler.toml` 的 `2024-04-01` 兼容日期。D1/鉴权测试默认禁止 outbound；新传输测试通过本地 outboundService 接管七家真实客户端的 fetch，严格验证目标 host，任何意外目标均失败，不访问真实服务商。覆盖真实 Workers crypto、响应头期限、慢体、UTF-8、大小上限、200 业务错误、401/403/429 元信息及无写重试。直接固定测试依赖 `miniflare@5.20260826.0-alpha`，使用 `workerd@1.20260826.1` 执行测试；未借测试注入新的生产兼容标志。

测试中的 synthetic fault/trigger 报错是故障注入证据，不是测试失败；以退出码与断言结果为准。GitHub workflow 尚未远端执行，actionlint 与本地构建不能证明发布脚本的云端探测或部署成功。

历史完整绿色日志：`C:\Users\15017\AppData\Local\Temp\opencode\provider-verify-all.log`（16 组 133 项 invariant）与 `transport-verify-all-final.log`（17 组 265 项），后者是上一批传输层源码的验证，不代表本批调度源码已验证。

**最新切片最终完整绿色日志**：`C:\Users\15017\AppData\Local\Temp\opencode\browser-budget-verify-all-final.log`，完成至主题检查，18 组共 426 项 invariant 全部通过。`browser-budget-source-freeze.json` 的 425 个源码/配置/测试文件 SHA-256 在完整门禁后比对无变化，冻结后仅更新本文。Node 独立构建与前端 typecheck 日志为 `browser-budget-node-build-final.log` / `browser-budget-frontend-typecheck-final.log`；三份 workflow actionlint、tracked 与 31 个 untracked 文件空白检查均通过。

浏览器新问题的红→绿证据：`dnshe-serial-red.log` 在旧两路同步下六个成功场景复现本地预算拒绝；`scanner-slots-red.log` 在旧五账号流水线下复现同时五路。修复后定向 `browser-budget-safety.log` 107/107、`dnshe-serial-workers.log` 66/66、`scanner-slots-frontend.log` 15/15、`scanner-slots-executor.log` 5/5，最终完整门禁重新构建全部冻结源码。早期失败还包括 cron 返回 summary 而非抛错及缓存模式的 fixture 预期问题，均修正；红日志不作为绿色证据。DNSHE 使用真实预算和异步推进虚拟时钟，不 mock `listSubdomains/listDnsRecords`；只注入客户端构造与配额刷新入口的测试时钟，不声称已对真实账号复测或完整绑定 HTTP 流程作新的线上验收。

上一协调期限批次绿色日志：`coordination-verify-all-final.log`（18 组 401 项）、`coordination-source-freeze.json`（423 文件），以及 `coordination-node-build-final.log`、`coordination-frontend-typecheck-final.log`；这是新浏览器切片之前的验证证据。

最新独立 selfhost 构建也通过（`browser-budget-selfhost-final.log`），在完整门禁结束后执行，未与 production 构建并发写产物；本切片未运行部署或主动重放用户真实请求。历史 `coordination-selfhost-final.log` 属于上一批。

本地浏览器服务使用独立目录 `C:\Users\15017\AppData\Local\Temp\opencode\domain-hub-browser-test-20261031-214529`，现已有用户绑定的 5 个真实账号，不是可清空 fixture。只读检查最初无活动任务，但首次重启前再次检查发现 2 个有效请求占位和 5 条未来预算；安全脚本在停止旧进程之前拒绝重启。用户随后确认暂停所有扫描并授权重启，再次只读检查请求占位/未来预算均为 0，才定点停止旧测试进程并启动新构建。**新 Node 服务已加载本切片**，仍只监听 `127.0.0.1:8787`、cron 关闭；首页/healthz 均 HTTP 200，5 个账号/3 个既有 partial Action 保留，启动日志确认使用原 AES 文件。数据库/AES key/账号均未清空或覆盖，没有因重启脚本发起真实同步；旧进程完成通知中的大量报错为其历史输出，不是新版启动错误。浏览器需 Ctrl+F5 加载新前端，然后用户手动继续；未自动刷新标签页、扫描、同步或复测真实上游。

本批首次 DNSHE 定向回归发现旧 SQLite REAL→TEXT 的整数 `.0` 格式兼容问题，修复并加入历史状态回归后 `coordination-dnshe-recheck.log` 13/13；`coordination-dnshe-first.log` 不作为绿色证据。Workers 初测的释放主错误 fixture 在本地 outboundService 抛错后被转成 HTTP 响应，不是真实传输失败；改用确定的坏 UTF-8 读取失败验证主错误优先，`coordination-workers-first.log` 不作为绿色证据。最终完整门禁重新构建并验证全部冻结源码。所有业务响应均为离线 fixture，不证明真实服务商配额、跨操作系统进程压测、远端 D1 超时取消或中断任务自动恢复已完成。

上一批业务限流的完整绿色日志为 `business-limit-verify-all-final-recheck.log`（18 组 366 项），冻结为 `business-limit-source-freeze.json`（421 文件）；此前同批 `business-limit-verify-all-final.log` 后曾收紧阿里云 XML 根节点，不能替代最终复验。其冻结前定向绿色为 `business-limit-safety-recheck.log`（83/83）、`business-limit-scheduler-recheck.log`（48/48）、`business-limit-workers-recheck.log`（52/52）。安全初测因旧精确对象断言未包含新增 `SyncIssue.panelStatus` 失败，修正后通过，`business-limit-safety-first.log` 不作为绿色证据。

上一批调度完整绿色日志为 `scheduler-verify-all-final.log`（18 组 313 项），对应 `scheduler-source-freeze.json` 的 420 个文件；不是本批业务限流源码的验证证据。

上一批定向绿色证据还有 `scheduler-safety-final.log`（77/77）与 `scheduler-workers-recheck.log`（26/26）。定向测试曾因旧 WHOIS 429/409 fixture 未清除共享冷却、凭据格式/方法名断言及 D1 exec 对多行 trigger 的处理而失败，均修正测试后复验；慢 claim、独立 SQLite 连接/关闭重开、协调故障及 batch 元信息在冻结前补齐。SQLite 证据为同进程的独立连接及关闭后重开，workerd 为跨请求 D1；不是跨操作系统进程压测、真实远端 D1 故障验收或整项 Action 持久化恢复证明。失败的 `scheduler-workers-final.log` 与历史传输层 `transport-verify-all.log` 不作为绿色证据。

测试隔离事件：`server/create-domain.test.ts` 仍 mock 已重命名的私有 `requestXml`，导致一次测试请求进入真实阿里云 AddDomain 接口，使用虚假凭据 `LTAItest` / `aliyunsecret`、参数 `corp.myaliyun.com`，返回 HTTP 404 `InvalidAccessKeyId.NotFound`，未成功创建资源。现已改为 `requestRpc` fixture，并在 Node 服务商/数据库/集成/契约测试入口加载 `tests/helpers/block-outbound.ts`；未安装 mock 的 fetch 本地报错，fixture 恢复后仍为禁网默认。添加域名测试显式断言漏 mock 会被阻止。这是测试级 fetch 防护，不是操作系统网络沙箱；真实实测脚本不使用此入口。

## 3. 兼容与升级注意事项

- 保留 Worker/Node 双运行时、现有业务表与公开路由。协调状态存于既有 settings/cache，Action 跟踪使用既有 actions 表；不要求本轮清库或修改数据库主键。
- 新安装会写入 `auth_initialized` claim；旧安装只要 hash/salt 完整仍可登录。部分凭据或坏 2FA 将返回 503，**不要通过删密码行或 claim 重新开放 setup**，应先备份并由管理员修复数据或恢复密钥。
- 保持原 `AES_KEY` 不变。本轮没有完成异密钥迁移，换密钥仍可能导致旧账号与 2FA 无法解密。
- `cf_zone_cursor:<accountId>` 改为 version 2；旧游标会安全重启，既有业务缓存保留到完整周期结束。同一 Token 在上游原地改变权限不能仅靠本地凭据 hash 检测，后续仍需评估上游 scope 变化契约。
- Cloudflare 手动同步每轮仍分片；未完成时 Action 为 partial，携带继续页提示，而不是新的自动持久化任务。完整 seen/candidate 快照随账号规模增长，尚未做大规模存储/CPU 基准。
- DNSHE `upstream_*` 错误可能返回 409/429/502，Retry-After 可随响应输出；接入方不能把这些状态当作面板会话失效。
- 10 月 31 日串行同步/双路 Scanner 仅解决旧模型的任务自拥塞；11 月 1 日改为上述独立凭据通道，登录账号多 Key 归并仍未解决。多域分页和排队仍可能超出 Workers `waitUntil` 的运行窗口；不增大本地预算或连点继续绕过保护，持久化续跑仍待实现。
- 七家现在可能在未发送上游请求时返回共享准入 429。一个账号的上游 HTTP 429 或本批已确认业务限流会保守冷却该部署此服务商的所有账号（包括新凭据校验），不要换 Key/重复绑定绕过。冷却结束只允许再次准入，不自动恢复中断任务，也不保证上游限流已解除。
- 共享协调以数据库为边界；多个 Worker/Node 实例必须使用同一数据库才共享，独立数据库、其他程序、上游控制台及其他部署的调用不在本地预算中。不要为“清缓存”主动清除尚有效的 scheduler 状态；现有过期清理保留未到期 permit/cooldown。
- DNSHE 非 JSON/截断 JSON 的原错误码由 `invalid_response` 细分为 `non_json_response`；结构异常/坏 UTF-8 仍可能为 `invalid_response`。七家网络与超时分别使用 `transport_error` / `request_timeout`，接入方不应依赖旧网络异常文本分类。
- 七家请求超时/网络/坏响应均不能证明上游写入未发生，应强制刷新或到上游控制台核对后再操作，不应盲目重发。helper 支持 caller signal，但 Action 的取消尚未接入请求中止；本批仍不保证后台工作停止，也未实现未知写结果的自动对账/补偿。
- 默认 4 MiB 安全上限可能拒绝合法的异常大响应；会抛错而不是采用片段。超时仅约束单次传输，不能保证多页同步、限频排队或整个 Action 在 20 秒内结束，JS 同步解析/CPU 也不是可抢占任务。
- 直接消费 `HuaweiApiError.code` 的接入方应改用 `error_code` 获取原华为云码；`code` 现在与面板统一错误码保持一致。
- 五家列表的完整性校验属于结构/分页/计数一致性保护，不是上游事务快照保证；上游同步期间发生相同总数的增删或权限变化仍不能全部识别。缺字段、总数变化或重复条目时应修复上游响应/权限后手动刷新，不应清空本地缓存绕过保护。
- Vercel 官方 DNS schema 还存在不带 pagination 的旧变体；本批保守拒绝，不能证明它是完整快照。DigitalPlat 仅接受已观察的无分页 `data[]` 及缺失/null/空对象 meta，非空 meta（包括可能只是信息性的 request_id）也拒绝，待生产 Developer API 契约确认后再扩展。
- 五家账号同步继续只同步域名清单，不新增逐域 DNS 深度同步；DNS 回归覆盖 DNS 面板强制读取及写后状态回读。scheduled 模式仍按既有逻辑跳过这五家，手动全量同步才访问它们。不得把账号 Action completed 理解为所有 DNS 已刷新。
- DNS 写成功后的回读受共享预算约束，可能保留 dirty 等待稍后刷新；不应因此自动重复 DNS 写操作。本轮还没有实现“上游成功、本地失败”的通用补偿模型。
- 前后端应配套升级：同步响应新增 `actionId`/`syncWarning`，Action 新增 partial。新前端连接旧后端缺少任务 ID 时只提示无法确认完成，不再猜测成功；旧接入方需要处理新的状态。
- `queueSyncAction()` 是尽力执行的 `waitUntil` 跟踪，不是可靠队列，没有持久化恢复或自动重试。Workers 请求响应后的 `waitUntil` 执行受运行时限制，前端等待 60 秒不代表后台享有 60 秒执行时间；任务中断或数据库结算失败仍可能留在 running。
- 取消只将 Action 标记为不可覆盖的 cancelled，不中止已发出的上游请求，也不保证停止后续业务执行；精确进度与协作式取消尚未实现。同步 completed 为 100，partial/failed 不提供精确百分比。
- 同步结果中的 `SyncIssue` 保留 phase、message、domainId、上游 status/error_code/`retryAfterMs`，本批新增面板 `panelStatus` 和明确业务限流的 `rateLimited`，尚未携带上游 details；通知送达或每个 UI 刷新成功不属于同步完成保证。
- 账号保存后的同步启动错误已单独隔离，但审计写入、配额别名刷新或其他保存后辅助操作失败仍可能使响应报错；不要将本批修复理解为通用后置失败补偿已经完成。
- 回退到旧版本会重新引入鉴权和分页缺陷；不得假定旧代码能正确消费 version 2 快照。回退前需备份数据库、停止同步任务并制定协调状态兼容方案，不清除用户凭据或业务表。

## 4. 阶段状态与剩余范围

| 原方案阶段 | 状态与剩余工作 |
|---|---|
| A：止损 | 四条核心不变量已接入；DNSHE/CF 及本批五家域名/DNS 列表防护已覆盖主要读取路径，保留兼容限制 |
| B：契约与调度 | 七家传输/已确认限流码/共享预算与冷却、分片持久续跑、文件SQLite重开、全局跨页池和深历史索引离线完成；DNSHE共享30/min已确认，跨Key主体映射/预算未实现。DP/Huawei等调查及真实云端验收暂缓，不整体关闭F06 |
| C：任务与迁移 | 分片同步持久任务/取消/fencing、partial与操作中心、跨Key迁移/ID映射/预览确认/原子审计完成；DNS批次首失败停止且not_sent，非分片取消409。通用后台取消/后置失败补偿未承诺，不自动反向写 |
| D：发布安全 | 手动精确SHA/production审批/verify+security、显式已有D1、部署前原AES元信息、无自动建库/Secret轮换/域名探测改策略和发布回退手册完成；依赖授权升级后双树0漏洞、Node22/24完整复验通过，本地workerd合成staging通过，实际云端staging/容量/部署暂缓，服务未切换 |
| E：架构与体验 | 操作中心/增量日志/生命周期、跨页调度和迁移UI/单飞/秘密清理完成；其余产品架构需求未实施，不宣称真实页面性能、通知可靠送达或所有后台停止保证 |
| F：新增产品功能 | DNSHE 密钥管理与永久升级中心尚未实施，需另行确认需求与安全流程 |

特别注意：

1. 本批已补齐五家域名/DNS 列表及适配器的缺失列表当空路径，但不宣称 DigitalPlat 分页或 Vercel 无 pagination 旧外壳已兼容，也不宣称所有 API 详情/写响应已完成严格契约校验。
2. `deepSyncAccountDomains()` 已在域名落库后通过 `IncompleteSyncError` 报告 DNS 部分失败；非持久化 runner 中断、通用上游/本地成功后辅助操作失败等边界仍待补齐。
3. Scanner 仍以 completed 配警告展示部分查询失败，尚未新增 partial 状态。
4. 发布旧自动D1/Secret/域名探测逻辑已移除；元信息失败停止、Key不轮换。生产环境审批规则须管理员设置，不能认为YAML已自动建规则。本轮未运行云端部署。
5. 获授权升级后两树审计0漏洞、双版本完整复验通过；未来security仍失败关闭，不绕过审计或使用`npm audit fix --force`。工作区依赖目录和原服务未更新，离线通过不授权发布。
6. 原 `audit-tools/reproduce.ts` 断言基线缺陷，不是修复后的绿色回归；`audit-tools/live-dnshe.mjs` 会创建真实资源，不能作为离线测试入口。

依赖修复与双版本重验已完成；DNSHE额度/普通免费窗口已接受用户确认，跨Key身份映射与共享预算尚未落实。其他服务商调查和实际云端staging/容量/部署按要求暂缓，真实续期/服务切换需新授权；不再把已完成持久分片/迁移/发布代码列为待实现，也不以审计通过批准上线。通用补偿与新增产品仍需明确安全需求，不扩大范围。

**F06对账（2026-11-03）**：扫描/同步/DNS/配额共享持久Key预算、已确认429冷却/服务端时间、有界队列期限、单页await持久断点、文件SQLite重开同任务和未知写不盲重发已离线覆盖；同步不依赖响应后长waitUntil。同账号多Key共享30/min已确认但主体映射/合计预算未实现，真实Worker中断/后台节流和容量未验且云端暂缓，Scanner/其他动作没有通用持久取消，所以不宣称F06全部关闭。下列10月31日探测均为历史证据，不能用当时“账号/Key不可区分”覆盖本轮用户确认。

限频依据与未确认项（2026-10-31 检索）：[Cloudflare API Limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/) 的用户级累计预算跨 Dashboard/API Key/Token，不能按 Token 假定独立；[阿里云 DNS 流控](https://help.aliyun.com/zh/dns/api-alidns-2015-01-09-quota) 按 `regionId,API,ParentUid` 且不同 API 配额不同；DNSPod [域名列表](https://www.tencentcloud.com/document/product/1157/53854) 为 20/s、[记录列表](https://www.tencentcloud.com/document/product/1157/51290) 为 100/s，不足以证明 Key 独立；[Vercel Limits](https://vercel.com/docs/limits) 按用户、owner 或资源限制。DNSHE 30/min 是本地资料/先前实测依据，保留 per-key 2.1 秒仅为既有本地防护，不是已确认的独立 Key 配额模型，更不套用于七家。华为云当前 DNS API 精确限频及 DigitalPlat 生产 Developer API 限频仍缺可靠依据，未引用通用 API Gateway/公开 Domain-OSS 配额代替生产契约。本批识别范围仅为上述五家共 12 个确认码，不宣称覆盖七家所有业务限流外壳。

**后续独立真实只读限流对照（2026-10-31 22:24–22:29，用户新授权）**：用户确认 5 个绑定项为 5 个独立登录账号、暂停所有相关请求，允许读取测试库两个现有 DNSHE 凭据并进行最多 80 次 WHOIS 探测。直接官方鉴权 WHOIS 实际 72 次（预检 4、两账号交替 37、单账号 31），71 成功、1 次官方 429；两账号同一分钟合计 37 次全成功（A 19、B 18），单账号同一分钟前 30 次成功、第 31 次 `rate_limit_exceeded`，`details.limit=30/remaining=0/reset_at=2026-10-31 22:29:59`，随即停止且没有换 Key/IP 续撞。两账号原目标 40 因网络延迟触达约 54 秒有界窗口，在 37 次截止；未跨分钟补数。六次同代理 IP 回显指纹一致，但这不是 DNSHE 观察来源 IP 的直接证明。结果更支持鉴权凭据侧 30/min、不符合简单 IP 合计 30/min 模型；每账号仅一把 Key，仍不能区分账号与 Key，也不排除复合限流或推广到其他接口。公开未启用 Key 的 WHOIS 文档明确按 IP 30/min，通用章节另写 60/min，分别保留边界。详见父目录 `DNSHE-官方限流只读探测报告.md`、脱敏时间序列 `DNSHE-官方限流只读探测.json` 与 `audit-tools/probe-dnshe-rate-limit.mjs`。离线安全/结果核验通过；测试库只读、原 AES/账号/域名/DNS/面板预算未改，无自动恢复扫描或真实重试。本独立真实阶段不计入上述 426 项离线回归或原 85 次功能实测，不据此放宽 per-key 或部署级保护。

**五账号并发 520 对照（2026-10-31 22:42，用户随后新要求）**：直接官方带 Key WHOIS，5 个现有独立账号每轮同时各发一路，5 轮共 25 次（各账号 5 次），全部 HTTP 200/success=true，无 520/其他 5xx/429，客户端在途峰值 5。先静默 75 秒，轮次及各账号间隔至少 5 秒，实际请求阶段约 21.3 秒；代理池允许 5 条连接，每轮发起差小于 100 ms，前后 IP 回显一致。设计遇官方 520/5xx/429 或异常停止后续轮次、不重试，在途仍可能返回；离线合成停止逻辑及真实时间序列核验通过。数据库只读、面板业务源码/双槽/per-key 预算/共享冷却未改。低总量样本未复现 520不代表持续五账号扫描、每账号 30/min、其他接口或源站内部并发已经验收；未测试写操作、不自动恢复扫描。详见父目录 `DNSHE-五账号并发只读探测报告.md`、`DNSHE-五账号并发只读探测.json` 与 `audit-tools/probe-dnshe-five-accounts.mjs`；本轮 25 次与前次 72 次独立记录，均不计入 426 项离线回归。

**五账号持续扫描对照（2026-10-31 23:02–23:05，用户明确选择 3 分钟、最多 350 次并确认全部暂停）**：直接官方 WHOIS，各账号一路/至少 2.6 秒起始间隔，对不同内部 `us.ci` 候选持续只读查重，实际 345 次（A–E 各 69 次），全部 HTTP 200/success=true/registered=false，无 520/其他 5xx/429/网络错误。每账号约 23/min、总计约 115/min；客户端峰值 5。到 3 分钟停止派发，最后在途于约 181.47 秒结算，截止后零新请求、最终在途 0；平均/P95/最大耗时约 1119/2149/4612 ms。先静默 75 秒，前后代理回显一致，本地请求活动监测无干扰；数据库只读、原 AES/账号/域名/DNS/生产预算未改、不注册候选、不写面板查重池、不自动继续扫描。脚本出现一次截止附近的本地负剩余 timer 警告（Node 归一为 1 ms），不是官方失败；实际各账号间隔核验仍至少 2.6 秒，现仅修正诊断脚本的 timer 正值检查并离线复核，未重复真实测试。详见父目录 `DNSHE-五账号持续扫描只读探测报告.md`、`DNSHE-五账号持续扫描只读探测.json` 及 `audit-tools/probe-dnshe-five-accounts.mjs` 的 sustained 模式。结果不保证更长/更高频率/其他接口不出 520，不是面板当前双槽 Scanner 路由的验收、不放宽保护，账号/Key 作用域仍待确认。本轮 345 次与前两轮 25/72 次分开记录，不计入上述 426 项离线回归。

**五账号频率边界对照（2026-10-31 23:16，用户明确选择每账号最多 31 次/总 155 次的分钟边界测试）**：各账号一路、最短 1.3 秒间隔，直接官方 WHOIS 查询不同内部候选，先静默 75 秒并按前次官方 Date 样本近似对齐分钟，最多派发 54 秒。本轮实际 141 次、140 HTTP 200/1 官方 429，无 520/其他 5xx/网络错误；A 发 31 次，前 30 次成功/第 31 次 `rate_limit_exceeded`，`details.limit=30/remaining=0/reset_at=2026-10-31 23:16:59`；B/C/D/E 分别 29/26/25/30 次均成功。在 23:16:43.328 首次 429 响应头出现即停止所有新请求，在途至 23:16:43.741 全部结算，阶段约 40.82 秒、峰值 5，全部官方 Date 为同一分钟。没有强迫其他账号继续撞 31、换 Key/IP 续撞或自动重试，未执行十路并发；141 包含失败请求。时间序列/155 与账号 31 上限/至少 1.3 秒间隔/不同候选/停止后零新请求/最终在途 0 核验及合成安全测试通过。数据库只读、生产保护未改；前后代理回显一致仍不等于官方看到的 IP 已直接证实，账号与 Key 作用域仍不可区分，也不推断更高 IP/WAF 上限。详见父目录 `DNSHE-五账号频率边界只读探测报告.md`、`DNSHE-五账号频率边界只读探测.json` 及 `audit-tools/probe-dnshe-five-accounts.mjs` 的 boundary-five 模式。本轮 141 次与此前 72/25/345 次独立记录，不计入 426 项离线回归，不放宽双槽、per-key 间隔或共享冷却。

**五账号五分钟、每账号 30/min 对照（2026-10-31 23:29，用户确认不是合计 30/min）**：新增独立只读模式，各账号一路/最短 2 秒/闭合滚动 60 秒最多 30 次，各最多 150 次、合计最多 750 次，失败包含在内；诊断独立运行上限 465 秒覆盖 75 秒静默、300 秒派发和有界结算，不改生产协调期限。此次实际仅 82 次（A–E 9/17/18/19/19），81 HTTP 200/success=true/registered=false，另 A 第 9 次于 23:29:33.821 发出、20.015 秒后未取得状态码进入统一异常捕获；23:29:53.836 停全部新请求，在途至 23:29:54.617 结算，阶段约 38.205 秒、最终在途 0。收到响应无 520/其他 5xx/429，但未知请求不能算成功或排除上游异常；原脚本未保存异常类型，耗时疑似命中 20 秒超时，不能严格定位代理/链路/源站/本地守卫。**未跑满五分钟，持续稳定性目标尚未验证，不重试或补跑。** 实际滚动 60 秒峰值各 9/17/18/19/19、最小起始间隔均至少 2 秒、无账号内重叠；候选全异、停止后零新请求、虚拟时钟五分钟/750/150/滚动限额/慢响应/异常停止安全测试及历史结果离线复核通过，不把规则核验当作 live 稳定性通过。成功请求平均/P95/最大约 1231/2512/4850 ms，失败 20015 ms 另计；峰值 5，前后代理回显一致不证明故障期间链路或官方所见 IP。数据库只读、原 AES/账号/域名/DNS/扫描断点/partial Action/生产保护未改、不注册、不写查重池、不恢复扫描；425 文件冻结未变。详见父目录 `DNSHE-五账号五分钟只读探测报告.md`、`DNSHE-五账号五分钟只读探测.json` 和 `audit-tools/probe-dnshe-five-accounts.mjs` 的 five-minute 模式。本轮 82 次与历史 72/25/345/141 次独立记录、不计入 426 项应用离线回归；账号与 Key 配额作用域仍不可区分。

分页契约参考：[DNSPod 记录列表](https://www.tencentcloud.com/document/product/1157/51290)、[阿里云域名列表](https://www.alibabacloud.com/help/en/dns/api-alidns-2015-01-09-describedomains)、[阿里云 DNS 列表](https://www.alibabacloud.com/help/en/dns/api-alidns-2015-01-09-describedomainrecords)、[华为云公网域名列表](https://support.huaweicloud.com/intl/en-us/api-dns/dns_api_62003.html)、[华为云 Recordsets](https://support.huaweicloud.com/api-dns/ListRecordSetsByZone.html)、[Vercel 域名](https://vercel.com/docs/rest-api/domains/list-all-the-domains)、[Vercel DNS](https://vercel.com/docs/rest-api/dns/list-existing-dns-records)。DigitalPlat 的公开 Domain-OSS 文档不能证明等同生产 `domain-api.digitalplat.org/api/v1`。

**五账号五分钟重测（2026-10-31 23:35–23:40，用户在上轮失败后明确新要求“重试”）**：同五个账号、同代理，每账号一路/最短 2 秒/闭合滚动 60 秒最多 30 次，各最多 150 次/合计最多 750 次、失败含在内，先静默 75 秒；没有提高并发、频率或 20 秒超时。此次完整运行 300 秒派发窗口，实际 715 次（A–E 142/145/143/143/142）全部 HTTP 200/success=true/registered=false，无 520/其他 5xx/429/超时/未知结果。各账号滚动 60 秒峰值均 30，最小间隔均至少 2 秒、无账号内重叠；候选哈希全异、截止后零新请求，最后在途于 23:40:02.891 结算，阶段 300.732 秒、最终在途 0。平均/P95/P99/最大响应约 1235/2633/3476/4366 ms；慢响应使实际合计约 143/min，不补数或延长，不宣称 750 次满额。新增独立 retry 模式及白名单异常类型/底层错误码/阶段记录，不存原始消息或凭据；离线限额/停止/脱敏/来源检查、真实时间序列和上轮 82 次结果哈希未变核验通过。此次为一次新授权从头重测，不是上轮失败请求自动重试，旧结果和报告保留；本次成功不能定位或否定上次未知失败。数据库只读、原 AES/账号/域名/DNS/扫描断点/partial Action/生产保护未改、不注册、不写查重池、不重启或恢复扫描；前后活动检查与代理回显一致仍不直接证明源站所见 IP/内部并发，425 文件冻结不变。详见父目录 `DNSHE-五账号五分钟重试只读探测报告.md`、`DNSHE-五账号五分钟重试只读探测.json` 和 `audit-tools/probe-dnshe-five-accounts.mjs` 的 five-minute-retry 模式。本轮 715 次与历史 82/72/25/345/141 次独立记录，不计入 426 项应用离线回归；不保证长期或其他接口正常、不放宽双槽/per-key/共享冷却，账号与 Key 配额作用域仍不可区分。

运行时边界参考：[Cloudflare Workers Best Practices — waitUntil 与 Queues/Workflows](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。

## 5. 相关历史产物

父目录的 `domain-hub-代码审阅与优化方案.md` 保留原始 commit 的缺陷、行号和审阅时状态，不把历史结论重写为“已全部修复”。`DNSHE-本次真实API实测报告.md` 记录独立实测证据和残留资源：域名 `dhauditmvw6efey9dec48dns.us.ci`（ID `4739823932`）清空 DNS 后删除仍返回 403，需要后台/管理员处理，不阻碍本轮离线优化。

## 6. Cron / 静默同步：P1 基础（2026-11-01，阶段历史快照）

按父目录 `domain-hub-Cron与静默同步修改方案.md` 开始实施，**仅 P1 基础已完成并离线验证，P2–P6 待实施，新自动行为未启用**。

- 新增 invocation-local 外部/D1 独立预算、reservation 收尾保护及 D1 包装；实际执行计数，prepare/bind 不计，batch 算一次，保留原连接身份用于 schema 就绪缓存。七家传输、通知、DoH、RDAP、Stackryze 显式接入预算，不替换全局 fetch。
- HTTP 计数早于 schema/鉴权；Worker scheduled 与 Node 定时器共用 `runScheduledInvocation()`，**仍运行原 Cron 业务且仅观察计数，不强制截断旧长任务**。严格默认各 40 的基础类可用于新切片，但生产严格限制需待入口迁移后启用；观察模式自动重定向计数不精确，不等于平台硬限验收或新增监控面板。
- 增量新增 `account_sync_versions`、`sync_tasks`、`sync_fragments`、`sync_items` 及索引/凭据 trigger，schema.sql 与 ensureTables 对齐。原账号字段不变，别名/同值更新不使任务失效；凭据/服务商变更使旧任务作废。
- 新任务 DAO 实现数据库时间租约、generation/revision/version/phase/owner 条件提交、片段/seen/候选与游标原子保存、取消、退避及有界终态清理。当前仅保存任务数据，尚无业务 DNS 快照发布、域名同步或差集删除，不将 DAO 的 completed 当作生产完整同步已经实现。
- 新增 Node 35 项与 workerd/D1 6 项禁网测试，覆盖原连接 schema 缓存、跨连接/晚到 SQL 与批次、回滚、坏状态、凭据作废、预算及未知发送结果。失败/取消/晚到调用不退款；发送后的调度 release/block 预算错误标记未知结果，不能当作从未发送，也不自动重试写入。

**最新离线门禁**：独立副本 `npm run verify:all` 通过 20 组、494 项测试（零失败；此前 453 项 + 本轮 41 项）、Worker/Node 类型检查、Worker/前端构建、Node 六组原自检、主题 108 项；另在副本完成 Node bundle 构建。日志：`C:\Users\15017\AppData\Local\Temp\opencode\cron-sync-p1-verify-20261101-172113\verify-all-final-v2.log`，Node 构建日志为同目录 `build-node-p1.log`。461 个非文档源码/配置文件与验证副本哈希一致；本轮前 430 文件基线未覆盖、未删基线文件，依赖与 lockfile 未改。原运行 bundle 哈希仍为 `D511B52CF0054730078C40BB47A3E83AF0BF007F35C65F86C662C447871EAAA3`。

没有调用真实 API、试跑续期/同步、改真实数据库/AES、覆盖原 frontend/dist 或 dist-node/server.mjs、重启服务、恢复 Scanner、提交、推送或部署；本地 `DISABLE_CRON=1` 未改。当前 fixture 的 DNSHE 权威时间无争用路径在发送前已有 8 次 D1、release 再需 1 次，原“约 8 次”不能作为后续含意图/任务的总成本。41 项仅验证离线逻辑，不证明免费版 CPU、连接或生产容量适配。

下一阶段 P2 实现有界本地提醒与渠道去重、DNSHE 续期意图/租约和条件更新、未知写只读核验；不先切换 Cron，不拿提醒天数推断允许续期窗口。随后 P3–P4 单页引擎与手动入口迁移，P5 页面静默推进，P6 生产入口切换；真实 API、续期及上线仍需独立授权。
