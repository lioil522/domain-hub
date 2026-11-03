# 云端发布前恢复材料

更新：2026-11-04。仅获批后执行；这是可选的恢复流程，不是 fork 部署的前置工作流。它自身的明确授权输入不属于部署工作流，也不替代 staging。

- 面板 `domain-hub-backup-*.json` 仅含五张业务表，不包含完整管理员、2FA、会话、日志或协调状态，也不携带 AES。它不能作为整站回退备份。
- 对已只读确认的原 Account/Worker/D1 UUID，使用独立配置导出完整 D1 SQL。导出期间会阻塞其他数据库请求；先获批操作窗口。不得为通过导出而删除虚拟表或修改原库。
- 如原 AES 仅存 GitHub Secret，可经另行授权运行 `backup-secret.yml`。只接受 main 手动触发、精确批准 SHA 和匹配的 Account ID；只上传 RSA-OAEP-SHA256 + AES-256-GCM 加密产物，保留一天。公钥可提交给工作流，私钥必须留在本机受限目录，不能提交仓库或上传产物。
- 下载后，在受限本机目录解密并验证全部原账号/2FA密文、SQL恢复、表与行数以及迁移兼容性。GitHub Secret 的存在或工作流成功不能证明它与原 D1 配对；失败不得轮换 AES、改密文或恢复旧数据。
- 本机恢复材料不得进入 CI/GHCR 构建上下文、终端日志或聊天。完整 SQL 与原 AES 要成对保管；如私钥是恢复必需品，也必须安全保管。
- 独立云端 staging 必须另获授权，使用独立 Worker/D1 与测试凭据，禁止真实服务商操作及 Cron，不能绑定生产 Route。先验证原数据的本机恢复和解密，再做云端合成验收；两类证据分别记录，不把合成数据测试冒充完整云端原数据恢复。
- 已有站点升级建议遵循 [发布手册](release-and-migration.md)，保留原路由、访问策略、原 D1 与 AES。fork 部署工作流无需填写 SHA 或 production 审批变量；本恢复流程的授权与资料不能被当作任何真实部署授权。

参考：[D1 导出及其限制](https://developers.cloudflare.com/d1/best-practices/import-export-data/)。
