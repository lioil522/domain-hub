# 授权依赖升级验收与保留边界

> 本文是依赖升级阶段的历史验收。2026-11-04 的 fork 部署调整已移除手填 SHA/production 环境依赖，保留 verify/security、已有 D1 身份和 AES 元信息保护；依赖版本与下述证据不变。当前部署见 [README](../README.md)。

2026-11-02用户授权升级，2026-11-03收尾。**两树npm audit为0漏洞，Node22/24完整复验通过；依赖清单、锁文件和Wrangler pin已回填，原服务未切换。** 本轮不部署云端、不自动续期或启用运行配置。

## 版本与范围

- Hono **4.13.16**、Node adapter **2.1.6**；Wrangler **4.156.2**、配套Miniflare **5.20261102.0-beta**、Workers types **5.20261102.1**。
- Vite **6.4.5**、React插件声明最低 **4.7.0**、PostCSS **8.5.32**、传递selector-parser **6.1.5**；保留React18/Tailwind3和既有Node engines。
- 不采用审计的旧Miniflare降级或强制Vite8升级，不用unsafe overrides或`npm audit fix --force`。版本依据、旧/新对照与树诊断见[依赖修复记录](dependency-remediation.md)。0漏洞指本轮公开advisory审计，不是永久安全保证。
- 只回填`package.json`、`package-lock.json`、`frontend/package.json`、`frontend/package-lock.json`和`.github/workflows/deploy.yml`，另更新说明。生产/测试源码与预算不变；部署工作流仍保留手动SHA、production审批、security/verify、已有D1和原AES元信息保护。

## 完整复验

| 实际Node版本 | 清洁安装/审计/树/版本等13道门禁 | Node/workerd测试 | Chromium/React | 主题 | Node HTTP冒烟 |
|---|---|---|---|---|---|
| 24.15.0 | 全部退出0，双树0漏洞 | 20组661项，零失败/取消/跳过 | 13项 | 108项，失败0 | 12项 |
| 22.23.4 | 整轮最终全部退出0，双树0漏洞 | 20组661项，零失败/取消/跳过 | 13项 | 108项，失败0 | 12项 |

每行独立重跑，不把重复运行累加为新增测试。包含Worker/Node类型与构建、Node六组原自检、前端默认与selfhost构建/类型、规模helper严格类型。Node22可执行文件与PATH子进程身份已记录；未测试所有满足engines的版本。

12项HTTP冒烟用新合成SQLite/AES、随机本机端口、Cron禁用和出站fetch阻断，验证真实Node adapter下的health、首页/CSP、HEAD、ETag304、哈希资源/缓存、404/SPA、405/坏编码及鉴权/双编码不绕过。只终止新测试子进程，不访问原数据库或真实账号。

Windows根依赖树的3项锁定可选Sharp WASM子包`extraneous`诊断已解释并保留；没有missing/invalid peer，前端无此诊断，不能将根树描述为完全无诊断。Node22初轮scale-types因PowerShell拆逗号参数失败，改引号后整轮重验；证据后处理的可选包诊断和冒烟启动脚本初始失败同样保留，不覆盖旧日志、不放宽产品检查。

## 冻结证据

独立目录：`C:\Users\15017\AppData\Local\Temp\opencode\dependency-upgrade-verify-20261102-TY29X5`。508文件新副本使用自身依赖，无原库/AES或依赖目录链接。

- `node24-gates.json`、`node24-*`与`node24-snapshot/receipt.json`；Node24快照在Node22安装/构建前保存。
- `node22-gates.json`及失败`node22-scale-types.log`保留；最终`node22-final-gates.json`、`node22-final-*`与`node22-final-snapshot/receipt.json`。
- `node22-toolchain-identity.json`、两份`node*-adapter-smoke-receipt.json`及独立测试目录日志；Node22工具链只在新副本内。
- `source-baseline.json`、`promotion-precheck.json`：491非Markdown文件中仅上述5份授权文件变化，其余源码/测试/配置与原验收一致；回填前检查无介入改动，回填后字节哈希匹配。
- `acceptance-receipt.json`、`final-source-hashes.json`、`final-documents`：本轮新收据、工作区源码/文档哈希及日志/产物记录。旧661项及618项冻结副本、原验收/文档收口收据不改写。

## DNSHE确认与主动暂缓

用户确认**每分钟30次、同账号多Key共享、到期前180天内续期免费**，按[契约记录](provider-contract-evidence.md)接受。当前调度仍按Key，**未落实同账号跨Key共享额度**；可靠账号主体/映射仍缺，不按别名猜归属，不声称已有多Key总额度保护。续期窗口默认0不变，确认事实不是续期写授权。

DigitalPlat、HuaweiCloud及其他服务商调查、实际云端staging/容量/部署按用户要求暂缓；已有保守校验和回归不删除。这些不是本轮继续执行任务，也不以离线通过批准上线。

## 原服务与安全约束

最后只读检查 **2026-11-02 23:58:53 +08:00**：原PID **22636**监听8787，health/首页与5个静态资源均200且哈希匹配，仍用原bundle `1D62A02257721888EAF512A64DB3D62F1129028B28C5814B84B96520FB9FA36B`；见`service-preserved.json`。

工作区原`node_modules`、原产物、数据库/AES、密码恢复和用户活动保持；未打开原库/AES，不声称用户期间全表未变。未重启/切换原服务、提交/推送/部署、真实同步/续期/删除、清历史或恢复Scanner。D1/external各40、DNSHE现有30/60s、全局≤25流、500片/账号/轮和手动两分钟不放宽；将来发布按[发布回退手册](release-and-migration.md)独立授权。
