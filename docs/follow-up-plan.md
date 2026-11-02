# 后续任务计划与恢复说明

更新日期：2026-11-03（北京时间）。完成情况与历史证据见 [任务进度](optimization-progress.md)；同步、Cron 与限频规则见 [分片同步说明](cron-sliced-sync.md)。本文件本身不授权启动服务、真实请求、部署或写操作；本轮仅获授权升级依赖并完整复验。

## 最新：授权依赖升级完成，其他服务商与云端暂缓

- [升级验收与新收据](dependency-upgrade-acceptance.md)：根/frontend审计均0漏洞，Node24.15.0及22.23.4各完整13道门禁、20组661项零失败、13浏览器、108主题与12隔离HTTP冒烟通过；Node22首次types参数传递失败及整轮最终绿色日志独立保留。
- 清单/lockfile和部署工作流Wrangler4.156.2 pin已回填；Hono4.13.16/adapter2.1.6、配套Miniflare5 beta/types、Vite6.4.5/PostCSS8.5.32/selector6.1.5通过。保留React18/Tailwind3、Node engines和全部预算，不强制audit fix/降级门禁。安装仅新副本，工作区依赖目录及原运行产物不变。
- 用户确认DNSHE **30/min、同账号多Key共享、到期前180天免费**。事实已接受，不再调查30/60或普通免费窗口；代码仍按Key，需要可靠账号主体/映射才能实现合计预算，不按别名合并，不自动设置180或执行续期。
- **DigitalPlat、HuaweiCloud及其他服务商契约调查、云端staging/容量/部署按用户要求暂缓**，不是本轮待执行任务。已有保守读取/未知失败保护不放宽；新产品及真实续期/删除/清历史/服务切换仍需新授权。
- 新独立副本`dependency-upgrade-verify-20261102-TY29X5`，`node24-snapshot`与`node22-final-snapshot`、新`acceptance-receipt.json`/源码文档哈希保留，旧661/618及文档收口证据不改。23:58:53原PID22636/health/首页与5静态资源200、原哈希匹配；未打开原库/AES、重启、真实请求、提交/推送/部署，不覆盖密码恢复/用户活动。

## 前批：后续优化整批交付（2026-11-02 23:20）

- [整批验收与收据](follow-up-all-acceptance.md)：全局≤25跨页流池、密集DNS边界与深历史增量索引、异Key业务迁移预览/确认/ID映射、辅助止损和手动审批发布已完成离线实施。
- 最终完整 **20组、661项零失败**，另13项Chromium/React合成验证；Worker/Node/前端类型构建、规模helper类型和主题108项检查通过。首次完整门禁的4项旧Node备份自检失败已修正有效fixture/契约，并保留失败日志，不放宽归属/凭据/大小校验。
- 独立副本`follow-up-all-verify-20261102`，门禁时504文件，最终491非Markdown文件冻结；`acceptance-receipt.json`及`final-full-*`、最终浏览器`sync-lifecycle-browser-SOYBrI/receipt.json`保留。新Node bundle `E5F7F3A2885E1E40BDDC5927ACAE7C428B8BBD6FD1B2B60E4B7A60BFAE7257D1`未启用。
- **23:20:45原PID22636/healthz/首页与5个静态资源200**，仍原bundle/原目录，未读写原库/AES、重启、真实请求、安装升级、提交推送或部署。原用户活动/密码恢复保持；不声称数据库期间全表不变。
- **上线仍受阻**：根/frontend依赖审计高危未修复；DNSHE多Key/30与60矛盾、180天续期示例/费用矛盾、DP分页/Huawei限频、实际云端CPU/rows与后台/崩溃/旧真实任务验收仍未解决。见[发布回退](release-and-migration.md)、[依赖政策](dependency-remediation.md)、[契约证据](provider-contract-evidence.md)。不凭离线通过自动部署或清理。

下文均为历史批次，不用其中“下一步/最新门禁/停机”覆盖本节当前状态。

## 前批：P2 历史维护与跨轮补充完成（22:40）

- 详见 [历史维护说明](sync-history-maintenance.md)。完成默认只预览、明确确认才执行的管理员接口，最低保留30天，每表每片最多100行，事务内复核并记录原子审计；保护按创建时间最新的任务、最近实际成功、继承新鲜度和所有可续跑/blocked或损坏cursor/owner断点，不接自动入口，不触碰真实历史。
- 新增10项Node维护、2项workerd、2项前端跨轮回归；完整 **20组、618项零失败**，另7项浏览器通过。559/1115片fixture分别跨2/3轮同taskId续跑、每轮≤500；未修改前端逻辑，跨计划页公平性仍待改进。Worker/Node/前端类型与构建、主题108项通过。
- 新独立证据 `follow-up-p2-maintenance-verify-20261102`（opencode Temp）：499文件冻结、618项收据及红/绿/完整日志；上一P2证据不覆盖。最新维护Node bundle `55C3617BDD067326FDAA8645D674A4858E305A7C7F1AED79A905EB533538E3F7`未启用；22:40:00原PID22636健康/原静态资源200，仍用原冻结构建/当前数据库与AES。
- 下一步：有界跨计划页公平调度、密集DNS payload、历史很深时扫描/CPU成本和远端rows/额度。维护入口只是代码完成；真实清理须独立授权和最新成对备份，不自动部署、重启或清旧历史，不放宽40/500/两分钟/30每60秒限制。

## 前批优化：P2 第一轮离线规模评估完成（22:20）

- 详见 [规模与成本评估](sync-scale-assessment.md)：增加 `npm run bench:sync`；修复域名join的整数主键查询和计划历史任务重复查找，不改schema/预算/游标/fencing/完整性验证。1000域发布单片最高约200.56→1.97ms，调用总数不变；仅为本地合成证据。
- 新增5项Node、1项workerd HTTP回归；完整 **20组、604项零失败**，另7项浏览器通过，Worker/Node/前端类型与构建、主题108项通过。独立证据 `follow-up-p2-verify-20261102`（opencode Temp），497文件 `final-code-source-hashes.json`、`acceptance-receipt.json`和基准前后对比保留。
- P2剩余：完成generation的历史数据目前无限期保留，已有有界purge没有生产调用；先确定保留策略/维护入口再实施。500/1000域合成需559/1115片，超过浏览器每轮500上限，须跨轮同任务续跑；跨页公平性、密集DNS payload和真实云端rows/CPU/额度仍待验收，不放宽40预算/500片/两分钟/30每60秒策略。
- 当前服务**仍为原冻结构建**，PID22636，22:20:37健康与原静态资源200；新优化bundle尚未切换。保留原数据库/AES及用户的新密码/登录记录，不重新启动，不开启Cron/Scanner，不发真实同步、续期或部署。下文22:02密码恢复与更早批次均为历史记录。

## 最新运行状态：密码已按用户要求重置（22:02）

- 用户授权恢复原管理员登录密码，用户名/初始化标志/2FA/账号数据/AES/任务与服务商预算均保留。撤销3个旧会话、清除3个登录失败计数；密码哈希经WebCrypto独立核验，明文不存本文或收据。
- 安全停止原PID25812后备份并原子恢复，已用原启动脚本恢复服务；当前PID **22636**，`http://127.0.0.1:8787/`，22:02:16健康/鉴权状态均200。Cron仍关闭，不代用户登录或恢复Scanner。
- 最新恢复收据位于opencode Temp下 `password-reset-1793628097905-917b8b31/receipt.json`，恢复后的最新成对数据库/AES备份为该目录 `after-backup`，22:02:52核对全表与恢复事务预期一致。早前备份包含旧密码，不可自动恢复覆盖。
- 停机/健康证据 `password-reset-20261102-stop.json` / `password-reset-20261102-service.json`；后台任务 `sh_19c90ec00001LuYf5GPehlF2Ks`。当前服务继续运行，P1/P2任务进度不因密码恢复改变。

## 前批恢复状态与进展（21:50）

- 已按新授权、原启动脚本和原数据库/AES启动 PID **25812**，北京时间 **21:41:34** 起监听 `http://127.0.0.1:8787/`；默认浏览器已打开，21:49:30 健康检查仍为 200。Cron 禁用，登录自动同步/续期窗口未开启，未代用户登录或恢复 Scanner。不另启同库实例，服务保留给用户测试。
- P1 补充离线验收完成：3 项文件 SQLite 重开覆盖列表/DNS 中间片段/遗留有效租约；同 taskId/generation、不重复已保存上游页、不重复完整成功日志。真实 Chromium/React 生命周期另有 7 项通过，包括隐藏/恢复、会话退出与重挂。可见性、API 和冷却均为合成 fixture，不等于 runtime 崩溃或旧真实任务连续恢复验收。
- 最新完整门禁 **20 组、598 项，零失败**；浏览器 7 项独立计数。Worker/Node 类型与构建、前端构建/类型、主题 108 项通过。新增 `npm run test:browser:lifecycle`，只用现有 Chrome/依赖，不加入默认 CI；说明见 `../tests/browser/README.md`。
- 启动前后全表/AES与停机存档一致。随后浏览器产生5条登录失败日志，21:50:17 最新快照保留 **183 logs、88 cache**，账号/域名/Actions/tasks/fragments/items、AES 和任务断点未变；只有 cache/logs/sqlite_sequence 与旧存档不同。已备份最新数据库/AES，不清失败计数、重置密码或恢复旧快照。旧快照的严格比对失败保留，不作为“全表仍不变”的证据。
- 本轮仅修改测试、测试编排和文档，未改生产代码/限频策略、安装或升级依赖、覆盖原产物、切换构建、追加真实服务商请求、提交、推送或部署。下一优先为 P2 合成规模/耗时/成本；真实同步/续期和云端验收仍须明确授权。

下文 00:49–00:51 的完成表和停机记录是历史存档，不表示当前服务仍关闭。

## 已完成与当前数据

- P1–P6：Cron 仅读本地提醒/有界续期，完整同步由有效会话的可见页面或手动操作逐片 await 推进；绑定/换凭据不在后台拉完整快照。
- 操作中心、鉴权本地增量日志及页面生命周期保护完成；预算错误记录类别/原因/计数/阶段，仅暂停提交与权威读取均确认的耗尽返回安全续跑。
- DNSHE 秒级 DB 时钟的 `+1ms` 空转修复完成；整数值 JSON real 租约兼容与新领取整数 CAST 完成。有效租约、30/60s 窗口、冷却、损坏状态及未知结果保护不放宽。
- 最新离线门禁：**20 组、595 项测试，零失败**，新增 23 项。模拟的 paused DNS 12/16 原 taskId 能只继续剩余 4 域；这项“同 taskId 续跑”是离线证据，不算真实验收。Worker/Node 构建和类型、前端构建和类型、主题 108 项通过。
- 用户授权的修复版重启完成于 00:36:16；关闭前 00:49:03 只读观察五账号最新任务均 completed/done：

| 账号 | 最新 DNS 进度 | 最新完整成功（北京时间） |
|---|---|---|
| 1 | 16/16 | 2026-11-02 00:41:18 |
| 2 | 6/6 | 2026-11-02 00:41:11 |
| 3 | 5/5 | 2026-11-02 00:41:09 |
| 4 | 5/5 | 2026-11-02 00:41:10 |
| 5 | 5/5 | 2026-11-02 00:41:10 |

账号 1 最新 taskId 是 `66c9bf09-e80a-4ac3-a349-b5cb0bcbc689`，version 44，和历史暂停任务 `8745c20e-df86-40e0-ab5b-be61782dfae6` 不同；不宣称用户沿该旧 taskId 完成了连续恢复。此次只读观察没有新增真实请求。

最新保留 5 账号、37 域名、83 Actions、178 logs、77 tasks、534 fragments、1068 items；无活动执行或待续跑断点，历史任务仍保留。两份进度/计划文档于北京时间 00:50:45 先保存，Domain Hub 后台测试 PID 36884 已于 **2026-11-02 00:51:14.6367901+08:00** 停止，8787 无监听。关闭前后所有表逐行哈希、AES及断点一致，最新数据库/AES成对备份已保留；不影响其他项目进程。停机证据见 `dnshe-lease-close-20261102-process.json`，汇总与最终文档哈希见关闭收据；未经另行授权不重新启动。

## 后续清单（按优先级）

| 优先级 | 工作 | 当前状态与验收要点 |
|---|---|---|
| P0 | 账号 1 基础恢复 | 已观察最新任务 16/16 完成，五账号均 completed；不为重复确认而自动再同步。旧 taskId 的真实连续恢复、重复请求核验仍未单独验收。 |
| P1 | 同步稳定性与生命周期 | 文件SQLite重开及13项React/Chromium合成测试通过；实际后台标签节流、runtime崩溃及旧真实taskId连续恢复仍待独立验收。 |
| P2 | 规模、耗时与成本 | 有界全局跨页池、密集DNS、深历史索引、手动维护与超500片同任务跨轮完成；最终2000任务预览7855.22→15.43ms/10000任务75.72ms。远端rows/CPU/额度未测；不清真实历史，不提预算。 |
| P3 | 服务商契约 | 用户确认DNSHE同账号共享30/min与普通180天免费；跨Key主体/映射未落实，不能保证合计预算。DP/Huawei等调查按要求暂缓，保守校验保留。 |
| P4 | 迁移与发布安全 | 500行/8MiB异Key迁移、ID映射、原子审计、UI预览确认、辅助停止/not_sent、合成workerd staging及发布回退约束完成；非分片取消409、不通用补偿。依赖升级与双版本安全复验已通过，实际云端staging/上线暂缓。 |
| 独立授权 | 续期小样本验收 | 已接受普通到期前180天免费；不推广到赎回/逾期，不自动配置或开启写操作。实际续期须单独授权、零费用约束及方法/目标状态核对；未知只能GET核验，不自动重发POST。 |
| 管理员 | 历史残留测试域名 | `dhauditmvw6efey9dec48dns.us.ci`，ID `4739823932`，历史删除返回 403；仍需后台/管理员处理，不在本轮自动尝试删除。 |

全部阶段A–F/F06尚未整体完成；依赖安全审计已通过，但661项离线与13浏览器不等于真实API/云端容量/续期全验收。剩余产品功能未扩大实施，主动暂缓项不自动继续；阶段表见[进度](optimization-progress.md#4-阶段状态与剩余范围)。

## 证据与保留位置

- 原数据目录（必须整目录成对保留）：`C:\Users\15017\AppData\Local\Temp\opencode\domain-hub-browser-test-20261031-214529`，含 `domain-hub.db` 与 `aes.key`。不得换 Key、清缓存、重复绑定或回退到旧备份。
- 最新验证/启动产物：`C:\Users\15017\AppData\Local\Temp\opencode\dnshe-lease-verify-20261102`。`acceptance-receipt.json`、`verified-source-hashes.json`、`final-verify-all.log`、`final-build-node.log`、`copied-state-recovery.json`；旧代码失败回归 `red-scheduler.log` 保留。
- Node bundle SHA-256：`1D62A02257721888EAF512A64DB3D62F1129028B28C5814B84B96520FB9FA36B`。
- 最新重启收据：`C:\Users\15017\AppData\Local\Temp\opencode\dnshe-lease-restart-20261102-receipt.json`（当时 PID 36884，00:36:16 启动）。
- 本次关闭前/停止后快照、收据及最新成对备份：`C:\Users\15017\AppData\Local\Temp\opencode\dnshe-lease-close-20261102-{before,stopped,receipt}.json`、`dnshe-lease-close-20261102-backup`。
- 旧预算修复副本 `budget-resume-verify-20261101`、此前重启/验收/探测证据均保留；不得用旧副本覆盖最新构建、数据或用户操作记录。
- 本轮独立副本 `follow-up-p1-verify-20261102`：`acceptance-receipt.json`、494 文件 `final-source-hashes.json` 及完整绿色日志；浏览器最终收据 `sync-lifecycle-browser-KY8ZJj/receipt.json`，均位于 opencode Temp。
- 本轮启动/健康证据：`follow-up-browser-start-20261102-{before.log,after.log,health.json,final-health.json}`；最新状态与成对备份 `follow-up-current-state-20261102.json` / `follow-up-current-state-20261102-backup`。不得用00:51旧备份覆盖后续登录记录。
- P2独立副本 `follow-up-p2-verify-20261102`：497文件 `final-code-source-hashes.json`、604项收据、`benchmark-comparison.json`、完整/定向/红灯日志和 `service-unchanged.json`。基准前/后 `sync-scale-2koe8z` / `sync-scale-PYFywv`，浏览器 `sync-lifecycle-browser-X0V1Fe/receipt.json`，均在opencode Temp；新Node bundle `C8CCBAB5C36302180AFAE385F6B4C7E914CADA6A992F2D92AF41CCCBEE304B94` 未切换到原服务。
- P2维护独立副本 `follow-up-p2-maintenance-verify-20261102`：499文件 `final-code-source-hashes.json`、618项 `acceptance-receipt.json`、`red-history.log` 和完整门禁、22:40 `service-unchanged.json`；浏览器 `sync-lifecycle-browser-oFsZiw/receipt.json`，均在opencode Temp。最新维护bundle同样未启用；工作区收尾文档不覆盖该冻结副本。
- 整批最终副本 `follow-up-all-verify-20261102`：661项/13项浏览器、491非Markdown源码冻结、`acceptance-receipt.json`/`final-gates.json`、绿色`final-full-*`与首轮失败日志、审计和23:20服务收据；不自动启用新产物。详见[整批交付](follow-up-all-acceptance.md)。
- 授权升级副本 `dependency-upgrade-verify-20261102-TY29X5`：两树0漏洞、Node22/24完整复验与独立快照、Node22工具链身份、HTTP冒烟和回填哈希、新收据；旧证据不覆盖。详见[升级验收](dependency-upgrade-acceptance.md)。

## 下次恢复的约束

1. 先读本文件及进度最新存档，核对关闭收据和原数据库/AES是否仍成对存在；禁止清理目录或覆盖不认识的用户改动。
2. 当前已有获授权的 PID 22636；若端口仍有监听不得重复启动。将来服务已退出且获新授权后，使用已验证的 `dnshe-lease-restart-launch-20261102.ps1`；先 `-VerifyOnly` 检查冻结产物/源码哈希，再检查端口与实际活动工作，避免同库两个写入实例。该脚本继续指向原数据目录，不新建空库。数据比对须以最新密码恢复和操作记录为基线，不强求与00:51停机快照一致。
3. 保持 `127.0.0.1:8787`、`DISABLE_CRON=1`、代理 `http://127.0.0.1:10808`（本地地址绕过代理）；不擅自开启登录自动同步、续期窗口或恢复 Scanner。
4. D1/external各40、DNSHE现有按Key30/60s、全局≤25账号流/每计划页25、每账号每轮500片、手动窗口2分钟保持。已确认同账号多Key共享30/min，但跨Key映射/预算尚未实现，不能宣称现有按Key等于合计保护；不新增固定双槽或换Key绕额度。
5. 构建/测试继续用新独立副本与明确锁文件，安装升级须授权，不覆盖原产物或冻结证据。本轮授权升级仅回填5份文件及文档，工作区node_modules和服务未更新，旧验收哈希不改写；未提交、推送或部署。
6. 启动后只核验健康/静态资源与本地状态，不因启动就推进任务、同步、续期或恢复扫描；计划中的真实操作须单独授权。
