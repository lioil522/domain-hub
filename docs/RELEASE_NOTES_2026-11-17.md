# 2026-11-17：后续修复发布说明

用户已授权将已完成的后续修复提交并推送 `main`。本文说明发布范围；实际提交、推送和 CI/线上部署结果以 Git 与 GitHub Actions 记录为准，不能将本地测试当作线上验收。

## 发布范围

- 已有本地提交 `e0d3e81`：Scanner 未知结果、限流重试、连续完成断点和真实同步结果。
- 数据库版本迁移及索引一致性：Worker/Node 共用迁移器，当前 schema v4。
- 业务备份校验、密钥指纹、真实冲突预览；超过 500 行的持久 staging 分段恢复。
- 持久同步工作队列、失联回收、暂停/重试/取消、凭据变化保护及上游读取期限。
- 续期结果不确定时只读核对，防止盲目重放。

## 发布前验证

- `npm run verify:all` 再次通过，192 个不变量/集成测试全部通过。
- Node 构建及 workerd/Node 本地恢复、认证与分段恢复冒烟已通过。
- 未测试真实服务商凭据、生产数据库、真实云端 Queue 或完整浏览器 E2E。

首次推送 `caf69fd` 后，Worker 自动部署在 TOML 解析阶段失败：新增分钟触发器前的一条 Cron 缺少分隔逗号。后续修复补齐逗号，并将 `wrangler deploy --dry-run` 加入 `verify:all`，检查配置和实际 Worker 打包但不执行云端部署。后续提交及部署结果以 Git/Actions 记录为准。

`491aec3` 的 Worker 部署与 CI 已通过，但自建镜像构建暴露了遗漏：前后端 Docker 构建阶段都没有复制新增 `shared/`。后续修复补齐两处 COPY，并移除运行时默认 SCHEMA_FILE，让旧数据卷走版本迁移器。`check:docker-inputs` 重建 Docker COPY 的源码集合并验证 selfhost/后端构建，不依赖完整工作区隐式提供源码；它不等同于真实 Linux 容器构建和运行，最终镜像结果仍以 Docker workflow 为准。

Docker 修复后再次通过全量验证（192 个用例），并用打包后的 Node 布局验证旧 `dnshe.db` 数据卷能升级、域名与 DNS 状态保留。本机没有 Docker，未将源码边界检查宣称为真实镜像构建成功。

## 升级重点

1. 前后端一起更新，保留原 AES_KEY，升级前备份数据库和密钥。
2. Worker 必须发布 `* * * * *` 分钟触发器；漏掉调度配置不能解决关页后的排队恢复。Queues 为可选加速方式，本次没有创建云端资源。
3. 旧失联任务被标记失败并提供重试，不会假装完成，也不删除业务数据来解卡。
4. 分段恢复初版最多 10,000 行、8MB，绑定原登录会话；没有自动 ID 映射或完整灾备。
5. 普通服务商 SDK 的大列表聚合仍有预算限制；分钟级兜底推进大账号较慢。未将所有 P1/P2 问题宣称为已完成。

详细历史记录：

- [Scanner 与结果传播](./PHASE_B_PROGRESS_2026-11-17.md)
- [数据库迁移](./SCHEMA_PROGRESS_2026-11-17.md)
- [备份安全](./BACKUP_PROGRESS_2026-11-17.md)
- [分段恢复](./STAGED_RESTORE_PROGRESS_2026-11-17.md)
- [同步队列与解卡](./SYNC_QUEUE_FIX_2026-11-17.md)
- [CI 发布门禁（2026-11-18）](./CI_RELEASE_GATE_PROGRESS_2026-11-18.md)
- [通知 outbox（2026-11-18，本地验证阶段）](./NOTIFICATION_OUTBOX_PROGRESS_2026-11-18.md)
- [概览统计口径（2026-11-18，本地验证阶段）](./DASHBOARD_STATS_PROGRESS_2026-11-18.md)
- [前端入口体积与加载门禁（2026-11-18）](./FRONTEND_ENTRY_PROGRESS_2026-11-18.md)
- [八类域名分页与全量摘要（2026-11-19）](./DOMAIN_PAGINATION_PROGRESS_2026-11-19.md)
- [摘要请求去重与原子缓存失效（2026-11-19）](./SUMMARY_CACHE_PROGRESS_2026-11-19.md)
- [Node 密钥与启动就绪安全（2026-11-22）](./NODE_KEY_STARTUP_PROGRESS_2026-11-22.md)
- [CORS、可信代理与初始化授权（2026-11-22）](./REQUEST_BOUNDARIES_PROGRESS_2026-11-22.md)
- [自定义域名唯一性与完整归档（2026-11-22）](./CUSTOM_DOMAIN_UNIQUENESS_PROGRESS_2026-11-22.md)
- [开发工具链审计与升级（2026-11-22）](./TOOLCHAIN_PROGRESS_2026-11-22.md)
- [Node WAL 启动锁的有界重试（2026-11-22）](./SQLITE_STARTUP_RETRY_PROGRESS_2026-11-22.md)
- [有效 DNS 缓存内容搜索（2026-11-22）](./DNS_CONTENT_SEARCH_PROGRESS_2026-11-22.md)
- [大库存摘要与搜索性能（2026-11-23）](./CATALOG_PERFORMANCE_PROGRESS_2026-11-23.md)
- [冷统计单遍归并与注册排序（2026-11-23）](./SINGLE_PASS_STATS_PROGRESS_2026-11-23.md)
- [增量持久摘要可行性评估（2026-11-23，尚未接入生产）](./INCREMENTAL_SUMMARY_ASSESSMENT_2026-11-23.md)
- [隔离贡献投影＋SQL聚合原型（2026-11-24，尚未接入生产）](./CATALOG_PROJECTION_PROTOTYPE_2026-11-24.md)
- [隔离投影读端SQL优化（2026-11-24，尚未接入生产）](./CATALOG_SQL_TUNING_2026-11-24.md)
- [固定时区按域名预先合并：构建和读取成本对照（隔离原型）](./CATALOG_FOLDED_PROJECTION.md)
- [按受影响域名重算：改名、删除与日期依赖（内存实验）](./CATALOG_AFFECTED_KEYS.md)
- [事务内变更捕获与依赖索引写入成本（隔离实验）](./CATALOG_WRITE_CAPTURE.md)
