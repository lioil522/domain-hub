# 隔离投影读端 SQL 优化（2026-11-24）

承接 `459d078`。本批只优化 `tests/prototypes/` 的查询与测试/测量入口，**不接入生产、不加表/索引、不改投影数据格式、密钥、后台任务、刷新协议或任何预算**。

## 原型内的改动

- 冻结原SQL为 `catalog-projection-sql-baseline.ts`，在同一封存generation上运行旧/新读端，不拿不同数据或缓存命中充当对照。
- 合并原本独立的页面/字段审计与统计聚合，避免两次展开同一份JSON。manifest、revision前后检查、编码字节/行数/ordinal/类型/过期检查仍保留。
- 缺失字段的 `json_type` 判定改用null-safe单次检查，不因优化把SQL NULL当合法字段；nullable字段仍必须明确存在且为integer或JSON null。
- materialized字段集只保留canonical、ordinal、时间与分类标志。窗口不再携带原始名称、alias、日期等宽展示列；这些字段在选出最终条目后按ordinal读取。
- canonical聚合同时计算完整计数、预警总数与first-finite位置，减少重复扫描和重复窗口。
- 十二个月的边界先一次性解析为数值列，再做范围连接，不对每个winner重复解析月份JSON。
- warning/月桶/recent最终JOIN之后再次明确ORDER BY，避免展示字段后取改变urgency、同日first-finite或首次来源顺序。有限recent的JSON字段顺序也保持原响应。
- 无效audit会令派生集为空，并由读端明确拒绝该generation；不会把空派生集当成功零统计。
- normal reader由5次查询调用变4次；有revision行时返回4个DAO结果行，无revision行时2行。非法注册仍读回完整首次候选并使用用户选择的旧比较器，不能声称该路径有界或NaN具体排序一致。

保留SQLite JSONB内部解析，但仍使用既有 `json_each/jsonb`，不将需要更新SQLite的 `jsonb_each` 引入默认路径。cache内容仍是JSON文本，格式/数量/编码预算不变。

## 对照与保护

`benchmark:projection` 增加baseline动作，交替旧/新查询先后顺序，同代同时间同offset，对照reference业务统计并核对重复/runtime hash。旧SQL仅在原型工具中存在，生产Worker namespace隔离断言仍有效。

回归继续覆盖60组语义语料，并对代表性同代数据同时读旧、新SQL。新增：

1. 删除每个必需字段后重算manifest编码字节，让byte/row数量仍匹配，确认类型/缺失审计本身拒绝，而不是仅靠长度差异失败。
2. 无效audit的SQL派生输出为空，应用层仍抛错，不返回成功零统计。
3. 不同urgency、相同日内不同秒、后续来源替换日期以及注册同时间，验证后取展示列与JOIN不能改变原稳定顺序。

字段白名单、原始输入不改/不截断、512KiB单值、128KiB默认page、64MiB整代、100k行、五分钟源窗口、RDAP/offset/revision拒绝与失败envelope继续执行。

## 测量与限制

同机1k/10k/50k托管行，另加1/8自定义行，每条动作重复3次。reference仍为原业务冷摘要；baseline/read为同一封存投影的旧/新SQL；stage仍完整捕获/写入，不是真增量。

本地Node CPU包含同步SQLite/native/GC；workerd墙钟包含本地D1等待。emulator reported rows/duration不是生产账单、计费CPU或峰值内存，不能因速度改善宣称按同等比例降低D1费用。

当前优化目标是减少重复解析/宽记录排序，不声称消除canonical/JSON/窗口全扫描。即使较旧原型更快，也不因此接入默认业务链路；仍需比较原服务及真正的数据库成本。

### 同代实测中位数（ms）

Node v24.15.0／Windows、项目锁定Miniflare/workerd、原兼容日期；每组3次，baseline/read在同代封存数据上交替先后。托管行之外另有1/8自定义行：

| 托管行／runtime | 原业务reference | 原型旧SQL | 原型新SQL |
|---|---:|---:|---:|
| 1k Node | 6.44 | 92.49 | 29.01 |
| 1k workerd | 16.28 | 94.04 | 29.53 |
| 10k Node | 55.23 | 947.37 | 315.45 |
| 10k workerd | 76.39 | 866.85 | 288.06 |
| 50k Node | 270.34 | 4,971.57 | 1,728.37 |
| 50k workerd | 348.35 | 4,768.91 | 1,659.47 |

50k Node读端进程CPU中位数约4,938→1,734ms，仍包含native SQLite，不代表Worker计费CPU。workerd本地reported rows_read约2,696,911→2,510,335，仅下降约6.9%；**不是耗时改善的同比费用保证**。两者仍高，当前新SQL也显著慢于原业务reference。

有限路径返回DAO行数5→4，约36KB内部结果／约28.8KB统计响应；非法日期仍有完整候选回读。18次新SQL、18次旧SQL、18次reference统计hash一致（固定时钟的正常库存样本），不能扩大成所有NaN排序一致承诺。

数据格式/构建未变：50k托管＋6,250自定义仍完整捕获，232个JSON页面、约28.73MiB整代。查询合并不构成delta/恢复方案，也没有省掉初始化成本。

最终原始报告在批准Temp/opencode的 `domain-hub-projection-performance-v7JMBS/report.json`，保留源bundle digest及同代旧/新调用记录。当前决策仍是 **不进入生产默认链路**。

Source delta、租约/恢复、删除/tombstone、通用清理、完整CatalogSummary元数据、非法日期最坏路径以及生产观测授权均不在本批完成范围。

## 提交前验证

完整 `verify:all` 通过 **474 个用例**，含15项原型回归；strict原型类型检查、workerd/Node冒烟、9组D1投影对照、普通/selfhost构建、产物隔离及Docker源码边界均成功，两套完整依赖审计为0。SQL仍44／50，普通首屏业务65.00KB／全部120.35KB gzip，selfhost65.01KB／120.36KB；80KB／140KB门禁没有放宽。

本批只有原型、测试、测量入口与记录变化；远端提交发布也不代表启用该读端。生产业务代码、AES_KEY、schema v6与200同步/强刷协议保持原样。
