# 发布、迁移与回退手册

更新：2026-11-03。此手册不授权任何真实写操作。依赖已获授权升级，两树审计0漏洞、Node22/24完整复验通过，见[升级验收](dependency-upgrade-acceptance.md)及[前批交付](follow-up-all-acceptance.md)。云端staging/容量/部署按用户要求暂缓；代码、离线测试与合成staging不等于生产可发布，原服务未切换。

## 1. 业务 JSON 迁移

- 版本1，五张业务表：accounts、custom_accounts、custom_domains、domains_cache、domain_date_overrides。**合计最多500行、紧凑 JSON UTF-8最多8MiB**；不导出截断文件。HTTP 外壳另有8KiB空间，不扩展快照上限。
- 不包含 settings/密码/2FA/会话、缓存、日志、Actions、同步断点/租约、服务商预算、续期意图或通知状态。**业务快照不是整站恢复材料**。超过上限或迁移整站须使用停写后数据库/AES成对备份；D1/SQLite文件不能直接互换。
- 导出经同一只读 batch 获得一致业务快照；各表只取上限+1后验证总量、字段和父子归属。导出需已启用的2FA及有效动态码；preview/import在目标已启用2FA时同样验证动态码。
- 先选择文件，必要时填源 AES，点击“只读预览”；预览通过后**另点“确认追加导入”**。预览不写审计/业务、不锁定目标；确认时重验。文件/源Key变更使预览失效。失败/未知提交不自动重发，先核对目标和审计。
- 同 Key 留空 `sourceAesKey`；异 Key显式提交源Key，后端解密验证后按目标Key重新加密。密钥仅走HTTPS或本机连接，密码框临时保留；关闭/成功/退出清空，不写快照或浏览器存储，不返回/记录源Key。
- 按持久化 provider/api_key和解密后Secret识别账号，**不按别名合并**。已有同身份账号只映射，不覆盖其别名/网址/注册时间。凭据冲突、损坏密文、错Key、重复身份、未知字段/表、悬空归属整批拒绝。
- 本地账号/自定义账号/日期行ID映射，并尊重已删除 AUTOINCREMENT高水位；domains_cache数值ID（含合法0/负数及安全整数）和remote_id/provider_account_id保持原值。不得将外部 `provider_account_id` 当本地外键重写。CF apex空前缀、历史未知到期空字符串和永久日期占位忠实保留，不伪造日期。
- 已有域名/日期/自定义数据的已提供实质字段冲突不覆盖、不删除。并发身份/分配变化在事务内再次断言；断言、插入和一条成功审计处于同一原子 batch。SQL/审计失败回滚，未知响应不声称“肯定未提交”。次要成功日志失败不丢失已确认提交收据。
- 最大直接DAO导入测试为7次D1调用、external=0；每表一次查询batch。**不是7条SQL、云端CPU或rows达标**。HTTP还有schema/鉴权等开销。

接口：`POST /api/data/preview`、`POST /api/data/import`，请求 `{ token, snapshot, sourceAesKey? }`；认证使用现有管理员通道，不在URL传Key。预览diff允许新增，更新/删除/冲突均为0；无法验证的冲突返回失败，不以预览成功掩盖。

## 2. 发布前审批清单

1. 独立授权具体目标、变更、停写窗口和回退责任人；保存完整main SHA、代码/依赖锁/产物哈希。不得夹带未知用户改动。
2. 在独立副本跑 `npm ci`（需另行允许安装）、`npm run verify:all`、Node构建、前端类型、独立13项浏览器和规模helper类型。根/frontend分别 `npm audit` 并保留JSON；任一审计失败停止，不用强制修复或降级门禁。
3. 保存**最新数据库与原AES**恢复材料及其可用性验证，保留已有管理员/2FA/凭据/任务与用户新操作。运行服务期间不得复制单个SQLite主文件冒充一致备份；使用获批停写/备份流程并处理WAL。D1使用独立获批导出/恢复流程。
4. 使用与生产完全隔离的staging Worker/D1或Node数据目录和测试凭据：验证增量schema/索引、原数据解密、JSON迁移预览/确认、ID冲突与审计回滚。**本轮只有本地workerd合成HTTP冒烟，不曾部署真实staging**。
5. 升级schema为增量，不删表/任务/AES。首次建立历史索引本身可能扫描深历史；先在staging测迁移时间和成本，不因 `IF NOT EXISTS` 就认定无开销。
6. 仓库管理员配置 `production` Required reviewers、main限制、建议禁止自行审批/绕过审批；填 `RELEASE_APPROVED_SHA`。YAML `environment: production` 不自动配置保护规则。
7. 必填Cloudflare Token、Account ID、**已有D1 UUID**；原Worker必须已有 `AES_KEY` 的secret_text元信息。元信息不能证明配对，须另验解密。不查库名猜身份、不自动创建D1/初始化schema、不轮换AES/可选Secret。
8. 审查wrangler中Routes/Custom Domains、workers_dev/preview_urls及Cron。无自动域名探测/访问策略改写，Wrangler仍会应用已审批配置；`--keep-vars`不替代配置核查。`RELEASE_APP_URL`仅是摘要预期URL。

## 3. 获批后发布与验收

工作流只接受 `workflow_dispatch` 的main及完整 `approved_sha`；三处SHA必须相等，依赖verify/security成功后才进入production审批和发布。push不会生产部署，concurrency不取消在途发布。Wrangler pin已对齐4.156.2，本轮本地安全审计通过，但没有运行工作流或配置云端审批；发布时须刷新审计，**不要绕开门禁直接执行wrangler或Docker发布**。

新空站的Worker/D1/schema/AES引导是独立流程；已有站点禁止“重新初始化”管理员或自动补一个新Key。生产前后端配套升级，Node须先停同库旧写入实例，不允许两个实例共享一库执行迁移。

部署后的独立验收先本地/只读，再另行授权真实上游：健康/静态资源、已有管理员/2FA与Secret解密、断点版本/归属、默认关闭同步与续期窗口；在小样本预算内验证读同步。记录实际D1 `rows_read/rows_written`、Workers CPU、总配额/积压/429与真实后台标签/崩溃行为。预算各40、DNSHE30/60s、25账号池、500片/账号/轮、手动两分钟不提高。自动开关和续期不能随发布自动启用。

用户已确认普通到期前180天内续期免费；不将其推广到逾期/赎回或未知收费状态，也不自动设置窗口或开启续期。真实写验收须另行明确方法、适用状态、零费用约束及授权；未知已发送仅GET核验，不自动再POST，见[契约记录](provider-contract-evidence.md)。

## 4. 止损与回退

- 发现解密失败、归属冲突、未知写入、预算异常或容量不达标：停止**新派发**，保留任务/意图/审计与限频状态，不以清缓存/换Key绕过保护，不宣称已撤销远端请求。
- 先确认没有旧实例/在途写入，记录实际新数据和明确提交收据。回退是另一次审批；旧版本必须在含新schema/任务/触发器的副本通过兼容验证，不能直接启动不理解断点的旧runner。
- 优先回退到兼容的已验代码并保留最新库/原AES。整站恢复只有在明确授权且接受损失范围、协调远端已发生写入后进行；停写后另存最新状态，再恢复**配对**材料，不自动恢复本轮之前的密码/用户数据。
- 不自动删新表/索引、清history/任务/预算、不反向远端删除已创建DNS，不重复未知续期。DNS反向写可能删除用户同期修改，须读核验和新授权，不作为通用“补偿”。

## 5. 辅助操作的真实语义

DNS批量创建/更新/删除及DigitalPlat/Huawei分组写入在首个失败/未知写结果后停止，确认前缀保留，尾部 `not_sent:true`。`fail_count`包含未发送项；顶层success只说明批处理返回，不是全部远端成功。读取前置失败则不继续写。不自动重试/补偿删除；写后回读失败保持dirty，后续只读核验，不重复写。

持久化分片同步才有真实任务取消协议，阻止后续领取/晚到提交；已发送上游仍可能完成。非分片Action `/cancel`返回409 `cancel_not_supported`，不能承诺远端取消；通用PATCH仍可写客户端终态标记，但**标记不是撤销/回滚证明**。Scanner/通知/其他后台动作不获得通用持久取消与补偿保证。

参考（2026-11-02检索）：[D1 batch事务](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[D1索引](https://developers.cloudflare.com/d1/best-practices/use-indexes/)、[Wrangler Workers/Secret命令](https://developers.cloudflare.com/workers/wrangler/commands/workers/)、[Workers最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。
