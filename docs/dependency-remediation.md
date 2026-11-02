# 依赖安全检查与后续修复政策

## 最新：获授权升级与双版本复验完成

2026-11-02获授权，2026-11-03收尾。安装与构建仅在独立副本进行，工作区回填已验证的两份清单/lockfile及部署工作流Wrangler pin；**根/frontend审计均为0漏洞**。这是当前公开advisory的审计结果，不保证未知漏洞不存在，也不授权生产发布。详见[升级验收](dependency-upgrade-acceptance.md)。

| 包 | 旧锁定版本 → 新锁定版本 |
|---|---|
| hono / @hono/node-server | 4.12.32 → 4.13.16 / 2.1.1 → 2.1.6 |
| wrangler / miniflare | 4.127.0 → 4.156.2 / 5.20260826.0-alpha → 5.20261102.0-beta |
| @cloudflare/workers-types / workerd | 5.20260828.1 → 5.20261102.1 / 1.20260826.1 → 1.20261102.1 |
| undici / sharp（上游传递） | 7.29.0 → 7.30.1 / 0.35.2 → 0.35.5 |
| vite / postcss | 5.4.21 → 6.4.5 / 8.5.24 → 8.5.32 |
| postcss-selector-parser（支持范围内更新） | 6.1.4 → 6.1.5 |

- 依据保存于新副本的`registry-version-evidence.json`、升级前两树审计及候选/最终审计。Hono与adapter peers兼容；Wrangler使用其配套Miniflare/workerd/types，构造器与`convertV4MiniflareOptions`仍可用，保留生产兼容日期和workerd/D1禁网回归。
- Vite 6.4.5超出本轮advisory的`<=6.4.3`受影响区间，选择该补丁版本而非强制跳Vite 8；插件声明最低4.7.0（原lock已是4.7.0），保留React 18.3.1、Tailwind 3.4.19和Node `>=22.5.0`要求。没有unsafe overrides、`audit fix --force`或降低审计等级。
- Node **24.15.0 / 22.23.4**分别全量通过：13道门禁、20组661项零失败、独立13项Chromium/React、主题108项、Worker/Node/前端类型及构建、自建模式和规模helper类型；另各12项隔离Node HTTP冒烟。只证明这两个实际版本，不宣称测试了所有满足engines的版本。
- 两树`npm ci`和`npm ls --all --json`退出0，没有missing/invalid peer。Windows根树保留3项`extraneous`诊断：lockfile声明的可选Sharp WASM子包`@img/sharp-wasm32`、`@emnapi/runtime`、`tslib`，其FreeBSD/wasm32父包被平台跳过；版本/optional/dev/上游关系已核对，原始诊断不隐藏，不称根树完全无诊断。前端树无此诊断。
- Node22首次最后一门因PowerShell包装器拆分逗号types参数失败；补引号后以`node22-final-*`整轮重跑全绿，原失败保留。HTTP冒烟脚本的Windows`--import` URL及退出等待问题已修正，初始失败目录保留，不改产品代码或弱化测试。
- 工作区`node_modules`、原运行产物/数据库/AES未更新；原服务仍用旧冻结构建。以后切换须独立授权、最新配对备份及发布验收，不直接安装并重启。

## 历史：2026-11-02只读审计基线

以下为升级前结果，当时未安装、升级或修改依赖/lockfile，security失败关闭；不代表上述已升级锁文件的当前结果。

| 树 | 受影响包（npm audit汇总，不是独立漏洞数量） | 汇总 |
|---|---|---|
| 根 | @hono/node-server、hono（moderate）；miniflare、sharp、undici、wrangler（high） | 6包，4 high/2 moderate |
| frontend | esbuild、postcss-selector-parser（moderate）；nanoid、source-map-js、vite（high） | 5包，3 high/2 moderate |

原始报告在opencode Temp的 `follow-up-all-verify-20261102/audit-root.json` 与 `frontend/audit-frontend.json`，为PowerShell UTF-16；用 `Get-Content -Raw | ConvertFrom-Json` 解析。包的开发/生产属性影响暴露面，但不能仅以“devDependency”忽略构建/本地开发服务风险。当时尚未完成兼容确认；原冻结证据不覆盖。

## 后续依赖修复仍须遵循的政策

1. 用新独立副本、冻结本轮两个lockfile和Node版本，刷新两树审计，逐条阅读advisory/受影响区间及直接/传递路径。
2. 优先评估Hono/Node adapter与Wrangler的兼容修复版本；确认Node engines、Worker bundling和HTTP鉴权/流式处理回归。传递包由其上游支持的版本解决，不盲目overrides。
3. Miniflare与workerd测试兼容须单独核验；历史audit建议`4.20250508.2`是表面major降级，**不是可信自动修复方案**。本轮用Wrangler配套5 beta并通过全部回归；后续同样确认上游修复和SDK兼容，不能牺牲workerd/D1测试。
4. 历史frontend audit建议Vite`8.3.5`为major升级，本轮选择受支持范围的安全补丁6.4.5。后续仍核验React插件、Tailwind/PostCSS、TS、Node engines、base路径/静态资源/主题和13项浏览器；传递包由支持的新上游锁定，保留变更范围。
5. 禁止 `npm audit fix --force`；先明确版本/批准变更，再更新清单/lockfile，检查无非预期大规模变化。刷新audit并运行完整门禁、浏览器/构建；审计网络错误也失败关闭。
6. 保留新旧audit、lockfile哈希、完整日志和回退兼容证据。只有两树门禁通过、真实staging/备份/审批完成才申请生产发布。新增授权前不安装，不降低audit级别、不跳过security job。
