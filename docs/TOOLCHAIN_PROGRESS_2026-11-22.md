# 开发工具链审计与升级（2026-11-22）

承接 `131c23e` 的安全收尾发布。本批仅升级构建/开发依赖、对应配置与发布门禁，不升级 React/Tailwind 主版本，不修改业务 schema v6、账号、存储格式或 AES_KEY 选择优先级。

## 审计范围

本次通过指定代理获取 npm 当前完整依赖审计，并分别检查 omit=dev：

| 依赖树 | 升级前完整树 | 生产依赖 | 升级后完整树 |
|---|---|---|---|
| 根项目 | 4 个 high 审计依赖项 | 0 | 0 |
| 前端 | 3 个 high、2 个 moderate 审计依赖项 | 0 | 0 |

这是 npm 按依赖节点汇总的审计项数，不是独立 CVE 个数。根项目集中在 Wrangler → Miniflare → sharp/undici；前端涉及 Vite/esbuild、PostCSS 的 nanoid/source-map-js、Tailwind 的 selector-parser。生产依赖没有已报告漏洞，不代表 Node 内置库、平台或应用已通过完整安全审计。

## 版本

| 工具 | 原锁版本 | 本批版本 |
|---|---|---|
| Wrangler | 4.127.0 | 4.166.0 |
| Miniflare | 5.20260826.0-alpha（未直接声明） | 5.20261119.0-beta |
| sharp（传递依赖） | 0.35.2 | 0.35.5 |
| undici（传递依赖） | 7.29.0 | 7.30.2 |
| Workers types | 5.20260828.1 | 5.20261121.1 |
| Vite | 5.4.21 | 8.3.8 |
| plugin-react | 4.7.0 | 6.3.0 |
| PostCSS | 8.5.24 | 8.5.33 |
| Autoprefixer | 10.5.4 | 10.7.0 |
| selector-parser（传递依赖） | 6.1.4 | 6.1.6 |

- 明确声明并固定 `miniflare@5.20261119.0-beta`：这是稳定 Wrangler 4.166.0 自身锁定的配套测试运行时版本，不依赖未声明的传递模块，也不把该 beta 版本称为独立稳定版。
- 同时更新到配套 `sharp@0.35.5`、`undici@7.30.2`，没有跨契约强行 overrides 或运行 `audit fix --force`。
- 保留 TypeScript 5.9.3、esbuild 0.28.2、Tailwind 3.4.19、React/ReactDOM 18.3.1；不引入 TypeScript 7、React Compiler 或 Tailwind 4 迁移。
- 核心工具使用精确版本，根/前端共享 TypeScript、esbuild 和 Node types；两套 `npm ci` 已验证锁文件可重新安装。
- Node 最低要求仍为 22.12.0，现有 CI Node 22 最新版本及 Docker Node 24 不变。

## Vite 8 与体积

- 迁移到 `build.rolldownOptions.output.codeSplitting`，不保留已弃用的 Rollup/manualChunks 配置名。
- 分包只根据明确依赖路径命名 React/icons/vendor，业务及 Scanner/弹窗不以框架名字隐藏。
- 显式保留旧 Vite 5 的浏览器目标（ES2020、Chrome87、Edge88、Firefox78、Safari14），不随工具升级静默提高浏览器门槛。没有新增 runtime API polyfill 或承诺所有旧浏览器业务兼容。
- CSS 继续采用 esbuild minifier，避免把 Lightning CSS 迁移与这批安全升级混在一起。
- 前端构建同时检查应用、Vite 配置及 tooling 的类型，Node types 明确声明；Docker COPY 源码边界检查也覆盖该配置。
- 体积门禁保留 generateBundle post 的静态闭包/懒代码检查，并在 writeBundle post 重新读取最终文件，避免 Rolldown 的 hash/runtime 重写令中间字节统计偏离实际产物。
- 补计 HTML 引用的独立公共首屏脚本（包括 `theme-init.js`）；拒绝外部首屏脚本或未打包的公共静态 imports，不让复制资源逃过预算。
- **没有抬高 80KB／140KB 门禁。** selfhost 最终实测：业务首屏含公共初始化脚本 **64,157 gzip 字节**，全部首屏 JS **119,504 gzip 字节**；其中入口模块为 62,872 gzip 字节。原日志不包含公共 theme-init，因此旧/新统计不可直接当作同口径性能提升。

## 发布与密钥保护

- 发布 Action 的 `wranglerVersion` 与验证/安装的 CLI 精确一致。
- `check:toolchain` 校验两套锁文件、明确 Miniflare 版本、CLI 一致性以及 Linux x64/arm64、Windows 原生包条目，加入 verify:all。
- CI 通过 `audit:dependencies` 必查根项目和前端的完整开发/生产依赖，报告任何已知非零级别风险或网络错误都不能忽略；没有改成仅审计生产依赖。
- 更换 CLI 前核对 Secret 列表的 JSON 格式；读取失败/格式错误/重复元数据时停止初始化，不能当作空列表生成替代 AES_KEY。GitHub 显式 key 优先、Worker 既有 key 保留、确认不存在才首次创建的优先级不变。
- Secret 解析器仅输出 present/absent，UTF-8 和输入长度有界，不在诊断中输出原列表内容或 key。实际 Bash provisioning 脚本在独立桩中验证读取失败、坏 JSON、既有 key、全新部署；不调用真实 npx/Cloudflare/gh。
- 既有 same-commit、artifact SHA/checksum、superseded-main 与双架构 smoke 门禁保留，没有跳过并发 Node 启动回归。

## 浏览器边界

使用新的 selfhost 产物与全新 Temp SQLite/测试密钥，在真实 Chromium 中完成初始化、退出/重新登录、空库存概览、账号页、按需打开/取消绑定弹窗、主题切换状态。控制台未报告 error，所观察 API 和脚本均来自 loopback，没有绑定账号或发起扫描/真实上游写操作；弹窗模块仅在打开后请求。

窗口不可见导致截图无法执行，因此**没有宣称视觉、完整可访问性、Core Web Vitals、生产账号或 Scanner 扫描 E2E 验收**。测试标签页和仅本次创建的 Node 进程已关闭，隔离资料留在批准 Temp 目录用于诊断。

本地全量验证与各提交的 GitHub CI、Worker、双架构 Docker 结果分别确认；没有把隔离冒烟当作生产验收。其他列表/查询、冷摘要 CPU、Scanner 流式/后台执行、身份模型和完整灾备仍不属于本批完成范围。

提交前最终验证：**417 个用例**、Worker/Node 类型与构建、真实 workerd/Node 冒烟（含 v5→v6 归档、通知、摘要缓存）、普通和自建前端、主题、源码边界与发布包检查全部通过。完整 npm 审计两套均为 0；新的 Secret CLI 字节上限、无效 UTF-8、输出脱敏与实际 provisioning Shell 桩回归也通过。SQL 预算仍为 bootstrap 44／首 setup 50。

远端 `56d41e8` 的 CI／Worker 成功，但 Docker 公共验证暴露了旧库双启动的 WAL 锁升级窗口，未发布新镜像。后续独立补救及真实结果见 [启动锁有界重试](./SQLITE_STARTUP_RETRY_PROGRESS_2026-11-22.md)；没有回退工具链或绕过门禁。

参考（本批读取当前文档及包元数据）：
- https://vite.dev/guide/migration
- https://vite.dev/config/build-options
- https://rolldown.rs/in-depth/manual-code-splitting
- https://github.com/vitejs/vite-plugin-react
- https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.166.0
