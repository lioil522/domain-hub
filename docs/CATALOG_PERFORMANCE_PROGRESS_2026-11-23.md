# 大库存摘要与搜索性能（2026-11-23）

基线为 `4be5a85875485232673279c5475fa0724067ae6b`。先完成隔离基线，再修改业务代码；不引入 FTS、不新增表/索引/迁移、不更换框架或数据库。schema v6、AES_KEY、合法历史 `plain:` 读取和 44/50 SQL 预算保持。

## 测量方法与边界

`npm run benchmark:catalog` 使用同一套业务服务及 SQL：

- Windows、Node v24.15.0；项目锁定的 Miniflare/workerd，沿用 `wrangler.toml` 的兼容日期。
- 1,000／10,000／50,000 **托管行**，另外加入 1/8 数量的自定义行、八类账号、跨源重复、2% Unicode/Punycode、到期/永久/状态冲突和手动日期覆盖；10% 托管行有 DNS 缓存。
- 冷/暖/强制摘要、稀疏与广泛 ASCII 名称、Unicode、稀疏与广泛 DNS-only、all、来源/账号筛选分页、旧综合搜索。每条路径先预热代码，再独立重复 3 次；“冷”指摘要持久缓存缺失，不包括模块编译。
- Node 运行于独立内存 SQLite；workerd 运行于独立 Miniflare D1。固定业务时间，DNS 缓存有效。所有账号是假凭据，禁止上游 HTTP，没有生产数据库或登录。
- 耗时测量时不启用 CPU Profiler；另一次同路径调用单独采样业务 Worker 的 Inspector 目标 `core:user:catalog-perf`。保存原始 `.cpuprofile`、结果摘要与查询返回行数。
- 每次保存结果 SHA-256；基线与改动后的 **198/198** 次结果一致，包含计数、来源顺序、完整响应、游标和摘要期限。
- 新增 100 个种子 × 3 个时区的统计输出摘要，期望值在修改前记录，覆盖非法日期、首次来源、大小写/IDN/不可见字符、永久/过期、覆盖优先级和稳定排序；不能通过修改统计口径“优化”结果。

**不要误读指标：**

- 表格是本地端到端服务耗时，不是 Cloudflare 生产计费 CPU，也不是 CWV。
- `returnedRows` 是 Repository 返回的行数，不是 D1 `rows_read`、查询扫描行数或费用。
- Node `process.cpuUsage` 包含 SQLite/native 与 GC，Windows 小请求可因采样粒度显示 0，并非零 CPU。
- workerd 的采样 `timeDeltas` 有时把等待时间归到恢复执行的 `text/toJson` 等帧，`sampledActiveMs` 只用于诊断，**不能当 CPU 时间估算器**。保留原 profile，而不挑选某次较小值宣称满足 Free CPU 门限。
- heap 仅记录调用前/后，没有连续峰值采样或强制 GC。Node heap 含编排器/构建/之前 Miniflare 工作，不能当自建服务单请求内存；本批不宣称总内存峰值下降或 128MB 保证。

当前官方限制和 profiling 文档已检索；Free HTTP CPU 10ms／Worker 内存 128MB 的生产限制不能拿本地墙钟或开放 Inspector 的运行结果替代验收：

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/

## 实测：50,000 托管行 + 6,250 自定义行

同机中位数，毫秒，列为修改前 → 修改后。最后一列包括该路径所有 Repository 读取返回的行数。

| 路径 | Node 耗时 | workerd 耗时 | SQL 返回行 |
|---|---:|---:|---:|
| 冷摘要 | 707.10 → 392.75 | 760.85 → 418.75 | 56,776 → 56,776 |
| 暖摘要 | 0.26 → 0.28 | 3.68 → 3.55 | 1 → 1 |
| 强制摘要 | 730.48 → 387.17 | 753.49 → 400.66 | 56,776 → 56,776 |
| 稀疏 ASCII 名称 | 142.50 → 46.65 | 192.69 → 53.20 | 56,250 → 1,000 |
| 广泛 ASCII 名称 | 140.91 → 118.30 | 195.14 → 175.31 | 56,250 → 56,250 |
| Unicode 名称 | 179.95 → 49.65 | 223.93 → 59.12 | 56,250 → 1,000 |
| 稀疏 DNS-only | 117.08 → 38.59 | 188.73 → 39.64 | 56,251 → 2 |
| 广泛 DNS-only | 195.33 → 115.09 | 246.92 → 123.54 | 61,250 → 10,000 |
| 名称 + DNS 稀疏搜索 | 179.35 → 87.87 | 233.43 → 90.81 | 56,251 → 1,001 |
| 来源/账号筛选分页 | 96.12 → 52.11 | 185.62 → 78.17 | 56,461 → 7,354 |
| 旧综合搜索 | 174.97 → 109.66 | 236.50 → 118.79 | 56,251 → 1,001 |

10,000 托管行时，workerd 冷摘要 148.85 → 85.36ms，稀疏 DNS 35.50 → 9.26ms；暖摘要仍一次索引读，3.66 → 3.84ms 属本地噪声范围，不宣称加速。50,000 行 Node 冷摘要进程 CPU 中位数 891 → 484ms。

最后一次 workerd 调用后 heap 的观测上限约为：冷摘要 54.48MiB、广泛 ASCII 78.69MiB、Unicode 80.48MiB；这不是单调用峰值。早期基线曾观察到 >128MiB 的本地 heap，进一步说明不应把无生产资源限制的隔离运行当成生产规模保证。

原始诊断保留在批准的 Temp/opencode：

- 基线：`domain-hub-catalog-performance-j9vHmG/report.json`
- 最终：`domain-hub-catalog-performance-Bb31H0/report.json`
- 两者目录均含自包含业务 harness、适配器和各路径 `.cpuprofile`，无需访问真实账号。

## 实际改动

1. 普通 ASCII `toASCII` 与无 Punycode 的 `toUnicode` 不再逐标签 split/map/join；不可见字符未变化时不重复归一候选键。Unicode、异常 Punycode、大小写、全角点旧行为保持。
2. 查询先编译匹配器，复用 trim/lower 和查询 ASCII 别名。最终仍执行原三路字面包含判定。
3. 名称投影使用保守 SQL 预筛：普通 ASCII 的 `instr`，并保留全部非 ASCII、潜在 Punycode、NUL 名称交给 JS 判定。`%`/`_` 不变成通配符；Unicode 全面 case-fold 不能偷偷交给 SQLite。
4. 分页先下推来源/账号条件。DNS 先得到有效缓存命中，再按库存 ID 回读紧凑当前名称/归属，核对来源、账号、名称；不为 DNS-only 下载全名称库存，也不把改名后旧缓存命中绑定到替代名称。
5. 冷统计复用有上限的请求内日期 memo（≤2,048 条，包括 NaN），供期限边界和统计共享；不在全局留存日期/库存。去掉多份全量包装数组，按历史来源顺序访问。
6. 预警只保留稳定排序前 8 条；服务端月份桶只保留前 20 条，完整计数不丢。Infinity/负数/小数/NaN 的历史 slice 行为有回归。最近注册仍保留历史 sort，因为非法 created_at 会让比较器非全序，不能直接替换成堆并改变顺序。

所有优化均保留版本/写入原子失效、TTL/到期/90天/月界/RDAP 边界、稳定 ID 游标、定位与删除竞态校验、认证、失败 envelope 与有效缓存搜索范围。

## 复现与回归

```powershell
npm run benchmark:catalog
# 可选：短诊断或同机原始报告对照
$env:PERF_SIZES='1000,10000'
$env:PERF_REPEATS='3'
$env:PERF_COMPARE='<已保存的基线 report.json>'
npm run benchmark:catalog
```

基线对照要求相同 Node/platform/兼容日期与对应路径；结果语义变化直接失败，不设置容易受机器噪声影响的毫秒 CI 门限。完整基线测量使用默认三种规模。

`scripts/performance/catalog-harness.ts` 仅用于该工具，不导入生产 Worker 或 Node 服务，不新增公开测试端点。CI 增加语义摘要、稳定截断、转换等价、日期解析次数/容量、SQL 返回行复杂度、来源筛选和改名竞态回归；原并发启动与安全回归不删。

提交前 `verify:all` 全部通过：**449 个用例**、workerd/D1 与 Node/SQLite 认证/迁移/通知/摘要/搜索冒烟、Docker 源码边界、普通与 selfhost 构建均成功，两套完整开发/生产依赖审计为 0。实际普通首屏业务 65.00KB／全部首屏 120.35KB gzip，selfhost 为 65.01KB／120.36KB；80KB／140KB 门禁未放宽。日志中的 200KB 输出来自预算拒绝的故障注入用例，不是实际产物。bootstrap=44/44、first-setup=50/50；远端发布结果以本批 SHA 的三套工作流为准。

## 仍未解决

- 冷摘要仍读取全量紧凑库存/日期，去重映射是 O(n)，最近注册仍排序；不是任意规模常数内存/CPU。
- 名称任意子串 SQL 仍扫描；大量 Unicode/Punycode 名称或广泛匹配会把较多行送入 Worker。无新增索引，不声称 D1 扫描/计费行同步下降。
- DNS 查询仍扫描有效缓存 JSON；广泛命中仍返回全部匹配库存及有界字段，不是 FTS。
- 真实生产库存、计费 CPU/峰值内存和账号内搜索仍需登录/生产观测授权。本地改善不承诺 Free 计划在本规模内无资源超限。
- 下一步若需扩大库存能力，应评估增量持久摘要及能保留 Unicode/任意子串语义的检索投影，再决定 FTS；不能仅为降低本地数值放宽预算或迁移原库。
