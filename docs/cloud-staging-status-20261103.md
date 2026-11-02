# 2026-11-03 云端发布前状态（小样本功能验收通过，生产仍阻断）

这是状态记录，不是发布授权或通过收据。生产站仍是 `https://domain.licacv.com`，本轮未部署生产、未触碰原本地服务，也未执行真实服务商操作。

## 已验证

- 原完整D1 SQL已在受限本机目录恢复：11张原表，完整性及外键检查通过，自增删除高水位保留。
- 原AES经手动加密恢复工作流安全备份；28个原账号Secret与原2FA密文均成功解密。SQL、原AES、恢复私钥均未上传staging或写入仓库。
- 原数据本机增量迁移新增9张表，原行与序列不变，重复迁移幂等；提供的业务JSON预览无新增/覆盖/删除/冲突，强制审计失败回滚。
- 已核查Cloudflare账号全部7个Zone，原Worker仅有 `domain.licacv.com/*` Route；未转换Custom Domain。`wrangler.toml`显式保留该Route，并关闭workers.dev与预览入口；原compatibility_date及两条Cron配置未更改。
- 恢复流程提交 `2e337316b6d89e9eecf73fca0d258935b3224b18` 的CI、GHCR和手动加密恢复工作流均成功。

## 独立staging及未通过项

- Worker：`domain-hub-staging-20261103-a8923712`；D1：`24574fec-2b22-46c2-ac6f-3f928d42b83d`（非生产库）。
- 代码取自上述恢复流程提交；防护封装脚本SHA-256：`1d3c39edeba2343cfea38f465a6f93a804686c1c6374e5e653af777a80ba2353`。
- 云端仅合成旧schema/数据及独立测试密钥；不绑定生产Route、不设Cron、预览关闭。API另有访问门禁，全局出站fetch不可改写并拒绝全部出站，scheduled处理器拒绝执行。
- 本机workerd的迁移/门禁/出站预检通过，原生出站请求为0；完整静态资源本机测试也通过。
- 早期云端D1只读检查确认是11张合成原表；workers.dev静态资源及防护探针返回HTTP500/1101，重新应用同脚本/静态配置并保留测试密钥后仍失败。当时根因未定位，未以放宽防护换取通过；后续通过授权Custom Domain完成的验收见下节。
- 早期远端应用迁移、登录/2FA、预览/导入、强制审计回滚、ID映射及密文解密未执行；后续已通过小样本验收。没有调用真实服务商或自动重发导入。
- 原Wrangler OAuth查询Workers Logs曾返回403 / `no_access_to_workers_observability`。用户受限诊断Token首次查询返回401，只读验证发现其生效日期误设为12月4日；用户修正后验证为active、已生效且未过期，Workers Observability的keys/values/query均返回200。查询使用`dry: true`及精确staging服务过滤，但事件数仍为0，未取得异常栈。未输出Token或其ID、未替换Wrangler凭据、未扩大权限。日期问题仅解释先前诊断认证阻断，不解释staging的HTTP500。
- 用户确认浏览器的1101出现在独立staging地址。受控最小诊断暂时使用同一个staging Worker，完全不加载业务应用、不配置静态托管，保留原独立D1绑定及测试密钥、访问门禁、不可改写的全局出站拦截、原compatibility_date和无Cron；本机探针通过且原生出站为0。部署版本 `b8d0a257-0b88-42bc-8e1c-a71646f81c1a` 的云端元数据确认没有assets，带/不带门禁的探针仍返回HTTP500/1101。未执行D1查询或写入，未接触真实服务商。
- 最小探针的API tail确认WebSocket已连接，但无事件；临时tail已成功删除。诊断收据已写入，不过进程退出仍超时，不能把命令视为完整成功。新的GraphQL查询仍无CPU样本。本机时间、D1只读SQL时长或空样本不能证明Workers CPU/深历史容量，也不能仅凭最小探针和空日志把根因确定为Cloudflare平台或出站拦截。
- 受控诊断后已重新应用原字节一致的staging应用/静态配置（同SHA-256），当前staging版本 `7c07bc8e-459a-4256-8d61-c5b3339c1e93`；不是数据库还原，合成D1及测试密钥保留，未放宽防护。再次远端验收确认11张合成原表后仍停在静态阶段，canonical `/`返回500；应用迁移及导入未运行。所有失败版本与受限本机收据保留；在该早期诊断时点，配置和状态文档尚未提交/推送。
- 用户已授权仅为同一个staging新增临时测试域名 `staging-domain-hub.licacv.com`，不得覆盖既有DNS/Route或修改生产入口。接入助手已通过语法检查；审核发现Wrangler 4.156.2的非交互Custom Domain发布会自动打开既有origin/DNS覆盖选项，因此未执行该发布命令，改为准备其changeset/records请求格式并显式关闭全部覆盖选项、保持当前Worker版本。实际预检在资源写入前停止：现有OAuth读取目标Zone、Route、Worker部署和Custom Domains成功，但精确/通配及整Zone DNS读取均返回403 / `10000`，不能证明未占用或DNS保全。当次未执行changeset、dry-run、部署或D1操作；日志诊断Token未用于DNS，未扩大其权限或替换Wrangler凭据。本次失败收据保留；随后用户手动添加域名，没有提供或要求新增DNS Token。

## 当前验收结果与证据边界

- 用户手动添加的 `https://staging-domain-hub.licacv.com` 已只读确认：精确Hostname绑定原独立staging Worker及确认的Zone，Custom Domain预览关闭，无Worker Route和Cron，仍是版本 `7c07bc8e-459a-4256-8d61-c5b3339c1e93`、独立D1与测试密钥。同版本/静态配置通过该域名返回200且字节匹配，未带门禁的API返回403，带门禁出站探针返回`blocked: true`；同时workers.dev仍返回500/1101。这将失败范围缩小到与入口相关的差异，但没有1101异常栈或Cloudflare内部证据，不能宣称平台根因已确定或workers.dev已修复。没有重建、重新部署或放宽防护。
- 接入后的只读核查发现workers.dev预览已开启（Custom Domain预览仍关闭）。用户明确授权后，仅POST该staging的subdomain设置，将`previews_enabled`设回false，保留`enabled: true`；前后staging/生产版本及Custom Domain/Zone Route指纹相同，未操作D1、生产、本地服务或DNS。无法凭现有DNS权限声称所有既有DNS已完整比对保全；本助手未执行域名/DNS创建或覆盖。
- 经该Custom Domain，静态资源/SPA与安全响应头、API门禁、原11表增量迁移为20表、原业务行/删除自增高水位、重复迁移幂等、密码/2FA及会话、错误源AES/服务商域名ID冲突拒绝、三行新增预览及预览无写入、强制审计失败的行/序列/审计/变更时钟原子回滚均通过。受控失败导入之后移除唯一测试触发器，再执行一次成功导入；账号映射21、域名778及`remote_id = external-id-kept`保留，Secret在staging AES下可解密、源AES下不可解密，重复预览不新增或覆盖。只执行两个预先设计、结果明确的导入请求，没有自动重试、还原数据库或调用真实服务商。
- 原验收脚本在成功导入和解密后的收尾阶段使用了D1不支持的`PRAGMA integrity_check`，API返回400 / `7500`，原失败收据保留。按[官方D1 SQL文档](https://developers.cloudflare.com/d1/sql-api/sql-statements/)改用受支持的`PRAGMA quick_check`；只读后续检查返回`ok`，`foreign_key_check`无违规，20表/零sync任务/账号21高水位/域名778/解密及资源保全均复核，未重放导入。前段与只读收尾合计99项检查通过；这不是对完整远端`integrity_check`的通过声明。受限本机证据：`remote-acceptance-NGd3rU`（原失败）、`readonly-finalization-GNBxTT`（收尾通过）、`custom-host-inspect-iFQnLo`和`disable-previews-4i05Sy`。业务及健康检查通过不代表生产发布门禁已满足。
- 有效受限诊断Token的staging精确服务过滤、`dry: true`查询现在获得23个真实事件；其中本次合成数据样本Workers Logs CPU：成功登录40ms、成功导入17ms、强制失败导入14ms、成功预览8ms/10ms、auth/status 13ms/20ms。新GraphQL样本也可用，返回的staging执行错误及出站subrequests计数为0；预期业务拒绝400/401不是未捕获执行异常。这些仅是小样本测量，不是压测、SLO/额度保证或大历史容量证据；未把网络耗时、D1耗时或统计字段单位混作CPU。受限本机证据：`logquery-w1ULwm`、`metrics-3gOq3m`；没有输出Token、密码、密文、请求头或请求正文。

## 必须继续保持的阻断

1. 小样本云端功能及实际CPU已验证，但大历史/目标负载容量仍未证明；保留workers.dev的1101证据，不把Custom Domain正常或单次低CPU当作完整容量/平台根因结论。
2. 所有生产配置变更须重新验证并以新的精确main SHA审核；不要用旧SHA批准新配置。
3. `production` Required reviewers/main限制尚未配置，`RELEASE_APPROVED_SHA`仍缺失；须先明确人工审批人及保护策略，不通过自行审批绕过门禁。
4. GitHub尚缺原 `CLOUDFLARE_D1_DATABASE_ID`。必须绑定已确认的原UUID，不创建替代库、不轮换AES。
5. 真正发布前刷新、验证最新原D1/原AES成对备份，保留新用户数据及现有恢复证据；失败不得自动恢复旧库。

当前原生产版本：`b32c140f-3f93-49dc-b51c-44eb30252f13`，独立staging部署与再次部署前后均未改变。
