# 增量持久摘要可行性评估（2026-11-23）

基于 `facb5b22ff5b5e60af79914cc496e133cfba76c7`。本批完成代码审查、官方限制核对及五个可执行反例，**没有接入增量生产器、后台摘要任务、新表/索引、FTS、Queue 资源或新的刷新 API**。现有同步返回摘要、AES_KEY、schema v6、512KiB/5分钟缓存及所有预算保持。

## 结论

值得进入下一阶段的是：**隔离的规范化库存贡献投影 + SQL 聚合原型**，先验证口径和读写成本，再决定持久日志、执行器与 API。

不能直接实施的捷径：

| 方案 | 结论 |
|---|---|
| 每个分片算完 DashboardStats 再求和 | 错误：跨来源同域、永久/有真实日期、过期 OR、首次注册及稳定到期顺序均不是独立分片计数 |
| 每分钟 Cron 运行现有全量 summary | 不是增量；只是移动全量 CPU/内存。Free Cron 同样有 CPU 限制，还可能空闲时持续消耗 D1 额度 |
| 用现有 `sync_work` 创建全局摘要任务 | 不可直接复用：账号 FK、凭据 fingerprint、逐账号活跃唯一性、同步 phase/renew/notify 语义均不匹配 |
| 只存一个超大中间 JSON | 当前 50k 托管紧凑投影容器实测 **11,027,829 字节**，远超既有 512KiB 策略；这只是反例格式，不是拟投产的状态协议 |
| 只凭全局 revision 续用旧分片结果 | 不够：revision 是不透明失效戳，没有旧/新键、删除 tombstone 或可顺序消费的变更日志；时间/RDAP 失效也可不改变 revision |
| 把冷读改成 202 + job ID | 会改变当前前后端契约，必须另行明确，不能伪装成兼容优化 |

压缩单个中间 JSON 也不等于有界 CPU/峰值内存：解压和重建整个映射仍需评估。不能为方便暂存放宽 512KiB 或丢弃合法字段。

## 当前实现的约束

- `src/services/catalog-summary-cache.ts`：普通命中单次版本校验索引读；缓存缺失/强制刷新同步构建，有正在进行的请求合并。强制刷新不能加入普通缓存结果，持续版本变化最多重试一次后失败。
- `src/db/catalog-version.ts`：已知库存写入与随机 revision 同一 D1 batch。它识别“哪些写操作可能影响库存”，不是“本次到底改了哪些行”。同域在多来源的有效期与元数据互相关联，不能把 SQL 操作名当可靠 delta。
- `src/services/sync-work-runner.ts` / `src/db/dao/sync-work-dao.ts`：同步工作项绑定真实账号/凭据，不支持 global-summary phase。不能创建虚构账号来绕过约束。
- `src/services/background-maintenance.ts`：每次并行推进 sync、notification、expiry 三个独立单元；加入第四个系统前需要计算**整个 invocation**的 CPU/SQL/存储开销，不是给每个子系统各算一次预算。
- Worker `queue()` 当前只识别 `sync_tick`，其他消息被 ack。将摘要消息直接塞进去会丢失唤醒，而不是调度成功。
- Node 每秒推进 maintenance；Worker 有分钟 Cron，Queue 是可选绑定，仓库默认并未配置它。Node 顺畅不证明 Cloudflare 分片及时完成。
- `ActionRepository.update()` 是读取后覆盖，`updateActive()` 仅检查 active status；不能把普通 actions metadata CRUD 当成已有的持久租约/检查点执行器。
- 通用 `cache-dao.ts` 对存储失败会记录日志后返回；它适合可选缓存，不是检查点持久化确认。持久任务必须使用严格 SQL 结果、租约 fence 和原子检查点，不能忽略写入失败后继续游标。
- 通用过期 cache 清理可能包含 RDAP，因此会保守失效全局版本。新派生 namespace 必须纳入精确治理：不能让自己的检查点清理反复失效自己，也不能豁免真正的 RDAP 清理。

## 不能改变的统计规则

1. 使用共享 JS 归一化/不可见字符候选逻辑。SQLite 的 `lower` 不能替代全部 Unicode/Punycode 行为。
2. canonical 去重后才聚合。原始过期状态 OR 与选中的真实到期日期分开；永久候选遇到真实日期或过期不能重复归类。
3. 手动/RDAP 与自身 fallback 的优先级、原始名称/alias、第一次有效到期插入顺序、同日/月桶稳定顺序保留。后续来源替换更紧急日期不能改其原插入位置。
4. 首次 truthy `created_at` 保留原字段/来源。有限日期可以 SQL/有界前六选择；非法日期按用户选择保留历史比较器。该回退不能宣称任意规模有界 CPU，也不能在 SQL 里悄悄“非法置后”。
5. 日期投影必须区分显式时区与无时区时间戳。反例中 UTC 到期赢家是 Cloudflare，而 `timezone_offset=-480` 的赢家变成 DNSHE；不能只持久化 UTC 赢家再整体平移。
6. 最长5分钟、到期严格 `< now`、90天进入点、月界、RDAP 自然过期，以及 out-of-band SQL/旧 backend 的强刷或 TTL 兜底保持。

业务写入、账号删除/改来源、日期覆盖删除与 staging restore 都可能改变依赖集；旧 key 的撤销、级联删除与剩余来源重新选择必须在 delta 设计中明确。

## 时间与进度：为什么“可恢复”不等于“可及时发布”

举例：56,250 库存行，每次1,000行、每分钟只推进一个片，至少57片，约57个调度周期（这只是该调度方案，不是平台规定只能一个片）。在构建开始时冻结统计布尔值/月份，5分钟后已经可能失效。

本批反例在 revision 不变时，两个摘要时间点的 expired 从0变1；缓存早于最长 TTL 被到期边界截断。不能仅将旧分片的 `generated_at` 改成完成时间。

更长时间的原始贡献暂存是可研究方向，但发布时必须重新计算时间资格和 RDAP 有效层，并证明所有源贡献仍可用于当前版本/验证窗口。仅把贡献的 TTL 拉长会破坏“直改SQL/旧backend等待最长5分钟”的现有保证。若将来选择只支持受控新 backend 写入、要求所有直改必须强刷，那是需要确认的契约变化，不在本批偷偷实施。

## D1/CPU/费用预算

2026-11-23 经代理读取当前官方文档：

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)：Free HTTP 与 Cron CPU 10ms，isolate 内存128MB；数据库/网络等待不计 CPU。不能拿本地约349ms墙钟直接判定生产计费 CPU。
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)：Free 每 invocation 50 次查询调用、Paid 1000；SQL 长度100KB、绑定参数100、单行/字符串2,000,000字节、查询/整个 batch 30秒等限制仍适用。
- **当前 D1 文档特别说明 `db.batch()` 调用按一次 invocation query 计，而不是每个 statement 一次。** 这不取消逐语句限制或读写计费；项目仍保留更保守的 bootstrap ≤44／首 setup ≤50 个 prepared SQL 门禁，不借此放宽。
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)：Free 日读取5,000,000行、写入100,000行；扫描而非返回行计 read，INSERT/UPDATE/DELETE 计 write，索引写入可能增加计数。
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/) 给出独立 consumer CPU/wall/消息限制，不能混用 HTTP 的CPU口径，也不能把 Queue 当成已经部署或免费无额度成本。本批没有启用/购买任何资源或提高 CPU 配置。
- [D1 Sessions](https://developers.cloudflare.com/d1/best-practices/read-replication/) 的 bookmark/顺序一致性不是跨多个任务的严格库存快照；需最新版本时考虑 `first-primary`，并用 SQL 条件发布检查真实当前 revision。

**逐库存行贡献暂存方案的量级示例，不是所有增量算法的下界：**

- 50,000托管 + 6,250自定义 = 56,250行。每5分钟无条件全量重写，至少 `56,250 × 288 = 16,200,000` 次表行写/天；尚未包含索引、清理、manifest、日志或业务同步。
- 两次这种全量写已经112,500行，超过Free日100,000行额度；删除旧 generation 也不是免费。
- 同规模每5分钟全扫描，仅一次表扫描的量级也是16,200,000行读/天，超过Free日5,000,000，尚未算 JOIN/多次聚合/其他业务。
- 当前暖摘要是少量索引读取；不能为降低少数冷读 Worker CPU，把后台变成永久全扫描/全重写器。

需要分别记录 **返回行、D1 `meta.rows_read/rows_written`、表/索引空间、SQL计划、Worker生产CPU、每次slice的CPU与内存**。Node适配器的 rows_read=0 是占位，不能用于 D1 费用验收。

## 建议的分阶段方案（尚未实现）

### 1. 隔离贡献投影 + SQL 聚合原型

- 不接入生产路由/写入钩子；使用新临时库，继续共享归一化与日期解析，不增加框架/数据库。
- 贡献记录区分 table、库存ID、账号/分组、原始字段、canonical/candidate keys、固定/偏移相关日期与来源序。只读面板字段，不读取或序列化凭据。
- 使用现有 cache 表的独立 generation namespace 研究暂存；同时按条数与编码字节限制分片，单条异常过大应明确失败/回退，不跳过数据假报成功。
- SQL 先 canonical 去重/选赢家，再计算完整计数，最后截断返回8/6/每月20条；验证 first-finite order，不直接以赢家到期时间代替同日历史 tie order。
- 有限日期路径研究有界 Worker返回；非法日期继续旧 comparator 回退并单独报告最坏开销。
- 与原服务在 Node/workerd 对照口径、时间/RDAP边界、删除/改名/覆盖、SQL返回及实际D1成本。缓存表范围索引不等于有 canonical JSON 字段索引；复杂窗口查询也可能阻塞单数据库。

### 2. 再设计受控写入的 delta 与恢复

- 同事务记录旧/新标识、删行 tombstone、账号/日期层影响与序号或 watermark；覆盖批量同步、级联删除、归档迁移和 restore，不能仅记录单条UI编辑。
- 新类型的全局任务要有格式版本、捕获 revision、游标、byte预算、租约 token、恢复/退避/截止、原子检查点与条件发布。不要假借 sync account。
- 崩溃后只能从已提交位置继续；失效/被新租约抢占的执行器不能写结果或推进游标；派生存储失败不能被“可选缓存”策略吞掉。
- 清理仅针对明确终态/失效 generations，不删活跃 checkpoint 或未消费 watermark；保留重新全量重建与原读取回退。
- metadata/贡献持久化时间与响应新鲜度分开。不得因刷新 manifest 延长未经验证源数据的5分钟窗口。

### 3. 最后选择唤醒与刷新契约

- 先确认实际Cloudflare方案/库存/额度，再决定已配置Queue、独立执行器或分钟级兜底；不擅自开通付费服务。
- 当前同步200摘要/强制刷新语义先保留。若要用202构建中/过期快照展示/进度轮询，需要一起设计认证、代际抑制、错误与前端能力，并由用户确认。
- 首次启动、非法大对象、持续库存写入、Queue缺失或任务滞后时，必须诚实失败/显示未就绪或使用明确允许的旧逻辑，不返回成功空统计或把 stale 当 fresh。

## 本批验证

`tests/integration/incremental-summary-assessment.test.ts` 已加入 dashboard 测试入口：

1. 分片摘要相加与全局 canonical 统计不等价。
2. UTC 赢家不足以推导另一时区的赢家。
3. revision 不变但时间边界仍使摘要过期。
4. 当前50k紧凑投影的单JSON容器超过既有缓存上限。
5. 库存写入后旧 revision 的生产器不能发布缓存。

这些是未来方案的保护性反例，不是增量功能已落地的验收。不进行生产账号观测、上游操作或付费配置。下一步推荐实施**隔离原型**，而不是直接改线上缓存/刷新协议。

本批本地完整门禁通过 **459 个用例**，workerd/Node 冒烟、普通/selfhost 构建、主题及 Docker 源码边界均成功；两套完整依赖审计为0。SQL仍为bootstrap 44／首setup 50；首屏普通65.00KB业务／120.35KB全部JS gzip，selfhost65.01KB／120.36KB，未放宽80KB／140KB预算。源代码变化仅文档、测试入口和反例，不改变生产业务逻辑；远端工作流成功也不表示增量功能上线。
