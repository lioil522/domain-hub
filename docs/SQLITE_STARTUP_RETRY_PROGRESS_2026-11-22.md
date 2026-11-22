# Node 初始 WAL 锁升级的有界重试（2026-11-22）

这是工具链提交 `56d41e8` 的独立远端补救，不撤销依赖升级、不跳过并发回归，也不调整 AES_KEY 校验策略。

## 实际远端发现

`56d41e87641bda15517631047200922a057535d2`：

- CI `45020776882` 成功；
- Cloudflare `45020776944` 成功；
- Docker `45020776901` 失败在公共 verify，**尚未进入任何架构的镜像构建/发布**。

失败用例：`concurrent real Node processes migrate v5 duplicates once and retain their complete archive`。Linux Node 22.23.5 在 `PRAGMA journal_mode = WAL` 返回 errcode 5 / `database is locked`。不能将另两套成功当作这个竞态不存在，也不能声称新 Docker 镜像已发布。

SQLite 官方明确：存在 busy handler 不保证它一定被调用；锁升级可能形成死锁时会立即返回 SQLITE_BUSY。因此此前仅提前设置 busy_timeout 的补救没有覆盖所有情况。

## 修复边界

- 只在**新打开、未进入业务事务的可写连接**中运行 `configureSqliteStartup`，先于 D1 适配、扩展 SQL、迁移、HTTP 和后台执行器。
- 先读取现有 journal mode；已经是 WAL 时不重复切换。
- 仅对启动期 WAL 配置的 SQLite BUSY（含同类扩展码）执行短暂异步退避；每次原生 busy_timeout 使用剩余预算，不重复完整等 5 秒。
- 总等待预算仍为 5 秒。超时、非 BUSY 错误、未实际接受 WAL 均抛错并关闭连接，不假报就绪。
- 成功后恢复连接级 busy_timeout=5000、synchronous=NORMAL 和 foreign_keys=ON。
- 没有重试密钥解密、数据库迁移、上游写入或普通 API 事务；缺/错 key 的只读预检仍先执行并拒绝启动。
- 不新增持久锁文件、不使用进程全局标记、不改 schema v6、不替换或重新加密历史数据。

## 测试客户端补救

连续压力运行还独立发现 Windows 随机 PORT=0 偶尔落在 Fetch 标准的禁用端口，导致客户端 `bad port`，而非应用启动失败。

隔离测试和 Node 冒烟统一使用仅接受 `http://127.0.0.1`/`http://[::1]` 的 Node HTTP 客户端：

- 保留实际 socket 请求、响应状态/头/UTF-8/JSON 验证、15 秒超时与 1MiB 响应界限；
- 禁止生产或非 loopback 地址，不能悄悄转向真实服务商；
- 不更改生产端口、浏览器端口限制或鉴权逻辑，也不重跑到随机挑出“好端口”为止；
- 真实浏览器验收仍使用 Chromium，不通过该客户端伪造。

## 本地证据

专项 30 个用例通过，覆盖真实外部读锁、原有短 EXCLUSIVE 锁、双新安装、双 v5 归档迁移、立即 BUSY 的有界重试、永久 BUSY 到期拒绝、非 BUSY 错误不重试及已有 WAL 参数验证。四类真实进程场景连续 **20 轮**通过。

完整构建与新提交的 Linux CI/Worker/Docker 结果分别记录；在远端补救成功前，不能把本地 Windows 压力测试当作 Linux 生产验收。大型库存/长期外部读锁仍可能超过预算，应在维护窗口处理，而不是无限等待或删库。

补救提交前全量验证通过：**424 个用例**、workerd/Node 运行时冒烟、普通与自建前端构建、产物/源码边界/主题检查均成功；根项目与前端完整 npm 审计仍为 0。只改 Node 启动和隔离测试客户端，保留全部原有密钥、并发迁移和拒绝启动回归。

参考：
- https://www.sqlite.org/c3ref/busy_handler.html
- https://www.sqlite.org/wal.html
