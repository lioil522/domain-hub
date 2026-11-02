# 服务商契约证据与保守阻塞项

更新：2026-11-02，纳入用户本轮实测确认及此前公开文档；本轮未用真实Key请求服务商，未执行续期/删除/密钥管理。DigitalPlat、HuaweiCloud及其他服务商契约调查按用户要求暂缓。

## DNSHE：用户确认的当前依据

用户明确确认：**每分钟30次、同登录账号多Key共享额度、到期前180天内续期免费**。本轮接受该确认，不再将30/60或普通180天免费窗口列为待调查事实；未追加真实探测。下面保留公开文档矛盾作为历史来源，不用旧示例推翻本次确认。

- 当前实现仍按持久Key协调30/60s和冷却，**尚未实现同账号跨Key共享预算**。不能据此声称多Key合计已受30/min保护；需要可靠、可审计的服务商账号主体或明确映射，不按本地ID、别名、相似Key猜归属，也不换Key绕过额度。
- 免费窗口确认不等于授权续期或修改运行配置；`dnshe_renew_window_days`默认0保持，本轮不自动设置180、不发续期。将来写验收须单独授权并限定普通到期前状态；赎回/逾期或未知费用不能套用免费结论。已发送未知结果只GET核验，不重复POST。

### 历史公开文档与适用边界

来源：[V2.0官方文档](https://my.dnshe.com/knowledgebase/13/DNSHE%E5%85%8D%E8%B4%B9%E5%9F%9F%E5%90%8DAPI%E4%BD%BF%E7%94%A8%E6%96%87%E6%A1%A3V2.0.html?language=chinese)、[免费续期说明](https://my.dnshe.com/knowledgebase/5/DNSHE-Free-Domain-Renewal-and-API-Command-Renewal-Methods.html?language=chinese)。

- V2开头写默认30请求/分钟，后面速率章节写60。历史授权WHOIS边界探测观察过30后官方429，但当时每登录账号只有一Key，无法区分账号/Key。该历史证据的限制仍保留；当前额度事实按本轮用户确认的同账号共享30/min处理，代码身份归并仍待可靠映射。
- 续期说明明确**到期前180天**、免费，但“提交续期”示例仍是GET `dns_records/action=list`；它不能成为写接口依据。
- V2规定POST/PUT `subdomains/action=renew`，示例 `charged_amount:9.9`，并列赎回期扣费/余额不足、管理员处理、窗口尚未开放等分支。因此180天不等于所有状态可免费续期，也不是无费用写入许可。
- 历史GET列表“续期”示例不能成为写接口依据；当前普通到期前180天免费已由用户确认。真正写验收仍须明确方法、适用状态、零费用约束和小样本授权，不通过试写探索赎回或未知收费行为。
- V2的keys list/create/delete/regenerate是公开能力，不证明多Key额度独立；密钥管理/永久升级中心仍是产品需求，不在本次迁移优化中擅自实现或执行。

## DigitalPlat / HuaweiCloud / 其他服务商：调查暂缓

以下为已有边界，并非本轮继续调查任务；不删除其测试或放宽失败关闭校验。

- DigitalPlat生产 `domain-api.digitalplat.org/api/v1` 的Developer分页/meta仍缺可靠schema。公开Dashboard页面壳或Domain-OSS不证明生产契约；目前保守接受已验证无分页data[]及缺失/null/空meta，未知非空meta拒绝，不采用局部列表删除旧数据。
- HuaweiCloud记录/域名分页主要读取已有严格校验，但精确DNS限频作用域/速率和未知业务码仍未确认；不能拿通用APIGateway额度替代。已确认业务码/HTTP429冷却保留，未知失败不猜成可重试。
- Cloudflare用户合计额度、阿里云ParentUid/API配额、DNSPod接口速率、Vercelowner/resource约束见 [历史依据](optimization-progress.md#4-阶段状态与剩余范围)。本地Key通道隔离不证明面板外、多个部署或多Token合计限额已覆盖。多实例须共享同库协调，不新增固定DNSHE双槽。

## 将来恢复所需材料（本轮不执行）

DNSHE需要稳定账号主体或明确多Key归属映射，才能安全落实已确认的共享30/min；续期需要单独的写验收授权和普通免费状态/零费用约束。若用户将来恢复其他服务商调查，再收集DigitalPlat分页终止/total/meta、HuaweiCloud具体DNS API限频码/作用域等脱敏契约。只在合成fixture中先补回归，真实读/写另授权；不宣称P3/F06全部通过。
