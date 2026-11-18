# CI 发布门禁：2026-11-18

本批承接 `18b81de` 的 Docker 修复；用户已确认上一批镜像构建和运行成功。下述验收在提交前的本地隔离环境完成，未访问或改写生产数据库、密钥、路由配置。用户随后授权将本批提交并推送 `main`；实际提交、推送及自动部署状态以 Git / Actions 记录为准。

## 修复范围

- CI、Worker 部署、Docker 构建均调用同提交的 `verify.yml`，不向验证工作流传递发布 secrets。
- 共同验证包含架构、Worker/Node 类型与构建、全部回归、自检、普通/selfhost 前端、主题、Wrangler 配置、双运行时及 Docker 源码边界检查。
- Actionlint 1.7.12 检查 YAML 结构、表达式与可复用工作流；CI 下载固定版本并验证固定 SHA-256。当前未启用 ShellCheck/Pyflakes，不宣称验证所有 shell 语义。
- 所有外部 Action 固定完整 commit SHA；checkout 固定 `github.sha`，不保留 Git 凭据。
- Worker 发布作业 `needs: verify`，Docker 构建 `needs: verify`，多架构清单 `needs: build`。验证或架构冒烟失败不能进入正常发布链路。

## Worker 产物链路

```text
verify:all
  → 普通前端 + Wrangler dry-run Worker 打包
  → manifest（提交 SHA + 每个文件 SHA-256）
  → 上传本次 run 的 worker-release-<SHA>
  → selfhost 构建成功，验证作业才完成
  → deploy 下载同次验证产物
  → 校验 SHA / 文件集合 / 校验和 / 原配置
  → 注入 D1 和既有路由检测结果
  → 绑定后配置 dry-run
  → deploy release/worker/index.js --no-bundle
```

- 普通前端在 selfhost 覆盖 `frontend/dist` 前打包；即便产物已上传，后续 selfhost 构建失败仍阻断部署。
- 发布不重新构建前端或 Worker，静态资源也从已验证包复制。
- 包校验拒绝不同 SHA、缺失/新增文件、内容变化、路径穿越、符号链接；打包拒绝覆盖非空目录。
- 额外的 `check:release-package` 用真实 bundle/assets 重建**没有应用源码**的下载/部署目录，执行 `--no-bundle --dry-run` 并比较输出 Worker 字节。该本地检查使用合成 SHA，不将未提交工作冒充已发布提交。
- 下载不指定其他 run/repository；没有新增高权限 `workflow_run` 或 `pull_request_target` 流程。校验和是内容一致性检查，不是独立签名或供应链完整证明。

## 发布并发与保护

- Worker 生产写入串行，不在部署/密钥同步中途自动取消；持锁后检查远端 main，旧 SHA 跳过后续部署步骤。
- Docker 同 ref 串行；多架构清单发布前再次检查 main，旧 main 不更新 `latest`。架构摘要仍可能已上传，但不会挂成旧的 `latest`。
- 禁用 metadata 的 semver 自动 `latest`，仅 main 的显式 raw tag 更新 `latest`；版本 tag 保留完整版本及主次版本 tag。
- freshness 检查不是 main 与远端发布之间的原子锁。检查后 main 若前进，当前作业可能先完成，后续新作业再发布；同目标串行和再次检查避免排队旧任务在新版本之后回退 main。
- D1 列表/创建错误、重复匹配或无效 UUID 中止部署，不再将查询失败解释为空列表后创建替代库。

## 本地验收

- `npm run verify:all` 与额外 selfhost 构建通过，223 个不变量/集成测试全部通过（原有 192 个 + 本批 31 个）；完整日志保存在本地临时目录。
- `check:release-policy` 包括真实 YAML 解析及正反例：移除依赖、忽略失败、`always()` 绕过、跳过验证、删除验证子链、跨 run 下载、重新构建、绕过 freshness、自动附加 latest、可变 Action 标签，以及包损坏/缺失/注入/越界等。
- 隔离 workerd/D1 和 Node/SQLite 完成未认证 401、首次初始化、会话读取、空域名契约检查；Node 还检查首页与健康接口。
- 真实产物 source-free no-bundle dry-run、Docker COPY 源码隔离构建、Windows Actionlint 1.7.12 通过；CI 使用的 Linux Actionlint 归档已实际下载并核对固定校验和及可执行文件入口，未在本机执行 Linux 二进制。所有本地网络下载使用 `http://127.0.0.1:10808`。

## 边界与下一批

- 本地验收时本机没有 Docker；没有将本地测试宣称为本批真实 Linux 双架构镜像、GitHub 上传/下载或云端发布成功。远端结果以本批提交对应的 Actions 为准。
- 同一 main push 会在 CI、Worker、Docker 各执行一次共同验证。这是避免跨工作流高权限产物消费的取舍，暂未做跨 run 复用优化。
- 没有设置 GitHub 分支保护、Environment 审批、staging、发布后业务 E2E、依赖审计阻断或体积预算。若仓库已有 required status，应检查验证作业名称变化。
- AES/可选 Secret 仍沿用既有发布后同步顺序，未修改稳定密钥或重新设计 secret 管理；原有 secret 查询失败与缺失判定、首次上线窗口等仍需独立审查。不要把本批发布门禁理解为已完成全部生产发布安全设计。
- Docker 保留既有源码构建、原生架构冒烟及按摘要发布方式；没有将 Dockerfile 基础镜像固定 digest，也没有改造第二次 build 为直接推送本机冒烟镜像。
- 通知 outbox、严格平台响应验证、失败重试/DLQ、到期检查轮转另起一批。本批未改变数据库 schema、提醒去重标记或发送语义。
