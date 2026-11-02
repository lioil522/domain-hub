# 后续优化整批交付与验收边界

> 本文为23:20历史批次，原冻结证据不改写。随后用户授权依赖升级，双树审计已为0漏洞且Node22/24完整复验通过；DNSHE事实已接受用户确认，其他服务商调查和云端部署暂缓。最新状态见[升级验收](dependency-upgrade-acceptance.md)，勿将下文当时阻塞或未授权状态作为当前结论。

2026-11-02 23:20（北京时间）收尾。按“后续全部计划一次性完成”整批处理可离线实施范围，**代码/离线验收已完成；生产安全与真实云端/服务商验收仍受阻**。不是全部阶段A–F或新增产品需求全部上线。

## 完成交付

| 范围 | 本轮结果 |
|---|---|
| 跨计划页调度 | 一个全局≤25顺序账号流池、最多一页待派发；释放槽位即填后页，不再等整页慢账号。51账号浏览器及7项Node跨页回归；仍受满池、超时、500片和两分钟约束，不保证无限公平 |
| 密集DNS/深历史 | UTF-8 32768/32769字节、4/5页×100记录的128KiB累计上限、坏记录ID保留旧缓存；三个增量历史索引，保留原资格/事务复核 |
| 跨密钥业务迁移 | 500行/8MiB，凭据验证/目标重加密、本地ID映射、远端ID保留、冲突整批拒绝、原子审计；UI只读预览→明确确认、单飞、晚到/退出隔离、Key清空 |
| 辅助写止损 | 首个失败/未知写后尾部not_sent，不重试/补偿；非分片取消409，不承诺远端撤销 |
| 发布安全 | 只手动main精确SHA、production审批、verify/security；明确已有D1 UUID、发布前原AES元信息；不自动建库/轮换Secret/探测域名改访问策略 |
| 文档 | README、后续计划、A–F/F06状态、规模/历史说明同步；发布回退、依赖修复政策和契约矛盾单独成册 |

## 离线门禁结果

`verify:all` **20组、661项，零失败/取消/跳过**；原618项在其独立冻结副本保留。

| 组 | 项数 | 组 | 项数 |
|---|---:|---|---:|
| P1预算/任务/自动化 | 104 | 辅助/路由安全 | 113 |
| workerd/D1 | 89 | DNSHE契约 | 13 |
| 其他Provider契约 | 25 | Provider传输 | 117 |
| 共享scheduler | 59 | DNSHE预算scheduler | 39 |
| 前端安全 | 58 | 状态/搜索/Provider/Scanner | 各1（4） |
| Scanner序列/计划/执行 | 3 / 4 / 8 | Telegram | 3 |
| 迁移 | 15 | 架构/发布 | 4 |
| API HTTP | 3 | 合计 | 661 |

另有**13项Chromium/React**独立通过（不累加进661）：合成API/会话/可见性，真实React effects。Worker/Node类型和构建、前端构建/类型、规模helper类型均通过；Node六组原自检全部通过（适配层37项），主题108项检查失败0。

首次完整门禁失败4项旧Node迁移自检：缺exported_at、原始伪密文、旧“同ID覆盖”与旧错误文案。保留日志，改用有效加密快照并断言ID映射/冲突拒绝；另修正真实CF apex/未知到期空TEXT兼容，新增往返回归，**不伪造日期、不删故障覆盖**。首次前端/断言/分组fixture及旧非分片取消期望失败日志同样保留。

### 性能证据，不是云端承诺

- 定向2,000任务历史只读预览：约8082.69→15.49ms，索引10,000任务约75.50ms。
- 最终完整门禁复测：**7855.22→15.43ms**，索引10,000任务约**75.72ms**；结果/保留资格及query plan断言一致。没有性能阈值，不用单次本地计时证明Free CPU。
- 两项workerd合成staging HTTP验证鉴权、Node独立AES→workerd解密、预览/映射、上限和审计回滚；不是实际云端staging部署。最大直接迁移7次D1 API、external0，不是7条SQL或计费行数。

## 当前阻塞与未授权操作

1. 根审计6包（4 high/2 moderate），frontend5包（3 high/2 moderate），**security不通过、不可上线**。未安装/升级依赖，不能强制audit fix；见 [修复政策](dependency-remediation.md)。
2. DNSHE官方30/60分钟矛盾及多Key主体作用域未确认；公开180天窗口有GET列表“续期”示例/免费与赎回扣费矛盾，不自动设窗口或试续期。DigitalPlat生产分页/meta、HuaweiCloud精确限频/未知码仍缺契约，见 [证据](provider-contract-evidence.md)。
3. 实际云端D1 scanned/billed rows、Workers CPU/容量、实际后台标签节流/崩溃和旧真实taskId连续恢复未验收。本地回归不能替代。
4. 真实同步/续期/删除、历史清理、生产staging/上线、重启/切换构建、依赖升级均需独立授权；历史403残留域名仍由管理员处理。新增密钥管理/永久升级中心与其余产品功能未实施。

## 冻结证据和当前服务

独立目录：`C:\Users\15017\AppData\Local\Temp\opencode\follow-up-all-verify-20261102`。

- `full-gate-fixes-source-hashes.json`：门禁时504文件（包含当时文档）；`final-code-source-hashes.json`：**491个非Markdown源码/配置**，工作区与测试副本一致。504与491统计口径不同，不表示删文件。
- `acceptance-receipt.json`、`final-gates.json`、`final-full-*.log`：完整绿色收据；`full-verify-all.log` / `gates.json`首轮失败保留。文档收尾只修改工作区，不覆盖测试副本/冻结源码。
- 最终浏览器：`sync-lifecycle-browser-SOYBrI/receipt.json`；定向13项旧收据`sync-lifecycle-browser-LU1WW6/receipt.json`保留。
- 新未启用Node bundle：`E5F7F3A2885E1E40BDDC5927ACAE7C428B8BBD6FD1B2B60E4B7A60BFAE7257D1`。
- 新Worker bundle：`0B187B1E20A40C744E1FF642451D5E59D9A9A3BAF606E32C42E1E566E2698127`。全部前端产物/锁文件/日志哈希在收据中。
- **23:20:45原PID22636**仍监听8787，healthz/首页及5个静态资源均200并匹配原文件；原运行bundle仍`1D62A02257721888EAF512A64DB3D62F1129028B28C5814B84B96520FB9FA36B`，见`service-unchanged-final.json`。只检查进程/健康/静态，不打开原数据库/AES，不能声称用户期间数据库完全未变。

没有停止/重启原服务、替换原产物或数据库/AES、同步真实账号、续期/删除/清历史、恢复Scanner、安装升级、提交、推送或部署。原密码恢复和用户活动保持现状，不恢复旧快照。后续唯一允许自动继续的离线事项是说明与证据核对；真实变更按 [发布与回退手册](release-and-migration.md)新授权执行。

### 文档与证据收口

17份Markdown的本地链接/标题锚点和文档差异已核对，README失效目录已修复；491个非Markdown工作区文件、504个冻结文件、验收收据所列日志/产物哈希均匹配。上一批618项的499个冻结文件及13项已记录证据哈希也匹配。新文档收口收据单独保存为opencode Temp的 `follow-up-all-doc-closure-20261102.json`，不覆盖原验收收据或重跑生产门禁。

`acceptance-receipt.json`中的`themePassLines:162`只是原日志PASS行数，实际主题最终汇总是**108项、失败0**；日志原有编码显示问题保留，不改写冻结证据。
