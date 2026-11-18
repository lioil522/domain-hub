# 概览统计口径修正（Phase D）：2026-11-18

本批是 Phase D「性能与体验」的第一项：先把概览（Dashboard）的统计口径修正确，再谈入口体积与列表分页。依据是 `docs/PROJECT_ANALYSIS_2026-11-17.md` 的 9.1、P1-20 与 C 阶段出口「同域统计一致」。

改动已在本地完成并纳入 `test:invariants`；未调用真实服务商、未修改生产数据库。

## 问题

- 概览只聚合 DNSHE / Cloudflare / DigitalPlat / 自定义，DNSPod、阿里云 DNS、华为云 DNS、Vercel 的域名与账号完全不计入总数、过期数、最近注册、到期预警和时间轴。
- 时间轴直接遍历各来源的到期记录。同一域名同时出现在 DNSHE 与 Cloudflare（或任一组合）时，会在同一个月被 push 两次，导致「本月 2 个到期」实际只有 1 个域名。
- 同一域名在 A 来源被标为永久、在 B 来源有真实到期日时，永久数与计划到期数会各加一次。
- 聚合逻辑埋在 `useMemo` 里，无法在 Node 测试中直接断言，回归只能靠页面肉眼发现。

## 修复内容

- 新增纯函数 `frontend/src/features/dashboard/stats.ts`：不依赖 React，输入为各来源域名/账号数组与 `cfExpiryMap`，输出 `DashboardStats`。
- `useDashboardStats` 退化为 `useMemo` 薄封装，仅按依赖缓存；调用点补传 `multiProviderData` 与 `multiProviderAccountLists`。
- 覆盖来源：DNSHE、Cloudflare、DigitalPlat、自定义、DNSPod、阿里云 DNS、华为云 DNS、Vercel。
- 总数、过期、最近注册、预警、时间轴统一按归一化域名（`normalizeDomainKey`）去重；任一来源判定过期则该域名整体计入过期。
- 时间轴改为遍历已去重的到期表：一个域名只占一个月份格子；冲突时取更紧急的来源（已过期优先，其次剩余天数更少）。
- 永久域名按集合去重；只有「没有任何真实到期日且未被判过期」的域名才计入永久数，避免永久与计划到期重复计数。
- 账号数同样覆盖四家新托管商，不再出现「有域名但没有账号」的口径缺口。

## 统计口径

| 指标 | 口径 |
|---|---|
| 域名总数 | 八个来源按归一化域名去重后的数量 |
| 已过期 | 来源 `status` 标记过期，或到期时间早于当前时刻；同域任一来​​源过期即计入 |
| 未过期 | 总数减已过期，最小为 0 |
| 账号数 | DNSHE + CF + DigitalPlat + 自定义分组 + 四家托管商账号 |
| 最近注册 | 有 `created_at` 的来源按时间倒序，同域保留首条，最多 6 条 |
| 到期预警 | 已过期或 90 天内到期，按剩余天数升序，最多展示 8 条，另给出总数 |
| 时间轴 | 未来 12 个自然月，每域一格；已过期进 `overdueCount`，永久进 `permanentCount`，均不占月桶 |

到期时间仍沿用 `cfExpiryMap` 的优先级链：手动覆盖 > DNSHE 上游 > DigitalPlat 上游 > RDAP 自动查询 > 来源自身字段。

## 测试与验证

- 新增 `tests/unit/dashboard-stats.test.ts`，共 6 个用例：
  - 同一域名跨多个来源只计一次（总数、预警、时间轴、最近注册）；
  - 四家托管商的域名与账号均计入，来源标签正确；
  - 多来源永久占位只计一次；
  - 永久与真实到期冲突时不重复计数；
  - 一个来源过期时同域整体计为过期，健康来源不掩盖；
  - 冲突时最紧急来源胜出，时间轴不重复。
- `npm run test:unit:dashboard` 通过；已加入 `test:invariants`。
- `npm --prefix frontend run typecheck` 通过。
- `npm run verify:all` 通过：277 个不变量/集成测试全部通过，Worker 与 Node 构建、主题检查、发布包检查、workerd/Node 冒烟、Docker 输入边界检查均通过。
- `npm --prefix frontend run typecheck` 与 `build:selfhost` 通过；本次构建主入口 gzip 137.9KB。

## 未完成与限制

- 本批不改入口体积：普通构建主入口 gzip 约 137.9KB，仍高于 Phase D 的 80KB 预算；Scanner 词库/邮编数据与大体量弹窗的按需化是下一项。
- 未做列表分页/虚拟化，10,000 域名场景仍会全量渲染。
- 时间轴的月份分桶按浏览器本地时区计算，跨时区用户的「本月」边界可能相差一天；这是既有行为。
- Cloudflare zone 本身没有到期字段，无 `cfExpiryMap` 条目时仍按永久处理；真实到期日依赖 RDAP 查询或手动录入。
- 纯函数测试不等于浏览器 E2E 与真实数据验收；未在浏览器中逐项比对生产数据。
