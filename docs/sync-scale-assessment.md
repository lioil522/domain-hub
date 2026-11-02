# P2 分片同步规模与成本评估

评估日期：2026-11-02（北京时间）。本轮为离线合成评估和查询优化，**不是生产容量、云端 CPU 或真实服务商验收**。真实服务保持原冻结构建与原数据库/AES；没有重启、真实同步、续期、Scanner、部署或依赖升级。

## 最新补充：整批优化（23:20）

- 全局≤25账号流池、最多一页待派发已取代整页barrier，后页填入释放槽位；51账号浏览器和7项Node回归通过。满池/慢流仍可延迟后页，不保证无限公平、不提高500片/两分钟限制。
- 密集DNS新增UTF-8 32768/32769字节、4/5页各100条的128KiB累计及坏ID回归；边界失败保持旧缓存/dirty，不用单记录基准替代密集payload证据。
- 三个增量索引`idx_sync_tasks_latest/freshness/success`（完整名称各以`idx_sync_tasks_`开头）改善保留资格查询。最终2000任务预览7855.22→15.43ms，索引10000任务75.72ms，资格结果及query plan一致。初建索引成本/云端rows/CPU未验，**不是有界扫描保证**。
- 完整661项/13浏览器与证据见 [整批交付](follow-up-all-acceptance.md)。本地规模/代码范围已推进，下文22:20“未改schema/跨页待办”仅历史测量状态；原耗时/存储证据保留，不在原基准库或真实库清历史。

## 22:20第一轮历史测量

22:40另补保守手动历史维护及559/1115片同任务跨轮，门禁618项+7浏览器，详见 [历史维护说明](sync-history-maintenance.md)。下文前后耗时/增长仍为22:20测量，不因后续实现变更而重算。

## 测量方法与边界

- `npm run bench:sync`：在独立验证副本运行生产 `syncStep` / `syncPlan`，使用全新内存 SQLite 和每片新的严格 D1/external 40/40 预算。
- 合成 DNSHE 每次方法调用向真实预算计数器计入一个外部页操作，禁止真实 outbound；不运行鉴权、凭据解密、服务商 admission/transport 或窗口等待。每个 DNS 页只含一条合成记录，不能外推到高密度/接近 128KiB 的 DNS 快照。
- 同步场景预置相同数量的已有域名，并加 1,000 条其他账号域名；五账号场景逐片轮转，两次完整同步保留两个 generation。每轮检查同 taskId、页键不重复、完整成功日志只有一次。
- 单片耗时含测量器和首次 EXPLAIN 开销；SQL 单语句耗时不含 EXPLAIN。没有耗时通过阈值，不把单次本地前后比较当成生产延迟保证。
- **D1 API dispatch ≠ SQL statement ≠ rows scanned/written**。一次 batch 在应用计数器中算一次 D1 调用，但内有多条 SQL。返回行数、SQLite `runChanges` / `total_changes`（含触发器）和已分配页不能替代云端计费指标。本轮云端 rows_read/rows_written/CPU 均未测。
- 另有真实本地 workerd/D1 HTTP 回归：经过有效合成会话、原路由和原 Cloudflare 客户端/admission，通过 fixture 返回分页响应，出站只允许计划中的合成 GET。不是 Cloudflare 远端 D1 或真实账号。

## 已修复的查询热点

生产变更仅在 `src/services/sliced-sync-service.ts`，不改 schema、预算、游标或 HTTP 契约：

1. **域名整数主键查询**：原 `CAST(d.id AS TEXT)=i.domain_id` 使冲突检查重复扫描域名索引；改为先 `d.id=CAST(i.domain_id AS INTEGER)` 主键定位，再保留原精确文本比较。`EXPLAIN QUERY PLAN` 三处冲突/DNS join 均为 `SEARCH d USING INTEGER PRIMARY KEY`。不能仅删除文本比较，否则 `01` / `1.0` / `1junk` 等损坏 ID 会别名到整数域名。
2. **账号最新任务计划**：从每个历史任务执行 anti-join，改为每个有界账号只求一次最新 rowid 后主键读取；保留 `created_at DESC,rowid DESC`，不以插入顺序替代创建时间。每页仍最多 25 账号，整 25 的倍数仍有一个空终止页。

完整 seen 数量检查、每片跨账号碰撞检查、事务内碰撞 assertion、任务租约/generation/scope/version fencing 和业务写入防并发条件全部保留。没有缓存“已完整”标记或跳过重复验证来制造性能收益。

## 本地前后结果

下表同步耗时为所有片段的累计本地调用耗时，不是用户端端到端同步时间。前后调用/页/SQL 条数、逻辑存储增长及 SQLite 总变更数均经收据断言相同。

| 合成场景 | 片数 | D1 调用 | 外部页操作 | SQL 条数 | 累计耗时，前 → 后 | 发布单片最高，前 → 后 |
|---|---:|---:|---:|---:|---:|---:|
| 5 账号 × 20 域、每域 2 DNS 页、2 轮合计 | 470 | 4,610 | 410 | 7,010 | 302 → 277ms | 4.78 → 2.49ms |
| 1 账号 × 100 域、每域 3 DNS 页 | 315 | 3,029 | 301 | 4,370 | 191 → 120ms | 14.32 → 1.62ms |
| 1 账号 × 500 域、每域 1 DNS 页 | 559 | 6,001 | 505 | 10,646 | 2,259 → 249ms | 80.51 → 2.85ms |
| 1 账号 × 1,000 域、每域 1 DNS 页 | 1,115 | 11,974 | 1,010 | 21,250 | 10,328 → 475ms | 200.56 → 1.97ms |

75 账号、每账号 100 历史任务：三页各 25 账号，每页 3 次本地 D1 调用；最后空页 2 次，所有页 external=0。前三页约 **12.88–13.23ms → 0.82–1.49ms**。最新任务只按已选账号读取，历史的 timestamp tie、不同 mode、时间/插入次序不同及账号过滤均有回归。

### 1,000 域名的优化后阶段成本

| 阶段 | 片数 | D1 调用 | 外部页操作 | SQL 条数 | 单片 D1 最高 |
|---|---:|---:|---:|---:|---:|
| 候选旧域名 | 26 | 212 | 0 | 1,242 | 12 |
| 拉取列表 | 10 | 80 | 10 | 1,091 | 8 |
| 发布列表 | 51 | 459 | 0 | 1,562 | 9 |
| DNS（含末尾确认） | 1,001 | 11,008 | 1,000 | 16,111 | 11 |
| quota 占位阶段 | 1 | 7 | 0 | 9 | 7 |
| 核对旧域名 | 26 | 208 | 0 | 1,235 | 8 |

单片预算有余量不表示总成本低：总量仍随 DNS 页数增长，且 DNS阶段占主要调用成本。真实 DNSHE 还会计入凭据/admission/释放等 SQL 和按 Key 的 30/60s 等待；本地 475ms 绝不代表真实同步也能半秒完成。

### workerd HTTP 小样本

- 26 个合成 Cloudflare 账号计划分页为 25 + 1，external=0。
- 对账号 1 和 26 各读取 105 个域名、3 页；两个快照各沿同一新 taskId 完成，没有重复页或重复成功日志。
- 共 **22 次 HTTP 同步片、236 次 D1 调用、6 次合成上游 GET**；单片 D1 最高 **13**，external≤1，结束 reservation 全部归零。定向运行观察单片 HTTP 往返最高约 28ms，仍不是 Workers CPU。

## 存储增长与剩余风险

- 五账号 × 20 域 × 2 DNS 页，两轮后：tasks **5→10**、items **200→400**、fragments **200→400**、logs **50→100**；fragment payload **19,000→38,000 字节**，item baseline **13,992→28,192 字节**。当前每个完成 generation 的片段和 seen/candidate 数据都继续保留。
- 1,000 域场景单 generation：2,000 items、1,000 fragments、109 logs；fragment payload 95,000 字节，baseline 143,673 字节；合成数据库已分配约 1.59MB，包含预置账号/域名/索引，**不是每轮新增量或真实账单**。
- 22:20原评估时 `purgeSyncHistory()` 无生产调用；22:40补充了默认只预览、明确确认才执行的手动维护入口，最低保留30天，保护按创建时间最新任务/最近实际成功/继承新鲜度与活动或损坏断点；详见 [历史维护说明](sync-history-maintenance.md)。**仍没有自动维护调用**，没有触碰真实任务/cache/日志；新增入口不使前述两代存储增长证据失效。
- 发布数量/碰撞检查仍每 20 行读取整个本任务 seen 快照；整数查询消除了跨域名表反复扫描，但总快照检查仍随 N 的片数增加。候选域名的文本 range/排序、最新任务的历史排序也仍是候选热点，须另做基准后再决定索引/游标迁移。
- 500/1,000 域场景分别需 **559/1,115 片**，超过每账号每轮500片；此基准显式继续运行，不是前端单轮证据。后续已补同taskId跨轮及全局跨页池；这里22:20基准未包含新调度，不提高500上限。
- 大账号的真实按 Key 等待很可能超过手动两分钟窗口，须通过后续轮次沿原 taskId 继续；不要自动换任务或放宽窗口。本轮未做真实等待验收。

## 验证、证据与后续

- 新增 5 项 Node 回归和 1 项 workerd HTTP 回归。旧源码的两处 query-plan 回归先红；另保留测试初稿的 LIMIT 1 期望错误、合成 CF Token fixture 修正日志，不将它们算成生产缺陷。
- 完整门禁 **20 组、604 项，零失败**；独立 Chromium/React 生命周期 **7 项通过**。Worker/Node 类型与构建、前端类型与构建、主题 108 项和新增规模 helper 类型检查通过。
- 独立副本：`C:\Users\15017\AppData\Local\Temp\opencode\follow-up-p2-verify-20261102`，含 `acceptance-receipt.json`、497 文件 `final-code-source-hashes.json`、`benchmark-comparison.json`、红/绿和完整门禁日志。验证时源码与副本哈希一致；此评估/进度文档随后仅更新工作区，不覆盖冻结证据。
- 基准前/后：opencode Temp 下 `sync-scale-2koe8z` / `sync-scale-PYFywv`；浏览器最终收据 `sync-lifecycle-browser-X0V1Fe/receipt.json`。原始每片、每 SQL、各轮存储观察全部保留。
- 新 Node bundle SHA-256：`C8CCBAB5C36302180AFAE385F6B4C7E914CADA6A992F2D92AF41CCCBEE304B94`，**尚未切换到当前服务**。当前仍为原 `1D62A02257721888EAF512A64DB3D62F1129028B28C5814B84B96520FB9FA36B`。22:20:37 健康/静态资源 200、PID22636 与原入口资源哈希匹配，证据 `service-unchanged.json`。
- P2第一轮后的保守手动维护、跨轮/跨页池、密集DNS和深历史索引已离线完成；实际云端rows/CPU/配额仍未验，真实API/远端D1/部署/重启须另授权。

当前文档依据（2026-11-02 获取）：[D1 索引与 EXPLAIN](https://developers.cloudflare.com/d1/best-practices/use-indexes/)、[D1 batch 事务语义](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[D1 计费定义](https://developers.cloudflare.com/d1/platform/pricing/)、[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。实际计费需用远端 meta/Analytics/控制台核验，不能用本地 API 次数推导免费额度通过。
