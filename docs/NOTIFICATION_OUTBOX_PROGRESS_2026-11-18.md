# 通知 outbox：2026-11-18

本批承接 `d33723a` 的发布门禁；该提交对应 CI、Worker 部署与双架构 Docker workflow 均已成功。本批先本地开发和隔离验收，未提交、推送、部署，未调用真实通知平台、修改生产数据库或密钥。

## 修复内容

- schema v5 追加 `notification_outbox` 和 `notification_scans`，当前共 17 个显式索引；v4 及更早版本通过共享迁移器升级，不重建业务表。
- 到期检查不再使用 `expiry_reminder_sent` 提前标记发送成功。扫描完成与通道投递成功是两种独立状态。
- CF、DigitalPlat、自定义分组共用持久的每日分页游标，每切片至多 25 条。CF 手动日期优先，注册域再读取 RDAP 缓存；不会每轮永远只取最前面的 100 个注册域。
- 提醒入队和扫描检查点在同一事务中提交；失败、租约失效或进程中断不能跳过未持久化的页。
- 定时续期确认、缓存日期更新和成功通知入队同事务提交。上游已经续期但本地事务失败时，保留 `attempting` 日志，下一轮只读 GET 核对，不再重复 POST。
- 持久同步队列的报告入队与 `notify → done` 检查点同事务提交；取消/过期执行者不能追加通知。
- Worker 分钟触发器与 Node 持续执行器分别推进同步、一次投递和一页到期检查；一个子系统失败不会使其他子系统永远得不到执行。可选 sync Queue 未增加新的通知消息格式。

## 投递状态与幂等范围

```text
queued → running（90 秒租约、领取时计次）
  ├─ 平台确认 → sent
  ├─ 可重试错误 → queued（not_before / 有界退避）
  └─ 永久错误、6 次尝试耗尽或超过期限 → dead
queued / running / dead → cancelled（显式取消）
dead → queued（显式重试，沿用原快照）
```

- 每个事件、目标及消息分片生成稳定 SHA-256 ID；重复生产不会修改已有 queued/sent/dead/cancelled 记录。
- Webhook 与 Telegram 独立计次、成功和失败；其中一条通道失败不会重发另一条已成功通道。
- 到期事件按 UTC 日期、来源/账号和域名去重。新日重新扫描；目标集合变化时重新扫描，但既有目标的相同事件仍被唯一 ID 去重。未配置目标时不把当天扫描标记完成。
- 正文超过 1,500 UTF-8 字节按完整码点分片，添加分片编号；不保证故障重试后的分片到达顺序。
- 自定义 Webhook 携带稳定 `Idempotency-Key`。只有接收方真正实现该幂等契约，才可在重复请求时避免副作用。
- 通知 HTTP 请求及响应体总期限 10 秒，响应最多 64KB。Worker/Node 使用 `redirect: manual`，不跟随 3xx；真实 workerd 验收发现并修正了不兼容的 `redirect: error`。
- 支持 HTTP/API Retry-After；从 1 分钟开始指数退避，最多 6 次，单次延迟最多 24 小时。提醒投递期限 2 天，其他报告默认 3 天。
- 终态保留 30 天用于去重与排障，每小时最多清理 200 条旧终态；保留期不是无限去重承诺。

**不能承诺严格 exactly-once：**第三方发送成功后本地提交失败、丢失响应、租约回收等会标记 `uncertain`，有界自动重试仍可能重复。取消也无法撤回已在途的网络请求。应用层去重与 SQL fence 不等于外部平台支持幂等。

## 响应验证与密钥

- Telegram 需要 JSON `ok === true` 及有效 `result.message_id`；非 JSON、截断 JSON、伪成功、读取失败均不是成功。
- 钉钉/企业微信要求数值 `errcode === 0`；飞书支持数值 `code === 0` 或旧 `StatusCode === 0`，矛盾字段拒绝；Server酱要求数值成功码，存在内层 errno 时也必须成功。
- 只有 `custom` 明确定义为 HTTP 2xx 接收策略，不将这个宽松判断扩散到其他平台。
- 新快照以既有 AES-GCM 密钥加密，包含正文与目标凭据，并绑定 ID 和目标身份。未配置 AES_KEY、错密钥、坏快照均失败关闭，不生成新的 `plain:`。
- 应用配置读取失败或已识别密文解密失败不再被当作空配置/可用凭据；已存在的合法明文及 `plain:` 历史设置仍可读取。
- 队列 API 不返回正文、密文、Webhook URL、Bot Token、Chat ID。队列错误只记录受限错误码，不保存平台回显的原始响应；手动测试接口诊断做 URL/凭据脱敏。
- 队列保存**生产时的目标快照**。后来换配置不会自动改写旧消息或转发到新目标；取消旧待投递项后再处理新消息。恢复旧死信需要保留原 AES_KEY。

## 运维 API

所有接口沿用现有管理员认证：

- `GET /api/notifications?status=dead&limit=50`：只读元数据及状态计数，limit 为 1–100。
- `POST /api/notifications/<64位ID>/retry`：只允许 dead。`uncertain=1` 时需 JSON `{"acknowledge_duplicate_risk":true}`，明确接受重复风险。
- `POST /api/notifications/<64位ID>/cancel`：取消 queued/running/dead；不能把已 sent 的记录重发或取消。

本批没有新增通知中心 UI、自动换目标、批量 redrive 或外部死信系统；`dead` 表记录及上述 API 是当前本地 DLQ。

## 验证与预算

- 全量验证及额外 selfhost 构建通过，271 个不变量/集成用例通过（原有 223 个 + 本批 48 个），workerd 通知投递及 Node/SQLite 冒烟均通过。
- 针对并发生产/领取、事务故障、通道独立失败、响应 JSON/超时/取消/超大正文、旧租约、错密钥、重试期限、取消竞态、跨页全覆盖、日切换、目标变更、迁移回滚、定时续期只读恢复、同步检查点及认证 API 追加回归。
- 新表使首次 setup 原本达到 53 条准备 SQL，故合并 bootstrap 元数据读取及已有 claim fence 下的三字段初始化写入；保持事务与竞争保护。新回归要求默认配置首次 setup 不超过 50 条，bootstrap 不超过 44 条。
- 另测试“同步解析切片 + 25 条到期检查 + 一次投递”并加上 schema 读取的子请求预算，不能仅单独测试各任务再假设组合安全。
- runtime smoke 使用只存在于临时目录的 workerd 测试包装器，触发真实业务 scheduled 代码。隔离 D1 上确认提醒入队、模拟端点投递、sent 状态、稳定幂等键及再次触发不重复；包装器没有加入生产 bundle。
- 远端 CI 的 Linux workerd 拒绝绝对临时路径逃逸模块根目录（`can't use ".." to break out of starting directory`），因此包装器改为内存内联模块，不再写临时脚本文件；Windows 与 Linux 走同一路径。
- Node/SQLite 认证与接口冒烟、源代码隔离 Docker 构建、普通/selfhost 前端、Worker/Node 构建、产物 no-bundle dry-run 及全量回归仍是发布门禁。

## 升级与已知边界

1. 保留原 AES_KEY，备份数据库及密钥；schema v5 升级后不要直接降级为旧迁移器。
2. 保留现有 `* * * * *` Worker Cron。不要将旧“发送前标记”缓存迁移为 sent，它并不能证明历史发送成功；因此升级当天可能多一轮提示。
3. 工作进程中断后靠既有调度恢复；此批没有创建 Cloudflare Queue、Workflow 或其他收费资源。
4. Worker 当前每分钟只尝试一条投递，Node 按现有秒级循环推进。大量到期域名、双通道、分片会形成积压，超过期限转死信；尚未实现聚合投递、全局限速或高吞吐扩容，不能宣称所有规模均保证及时通知。
5. 扫描基于当前已缓存的到期数据，不做新的全量 RDAP 回源；已完成当日扫描后新增/修改数据通常下一日进入检查。极大集合跨日仍需后续调度/扫描策略优化。
6. 定时续期报告改为可独立恢复的逐域名事件；持久手动同步保留账号汇总报告。没有补发升级前所有历史报告。
7. 本地模拟并不代表真实平台、线上数据库、Linux 双架构 Docker 或远端 Actions 已验收。本批截至此记录仍未提交/推送。

参考：已通过指定本地代理检索当前 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、[D1 batch 事务](https://developers.cloudflare.com/d1/worker-api/d1-database/) 与 [Telegram Bot API](https://core.telegram.org/bots/api)，并核对最新 `@cloudflare/workers-types@5.20261118.1` 的 D1 类型。未因此升级项目依赖。
