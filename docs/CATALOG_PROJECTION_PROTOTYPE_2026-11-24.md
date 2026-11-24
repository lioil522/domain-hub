# 隔离贡献投影＋SQL 聚合原型（2026-11-24）

承接 `5aaa0d3` 的评估。**本批原型未接入生产**：不改 `src/`、`shared/` 或业务路由，不创建表/索引，不启用后台任务/Queue，不引入 FTS，不调整 AES_KEY、schema v6、首 setup 50／bootstrap 44、512KiB/5分钟及首屏预算。

本页记录 `459d078` 初版原型。后续仅原型读端的同代SQL优化见 [查询成本记录](./CATALOG_SQL_TUNING_2026-11-24.md)，不代表启用生产路径。

结论先行：原型验证了 SQL 端 canonical 归并、稳定截断与小结果返回的可行性；**当前查询和构建成本不适合直接替换默认摘要链路**。返回少量行不等于更快、更少 D1 扫描或更低费用，Node 还会被同步 SQLite 查询阻塞。

## 实际实现

代码只位于 `tests/prototypes/`，由测试和独立性能入口导入：

- `catalog-projection-capture.ts`：只读完整库存/账号元数据/日期层，捕获前后核对 revision。只查询面板字段，不读取/解密 API 凭据。仍是 O(n) 完整捕获，不是 delta journal。
- `catalog-projection.ts`：逐来源访问，使用共享域名/日期纯函数，投影到 `cache` 的随机独立 generation。记录 table、真实库存ID（纯函数 fixture 缺ID时使用该来源的测试索引）、managed account ID／custom group ID 与嵌套 account ID、原始名称/alias/状态/日期、canonical/candidate keys、来源序、解析后的时间。
- 分片默认≤250行及≤128KiB编码字节，最大不超过既有512KiB策略；原型另限定整个generation≤64MiB、总行数≤100,000。这是额外准入限制，不是放宽单值/摘要上限。按≤40条 statements 的 batch 写入。结果/失败 envelope、每页写入 changes、源 revision 都需确认；错误或过大对象不能标记ready，原始输入不截断/不修改。
- staging 的五分钟源验证窗口与最终统计时间分开。同 offset 内读端重新计算过期、90天预警和月份资格；metadata（尤其RDAP）到期、scope不匹配或revision改变后拒绝读取，不把manifest刷新成新时间继续使用。
- `catalog-projection-sql.ts`：页面范围索引读取 → 行格式审计 → canonical 聚合 → 最紧急日期及 first-finite 顺序 → 完整计数 → 前8预警／有限日期前6注册／每月20明细。
- SQLite JSONB 只在每条 SQL 内部作为一次物化的解析表示；cache仍保存可移植JSON文本，不保存二进制JSONB。已在本地 workerd/D1 验证功能；不是生产 D1 版本/费用验收。
- 非法首次注册仍用用户选择的旧日期解析比较器：SQL回读完整首次注册候选，JS旧sort再取6。该回退不是有界CPU/返回量，也不承诺NaN跨JIT具体顺序。
- 缺页、重复/缺失 ordinal、编码总字节不匹配、超限或非数组页面、缺失/错误类型字段、未ready/错误format都拒绝；manifest本身也限编码大小，不能变成成功空统计。
- 原型严格拒绝真值非字符串 expiry metadata、不合法身份和不完整UTF-16字段，保留原输入。这是明确的原型准入限制，不宣称所有历史异常数据兼容。

原型覆盖 **DashboardStats核心**，尚未生成完整 CatalogSummary 的 provider/account counts、root domains 与发布缓存协议。没有租约、逐步恢复、旧新键/tombstone、增量写入钩子、不可变数据的加密/签名封存或通用namespace清理器；不得把随机generation＋ready标记称完整持久执行器。

## 一致性与隔离

1. 先 canonical 去重，再做计数/截断；永久候选与真实日期/原始过期 OR 保持原口径。
2. 更紧急日期替换与第一次有效日期插入位置分离，同日/月桶tie不按实际秒值悄悄重新排序。
3. 首个truthy created_at保留来源/原字段，即使它是非法日期；自定义依旧不参与最近注册。
4. offset在生成时固定并严格校验，不能将UTC赢家简单平移复用到另一时区。将来多offset投影方案仍待评估。
5. revision在捕获、分片写入、ready发布及读取前后核对；这不是跨多请求事务快照。特权直改派生cache内容的完整语义认证尚未设计，当前主要审计结构/数量和受控生成流程。
6. 正常业务入口不导入原型；release-package新增断言，禁止原型namespace进入生产Worker包。Node的Docker源码边界继续验证。workerd原型测试路径仅存在于内存包装器。

## 验证范围

`npm run test:prototype:catalog` 包含独立strict类型检查和回归：

- 60组种子×offset×小/大语料的SQL／原函数对照，覆盖中文/IDN/不可见字符、手动/fallback、永久/过期、稳定来源与时间轴；NaN路径核对确定性统计与首次候选合法性，不捏造具体跨runtime排序保证。
- 10k有限日期库存只返回少量聚合DB结果，完整月计数不丢；EXPLAIN使用cache主键范围索引，同时仍存在JSON展开/窗口/临时排序成本。
- 时间推进但revision不变、RDAP窗口、offset、revision改变、缺页/坏JSON/坏字段、数据库抛错与success=false、过大行/过大摘要和不完整UTF-16。
- 真实隔离Repository捕获对照业务服务统计，custom group/account身份分离、manual覆盖RDAP、字段白名单与无原数据修改。
- workerd/D1内存包装器执行真实库存捕获和9组offset/source原型对照；没有公开生产端点，也没有服务商回源。

## 测量方法

`npm run benchmark:projection` 在全新内存SQLite与独立Miniflare D1中创建同一组假库存：

- 1k／10k／50k托管行，另加1/8自定义、八类账号、2%Unicode/Punycode、重复来源、日期覆盖与状态冲突。
- reference为现有强制冷摘要；stage包含完整源捕获＋投影写入；read仅从已ready投影聚合。每条路径重复3次，固定业务时钟，不在计时调用启用Profiler。
- 校验每次read与reference结果，并比较两个runtime及重复调用的hash。原型不包括业务鉴权、首次迁移、公开API或持续增量。
- Node CPU包括同步SQLite/native及GC；本地workerd墙钟包括D1传输/查询等待，不是生产计费CPU。
- `returnedRows/Bytes`是Prototype内部DAO返回量，不含stage前的完整捕获。另报capture的库存/元数据行和6次Repository查询；不能把stage的少量返回行误称完整构建不读库存。
- `reportedRowsRead/Written/Duration`来自本地D1/SQLite适配器。Node rows_read=0是占位；batch各statement可能复用batch时长，stage时长不能简单累加当SQL CPU。所有这些都不是生产账单或峰值内存验收。

### 初步结论

读端返回量显著缩小，但查询要完整展开投影，进行多次canonical/窗口/月份扫描。JSONB内部物化缓解重复解析，仍没有canonical字段索引。当前原型明显增加端到端读取耗时，不进入默认业务链路。

stage每次完整捕获、归一化并写入整代数据，仍有完整库存CPU/内存和存储写入成本；分片只约束每页编码大小，不让一次stage变成有界跨invocation工作。过去评估中的逐行写量公式不适用于此按JSON页面写入的实现，但较少物理cache行也不意味着虚拟展开/聚合读取或数据库CPU免费。

### 最终同机中位数

Node v24.15.0／Windows、项目锁定Miniflare/workerd，兼容日期沿用配置；每种规模3次。毫秒列依次为现有冷摘要／构建投影（含完整捕获）／只读投影：

| 托管行 | Node ms | workerd ms | 分片数／JSON总字节 | 有限读端DAO返回 |
|---|---:|---:|---:|---:|
| 1k | 6.97／15.63／94.68 | 17.12／33.62／95.12 | 5／592,018 | 5行／35,637字节 |
| 10k | 53.58／136.16／995.21 | 81.93／238.65／920.02 | 47／5,976,018 | 5行／36,328字节 |
| 50k | 279.31／649.46／5,265.69 | 359.93／1,098.02／4,752.36 | 232／30,123,286 | 5行／36,125字节 |

50k另有6,250自定义行，stage先捕获56,250库存行＋523元数据行（6次Repository查询）；投影自身另用9个调用／235条statements。30,123,286字节约28.73MiB，不是一个512KiB缓存对象。

本地workerd读端报告 `rows_read=2,696,911`、构建报告 `rows_written=701`（仅Prototype DAO，不含capture）；这是emulator返回，不冒充生产账单。Node的读端reported rows_read=0为占位；Node 50k读端进程CPU中位数约5,234ms，表明同步SQLite会阻塞自建进程。原型尚未测生产CPU/峰值，不能声称满足Free限制。

18次SQL读端均与当次原摘要一致，两个runtime及重复调用的统计hash也一致。正常参考/SQL结果均为约28,831字节DashboardStats，优势在减少传入Worker的DB库存投影，不是缩小浏览器响应；该优势不足以抵消当前SQL开销。

原始最终报告及自包含harness/adapter位于批准Temp/opencode的 `domain-hub-projection-performance-9hPig8/`，报告记录源bundle digest。当前结论为 **不进入生产默认路径**。

## 复现

```powershell
npm run test:prototype:catalog
npm run benchmark:projection
# 可选小规模诊断
$env:PERF_SIZES='1000,10000'
$env:PERF_REPEATS='3'
npm run benchmark:projection
```

必须在开发工作区安装两套锁定依赖；不是生产容器运行指令。脚本只使用批准Temp目录、内存数据库与新Miniflare，禁止上游网络，结束后关闭数据库/实例。原始报告、独立harness和adapter保留在Temp/opencode。

## 未进入的下一阶段

- 优化/拆分SQL、减少重复审计与窗口扫描，测实际D1计划/rows/执行时间；不能为“只返回5行”而忽视数据库成本。
- 若要专门投影表/索引，需单独设计追加迁移与首setup预算，而不是本批偷加DDL。
- source delta、删除/tombstone、账号/日期依赖、租约/检查点、恢复/清理、TTL旁路验证，以及非法日期最坏路径仍未解决。
- 当前200同步/强刷、五分钟兜底、后台与付费配置保持；是否接入必须基于进一步验证与用户确认。
- 生产账号内的计费CPU、峰值内存和D1费用仍需要明确的只读观测授权。

## 提交前门禁

最终 `verify:all` 通过 **471 个用例**，含12项原型回归；workerd/Node冒烟、9组workerd投影对照、普通/selfhost构建、主题/产物/Docker源码边界均成功，两套完整依赖审计为0。SQL仍44／50；普通首屏业务65.00KB／全部120.35KB gzip，selfhost65.01KB／120.36KB，未放宽80KB／140KB门禁。

原型namespace被生产Worker产物隔离断言保护。远端提交/CI/Cloudflare/Docker成功只代表本批测试/工具正常发布，不表示该原型被启用或已有增量后台。
