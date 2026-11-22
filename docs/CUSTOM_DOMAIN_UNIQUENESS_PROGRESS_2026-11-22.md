# 无账号自定义域名唯一性与历史完整归档（2026-11-22）

第 3 项，承接请求边界提交 `7c601b9` 三套远端成功验收。用户明确选择：保留最早 ID 当前行，其余重复原行完整永久归档，不猜测合并日期或备注。

## 写入与唯一约束

- schema 从 v5 **追加 v6** `unassigned_custom_domain_uniqueness`；不重建业务表、不改写 v1–v5 的版本记录、不更换 AES_KEY。
- 新增部分唯一索引 `idx_custom_domains_unassigned_unique`：`(group_id, full_domain) WHERE account_id IS NULL`。
- 无账号 upsert 改为单条 `INSERT ... ON CONFLICT ... WHERE account_id IS NULL DO UPDATE`，不再“先查后插”；并发写依赖数据库约束，不依赖进程内锁。
- 同组、同账号范围内重命名碰撞返回 409，原记录和摘要版本同事务回滚；按 ID 更新使用单条限定 ID/group 的 UPDATE，不因查后被删而假报保存成功。
- 不同分组／不同账号仍可拥有同名域名。索引以现有精确存储值为身份；正常接口仍归一为小写、去尾点。本次不擅自合并 raw SQL/旧备份中的不同大小写、尾点或 IDN 表达。

## 历史记录迁移

v6 的单一 D1/SQLite batch 包含：

1. 将无账号、同分组同域名、非最早 ID 的所有行归档；
2. 仅在归档 value 与完整原行快照精确相同时，从当前业务表移走重复行；
3. 同事务更新摘要库存版本；
4. 建立唯一索引；
5. 写入 v6 版本记录。

任一步失败（包括忽略/损坏归档的触发器、唯一索引、晚期 ledger 写入）均回滚整个 batch。独立连接竞争只接受另一个执行器**已经提交的完整版本历史**，不会通过重新跑到偶然成功或跳过失败记录掩盖问题。

### 永久归档存储

为保留严格首次启动 SQL 预算，归档复用现有 `settings` 的专用内部命名空间：

```text
schema_v6_custom_domain_duplicate:<原行 ID>
```

- 无 TTL、不属于 cache/session/cfg，不因删除服务商分组而级联删除。
- 保存原 ID、分组/账号、域名、注册/到期日期、备注、原 updated_at，以及 operator 添加的字段；记录保留的 survivor ID。
- 每个字段保存 `{storage, value}`：NULL 独立标签，整数以字符串防止 JSON 精度丢失，实数用可 round-trip 数值文本，Blob 为完整 hex 字节，文本原样保存。
- 支持读取最多 128 个字段并分段构造 JSON；字段无法完整读取时停止，不截断归档。
- 已有同名归档键或错误同名索引会阻断迁移，不覆盖可能属于用户的内容。
- 若存在未知子表外键引用或 `custom_domains` 自定义触发器，发现重复时停止自动迁移，避免 DELETE 触发扩展数据丢失；需完整备份后在维护窗口明确处理。
- 完成后归档是原状态凭证，不会随当前行续期或编辑同步改变，也不自动合并回业务表。
- 升级应使用维护窗口，禁止在迁移期间并发手工 DDL/修改归档或伪造版本历史；任意外部数据库修改不在应用事务保证范围内。大规模异常库存或超出 D1 行/执行限制时会停止，不截断数据。

## 读取和备份

受原会话鉴权保护的分页接口：

```text
GET /api/custom-groups/domain-conflicts
GET /api/custom-groups/domain-conflicts?cursor=<page.next_cursor>
```

响应为 `archives`（key、archived_at、payload）与 `page`。每页最多 20 条，归档 payload 累计 ≤512KiB，超大单条明确要求完整数据库导出，**不跳过或删除**；private/no-store，不提供未登录读取。

恢复原字段时按 storage 类型解码，数字字符串不能先转 JavaScript Number；Blob hex 需还原字节。v6 不允许把所有重复行原地重新插回同一身份，必须由管理员显式选择当前记录、解决目标身份/ID 冲突。没有自动灾备恢复承诺。

**现有业务 JSON 备份仍不含 settings/扩展字段，所以不包含这些永久归档。** 请另外分页保存完整归档，或保留完整 SQLite/D1 导出及原 AES_KEY；仅业务 JSON 不能当作本次迁移后的完整数据备份。完整数据库包含这些 settings 原始记录。

## 预算与验证

为给新增唯一索引腾出一次 SQL，首次发现 ledger 不存在并成功创建后不再立即冗余重读它。并发插入历史由后续事务唯一 claim 及失败后的严格历史读取证明；已有当前 schema 仍只读一次 ledger。

Fresh 批量记录历史时，先物化读取现有 ledger；任何非空历史都会在同一 batch 中触发 INTEGER PRIMARY KEY 约束拒绝并回滚，避免竞争者只写入未来版本时被错误补齐或假报就绪。此校验不增加 prepared SQL 数量。

实测仍为 **bootstrap 44/44、首 setup 50/50**；门禁没有放宽。新增独立 fresh facade 竞争、创建 ledger 时出现未来版本、失败 batch 不能假报成功等回归。

专项覆盖完整旧字段、扩展 Blob/int64/real/NULL、最早 ID 不变、独立迁移竞争、40 次 upsert 稳定 ID、碰撞回滚、归档键冲突、未知引用/触发器拒绝、分页/权限/超大记录、删除分组后仍可读归档。真实双 Node 进程同时升级 v5 重复库后均就绪且只产生一次归档；并发启动/短锁/v5 迁移连续 10 轮通过。

workerd 冒烟在隔离 D1 中构造 v5 重复库存，再触发实际迁移并读取归档。所有测试使用隔离库，不修改生产账号、域名或密钥。实际生产是否存在重复、归档内容及账号内读写仍需受控登录验收；发布状态由本提交的 CI、Worker 和双架构 Docker 结果确认。

全量验证修正了旧通知测试夹具的 v4 版本断档（原夹具删除 v5 却留下 v6），没有跳过测试。实际 workerd/D1 暴露 `_cf_METADATA` 受保护表不能做外键 PRAGMA 检查；依赖检查现在先物化业务表清单，排除平台/SQLite 内部表，再验证全部业务外键，不减少对 operator 扩展的保护。

提交前最终全量验证成功：**392 个用例**、workerd/D1 v5 完整归档迁移（含扩展 Blob/real）、Node/SQLite 运行时冒烟、普通与自建前端构建、类型/主题/发布产物/Docker 源码边界检查全部通过。归档比较显式使用 BINARY，不会因 operator 的 NOCASE settings collation 把内容大小写损坏误认成相同快照；专项回归验证整批回滚。
