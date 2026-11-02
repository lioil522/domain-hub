# 同步历史的安全有界维护

日期：2026-11-02。本轮只实现并用合成数据验证维护入口，**没有清理真实历史、切换当前服务或开启自动维护**。生产数据的实际维护应先取得授权并成对备份最新数据库/AES；不要使用早期备份覆盖密码恢复或后续操作。

最新补充（23:20）：三个增量历史索引、全局跨页账号池和密集DNS边界已离线完成，最终661项/13浏览器通过，见[整批交付](follow-up-all-acceptance.md)。默认预览/最低30天/事务复核/每表100行保持不变，原22:40维护证据不覆盖；云端scanned/billed rows与CPU依然未验。

## 保留策略

- 默认只预览。执行必须同时提交 `dryRun: false` 和确认字符串；仅支持有效管理员会话/现有应急鉴权通道。
- 默认保留 30 天，只接受 30–3650 天整数。年龄依据 SQLite/D1 的数据库秒时钟及 `updated_at`，不是浏览器时钟。没有提前清理开关。
- 只处理 `completed` / `cancelled` / `invalidated` 终态。`queued` / `running` / `paused` / `blocked` 无论多旧都保留；有 owner/lease 或损坏/超长 JSON cursor 的终态也不删除。
- 每个账号和 mode 独立保护：按 `created_at DESC,rowid DESC` 的最新任务、最后一次实际完成任务，以及 `last_completed_at` 最大的继承新鲜度记录。导入时的 rowid 顺序不替代创建时间；时间相同才以 rowid 决胜。
- 碎片、seen/candidate 索引和空任务逐片移除。每片每表最多 `limit` 行，默认/上限 100，最小 1；合计最多 300 条协调数据删除，另新增一条原子审计日志。任务只有全部子行已移除才可删除，避免任务外键触发无界级联。
- 不删除 domains/cache、Actions、业务日志、Scanner 断点、服务商窗口/租约、续期意图、凭据、设置或 AES。保留完成任务的成功日志与旧 Action；本入口不是全站存储回收或数据库压缩工具。
- 预览不产生维护日志；明确执行才在同一 D1 batch 记录操作审计，审计写入失败也回滚删除。

这些是保守的最低保留约束，不承诺“30 天后全部消失”。最新任务、成功记录和有效/损坏断点可以长期保留。没有接入 Cron、登录同步、同步完成回调或页面轮询，也不新增 UI 自动清理按钮。

## 接口契约

`POST /api/sync/history/maintenance`，使用现有 `Authorization: Bearer <会话>`，JSON 请求体最多 1024 字节。

只预览：

```json
{ "retentionDays": 30, "limit": 100, "dryRun": true }
```

`{}` 也是预览，省略字段使用上述默认值。拒绝字符串数字、布尔字符串、null、数组、无效 JSON、未知字段以及越界整数。

**仅在独立授权和最新备份之后**，一次明确执行的请求体为：

```json
{
  "retentionDays": 30,
  "limit": 100,
  "dryRun": false,
  "confirm": "purge-terminal-sync-history"
}
```

响应包含 `dryRun`、`retentionDays`、`limit`、`deleted: { fragments, items, tasks }`、`sample: { candidateTasks, fragments, items }` 和 `hasCandidates`。

- `deleted` 是已确认提交的本片直接删除数量，不是 SQLite 触发器或 D1 计费行数。
- `sample` 是只看最多 `limit` 个候选任务、每类最多 `limit` 条子行的有界样本，**不是历史总量、总字节数或下一片保证**。`candidateTasks` 包含尚有子行的任务，不表示它们立即可删除。
- 执行时不采用预览返回的 ID：每个 DELETE 在事务内重新检查资格。任务重新获得 owner/lease，或预览之后移除了更晚任务时，旧预览不能授权删除现在应保留的任务。
- 提交、网络、预算或执行后样本读取失败不触发应用重试，也不声称未提交。先重新预览/检查审计，取得明确意图后再执行下一片；不要对 500/503 或超时做自动循环重发。
- `hasCandidates: false` 表示该次数据库检查未发现符合策略的候选，不表示业务数据/受保护历史为空，也不保证之后仍为空。

## 本轮合成证据

- 旧清理实现的三项新回归先失败：会误删创建时间最新但先插入的任务、最后成功记录，以及带遗留 owner/损坏 cursor 的终态。修复后通过；没有在原数据库上复现删除。
- 205 条 fragments + 205 条 items：前三次执行分别直接删除 `100/100/0`、`100/100/0`、`5/5/1`，共 411 条协调数据和 3 条操作审计；最新任务与原业务状态/成功日志/Action 保留。
- 121 个无子行历史任务：预览候选上限 100，执行分成 100 和 20，留下最后完成任务。
- Node 测试覆盖时间/rowid tie、跨账号和 mode 隔离、最后成功/继承新鲜度、活动与损坏/近期任务、默认预览和参数拒绝、事务内资格变化、失败回滚、未知提交不重试及零预算不删除。
- 真实本地 workerd/D1 经合成会话调用生产路由验证鉴权、默认预览、确认/请求大小、三片删除与审计失败回滚。每片含鉴权 **3 次 D1 API 调用，external=0**；没有真实服务商或远端 D1 请求。
- 前端追加 559 / 1115 片合成回归：每轮不超过 500 片，分别跨 2 / 3 轮始终沿同一 taskId，仅最终完成回调一次。响应为合成 fixture，**不是实际浏览器冷却、旧真实任务恢复或全链路大账号验收**；没有修改前端 500 片逻辑。

实现位置：`src/db/dao/sync-task-dao.ts`、`src/services/sync-history-service.ts`、`src/routes/sync.ts`。独立验证及红/绿/完整门禁证据保存在 `C:\Users\15017\AppData\Local\Temp\opencode\follow-up-p2-maintenance-verify-20261102`；此前 P2 冻结证据不覆盖。

完整门禁 **20组、618项零失败**（604+14），独立Chromium/React **7项通过**；Worker/Node/前端类型与构建、主题108项及规模helper类型均通过。冻结499文件源码哈希与工作区代码一致；此文及进度随后只在工作区补记。最终浏览器收据为opencode Temp下 `sync-lifecycle-browser-oFsZiw/receipt.json`。

新验证Node bundle `55C3617BDD067326FDAA8645D674A4858E305A7C7F1AED79A905EB533538E3F7` **未启用**；22:40:00原PID22636/健康/静态入口均正常，仍运行原冻结构建，证据 `service-unchanged.json`。未访问原数据库/AES、发真实上游请求、重启、开启Cron/Scanner、升级依赖、提交、推送或部署。

## 云端边界与后续补充

有界返回、删除数量和D1调用**不等于有界扫描行、云端CPU或收费总量**。23:20补了三个latest/freshness/success增量索引：2000任务最终本地预览7855.22→15.43ms、索引10000任务75.72ms，资格结果不变；初建索引本身的生产扫描/CPU未验。仍需远端rows/CPU测量，不用提高40预算掩盖成本。

跨计划页已改为全局≤25顺序账号流、最多一页待派发，释放槽位即补后页，不再等待整页收尾；51账号浏览器通过，但满池慢流仍可阻塞，不是同时启动全部账号。密集DNS边界离线已补；真实冷却/后台节流/崩溃、云端计费/配额继续独立保留。

事务依据：[D1 batch 文档](https://developers.cloudflare.com/d1/worker-api/d1-database/)（2026-11-02 获取）；运行约束见 [分片同步说明](cron-sliced-sync.md) 和 [后续计划](follow-up-plan.md)。
