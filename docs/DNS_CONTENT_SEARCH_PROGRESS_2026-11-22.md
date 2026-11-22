# 有效 DNS 缓存内容搜索（2026-11-22）

承接已发布 `940f72e`，修复 P1-21 剩余的 DNS 搜索路径。不调整 AES_KEY、不升级 schema v6、不重建缓存或业务表，也不借此把 Scanner 后台化或引入 FTS。

## 原缺口与实际接入

- 旧 `/api/search` 先从默认 DNSHE 域名列表按名称筛选，随后只取前 50 个候选的 DNS 缓存，导致名称不含关键词的 IP/TXT 无法命中。
- 当前顶部 UI 使用 `/api/domains/search`，该接口原本只检索名称；仅改旧 SearchService 无法修复实际界面。
- 新实现同时接入旧综合搜索、顶部聚合搜索、来源分页筛选与精确定位。DNSHE 分组不再对已由服务端筛好的页面追加名称过滤。

## 搜索契约

```text
GET /api/domains/search?search=<keyword>&search_in=domain|dns|all
GET /api/domains/page?provider=<provider>&search=<keyword>&search_in=domain|dns|all
GET /api/search?q=<keyword>&limit=1..100
```

- Catalog API 默认 `domain`，保留旧客户端的名称搜索语义；新 UI 明确请求 `all`。
- `dns` 仅匹配 DNS 数据字段，`all` 合并名称与 DNS 命中，同一个库存行只计一次。
- 八类名称来源保留；DNS 缓存覆盖 DNSHE、Cloudflare、DigitalPlat、DNSPod、阿里云、华为云、Vercel。自定义服务商不伪造 DNS，只保留名称/现有综合元数据搜索。
- Catalog 每来源最多返回 8 项，分页每页最多 100 条。综合搜索最多 100 条，候选按分值分桶有界，不在 JS 中构造所有综合搜索结果；SQL DNS 候选先排序，避免前几百个内容匹配遮住较晚的精确名称匹配。
- 搜索词最长 253 个 UTF-16 code units；无效范围、limit 或定位参数返回 400。请求要求原有认证，响应为 private/no-store。
- `dns_scope=valid_cached_records` 和条目 `dns_match` 标明缓存摘要；不是实时 DNS 查询或全部远端记录清单。

## 缓存边界与安全

- 仅查询 `api_cache:dns:<当前 domains_cache.id>`，严格校验 key 与现有库存 ID 对应，并 JOIN 现有账号；孤儿缓存、别的命名空间或非规范数字键不能冒充记录。
- 只接受未过期、≤512KiB、结构为 JSON 数组的缓存。JSON 在展开前嵌套 CASE 校验，非对象/无类型/非字符串 content/异常 name 元素跳过，不删除原数据或搜索时回源修复。
- SQLite JSON 处理在数据库侧执行，只投影类型、名称、匹配位置附近的 ≤512 Unicode 字符摘要及必要 ID；不把完整 DNS cache blob 下载到 Worker。
- 文本采用 ASCII 大小写折叠和 Unicode 字面包含，`%`、`_` 为普通字符，不是 LIKE 通配符。完整 IDN 的 ASCII 别名可匹配；父域名称原有中文/Punycode 部分搜索保持。
- **不承诺 DNS TXT 的 Unicode 全字符大小写折叠，也不承诺半个 Punycode 标签可按中文片段解码检索**；SQLite 没有跨运行时的该类自定义函数。
- 综合搜索只读取业务名称、状态、账号别名、日志 message/category 与 DNS 已知字段；不获取账号凭据，不检索 DNS `raw` 扩展或 settings/2FA/通知配置。
- 修正原始读取出口：D1 success=false 或缺少 results 数组会抛错，不能伪装成成功空结果。
- 没有新增搜索结果缓存；修改已缓存记录后新的请求会读到最新已保存内容。现有缓存 TTL/写入失效、跨旧 backend 混跑及 domain ID 复用的身份风险不被本批掩盖，仍需后续缓存/身份治理。

## 页面与定位

- 搜索下拉展示父域、记录类型/name/截断摘要，并说明有效缓存不代表实时完整 DNS。
- 点击使用来源、库存 ID、账号/自定义分组 ID；`focus_id` 必须与来源、账号、名称和状态筛选一致，不依赖同名域名的第一个结果。
- 缓存筛选分页的 cursor scope 包含 search_in；原 domain-only 游标 scope 保持。游标仍不是严格事务快照。
- 目标在定位检查后被删除，会报错而不是返回下一个域名假报定位成功。
- 页面请求不会让服务端附加字段覆盖客户端 filter/focus 控制状态；旧搜索响应被取消/代际校验抑制，显式库存刷新会使同一关键词重新检索。
- 跳转同步相关筛选与折叠状态，精确高亮实际库存 ID。多服务商只展开目标账号，不丢弃其他账号折叠偏好。
- 搜索点击仅定位，不自动打开 DNS 编辑器或发起上游请求。

## 验证

新增覆盖：内容独立命中、旧 50 行外命中、全部托管来源、类型/name/IP/TXT/中文/emoji、字面 `%`/`_`、坏/过期/超大/孤儿缓存、ID 去重、晚期高分命中、跨页总数/游标范围、同名不同账号定位、目标删除竞态、失败 envelope、认证与参数限制、控制状态保护。

真实 workerd/D1 和 Node/SQLite 冒烟在独立库中保存 Cloudflare 类型的假账号/DNS 缓存，验证综合/聚合/分页内容搜索及缓存变更后旧关键词不再命中。没有使用真实凭据或上游服务商请求。

独立 Chromium + Temp SQLite 中测试两个同名 DNSPod 库存，只让第二个拥有关键词 TXT；从顶部匹配后准确跳转到账号 2、库存 ID 1001，旧 ID 101 不可见。先折叠该账号并改筛到账号 1，再搜索仍能正确展开/高亮账号 2。控制台无 error，网络阻断桩统计上游尝试为 0；标签页与仅本次创建的 Node 进程已关闭。

检索使用现有 cache 主键索引限定命名空间，没有新索引/迁移，所以 bootstrap 44／首 setup 50 门禁保留。SQL 仍扫描候选 DNS JSON，名称/Unicode匹配仍需紧凑库存投影；这不是 FTS 或任意规模常数内存/CPU承诺。超大缓存不参与本批内容搜索，原数据保留。

真实账号内容、实时上游变化、生产大库存 CPU、视觉/a11y/CWV 均未冒充验收；发布结果以本批 SHA 的 CI、Worker、Docker 为准。

提交前最终验证通过：**443 个用例**、workerd/D1 与 Node/SQLite 缓存内容搜索冒烟、普通/自建前端构建、类型/主题/产物与 Docker 源码边界检查全部成功；两套完整依赖审计仍为 0。查询计划使用 `sqlite_autoindex_cache_1` 的 key 范围查找，再按库存/账号主键连接。实际入口预算为业务首屏 64.96KB／全部首屏 120.31KB gzip，未抬高 80KB／140KB；schema 仍 v6，SQL bootstrap 44／首 setup 50。
