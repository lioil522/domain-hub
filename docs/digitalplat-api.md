# DigitalPlat Developer API 参考文档

> 来源：<https://dashboard.digitalplat.org/dashboard/api/docs>（需登录后查看）
> 整理日期：2026-09-06，供 DNSHE-Manager 接入 DigitalPlat 账号时参考。

## 概述

DigitalPlat 开发者 API，用于以编程方式管理 DigitalPlat 产品线：域名、注册局（付费注册）、DNS、短链接、Pages、表单、虚拟主机、统计。

### 认证

所有请求携带 Bearer 方式的 API Key：

```
Authorization: Bearer dp_live_xxxxx
```

- API Key 以 SHA256 哈希存储，**明文只在创建时显示一次**
- `dp_live_` 前缀 = 生产环境；`dp_test_` 前缀 = 开发测试

### 基础地址与响应结构

| 服务 | 基础地址 |
|---|---|
| 主 API（域名/DNS/短链/Pages/表单/主机） | `https://domain-api.digitalplat.org/api/v1` |
| Analytics 统计 | `https://analytics.digitalplat.org` |
| Forms 公开提交 | `https://forms.digitalplat.org` |

统一响应封装：

```json
{ "success": true, "data": { ... }, "meta": { ... } }
```

### 全局规则与限制

- **DNS 写请求必须带 `Idempotency-Key` 请求头**（DigitalPlat DNS 所有套餐免费）
- **开通 Hosting 账号**要求：GitHub 验证 + 已验证邮箱 + 接受当前 Hosting AUP + `Idempotency-Key` 头
- **创建注册订单**需 `Idempotency-Key` 头
- 域名注册 `slot_type` 取值：`free` / `paid` / `subscription`
- `.us.kg`、`.xx.kg` 等付费后缀需要 paid 或 subscription 名额
- Short Links API 调用量计入套餐月度额度
- Pages API 需要 **Pro 及以上**套餐；Forms API 需要 **Pro 及以上**（公开提交端点用表单 public key，无需面板 API Key）
- DNS 记录限额（示例值）：每 zone 200 条、每账号 1000 条

---

## 接口速查表

### Domains（域名）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/domains` | 列出 API Key 名下全部域名 |
| POST | `/api/v1/domains` | 注册新域名（外部 NS） |
| PATCH | `/api/v1/domains/{domain}/nameservers` | 替换域名 NS |
| DELETE | `/api/v1/domains/{domain}` | 删除域名（pendingdelete，7 天后释放） |

### Registered Domains（注册局 / 付费注册）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/registry/tlds` | 可用 TLD 目录（游标分页） |
| POST | `/api/v1/registry/search` | 查域名并返回可用后缀替代项 |
| POST | `/api/v1/registry/quotes` | 创建报价（注册/续费/转入/赎回，10 分钟有效） |
| POST | `/api/v1/registry/orders` | 由报价创建注册订单（幂等） |
| POST | `/api/v1/domains/{domain}/renew` | 续费已注册域名 |
| PATCH | `/api/v1/domains/{domain}/contacts` | 指定注册人联系资料 |
| PUT | `/api/v1/domains/{domain}/dnssec` | 设置外部 DS 记录（DNSSEC） |
| POST | `/api/v1/domains/{domain}/child-nameservers` | 创建子 NS（glue 记录） |

### DigitalPlat DNS

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/domains/{domain}/dns` | zone 状态、权威 NS、serial、限额、用量 |
| POST | `/api/v1/domains/{domain}/dns/enable` | 启用 Hosted DNS（排队开通） |
| GET | `/api/v1/domains/{domain}/dns/records` | 记录列表（含只读服务记录） |
| POST | `/api/v1/domains/{domain}/dns/records` | 创建/扩展 RRset（≤16 值） |
| PATCH | `/api/v1/domains/{domain}/dns/records/{record_id}` | 更新记录（需 If-Match ETag） |
| DELETE | `/api/v1/domains/{domain}/dns/records/{record_id}` | 从 RRset 删除一个值 |
| POST | `/api/v1/domains/{domain}/dns/switch-external` | 切换外部 NS（归档 zone 7 天） |
| POST | `/api/v1/domains/{domain}/dns/restore` | 恢复归档 zone（7 天窗口内） |
| POST | `/api/v1/domains/{domain}/dns/import/preview` | BIND zone 文件导入预览 |
| POST | `/api/v1/domains/{domain}/dns/import/apply` | BIND zone 文件导入应用（单事务） |
| GET | `/api/v1/domains/{domain}/dns/export` | 导出 BIND zone 文件 |

### Short Links（短链接）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/short-link-domains` | 自定义短域名列表（含验证/TLS 状态） |
| POST | `/api/v1/short-link-domains` | 添加自定义短域名（返回 TXT + CNAME） |
| POST | `/api/v1/short-link-domains/{id}/verify` | 验证短域名所有权 |
| POST | `/api/v1/short-link-domains/{id}/rotate-verification` | 轮换验证 TXT 值 |
| DELETE | `/api/v1/short-link-domains/{id}` | 删除自定义短域名 |
| GET | `/api/v1/short-link-platform-domains` | 官方公共短域名列表 |
| GET | `/api/v1/short-links` | 短链列表（query/status/include_archived/limit） |
| POST | `/api/v1/short-links` | 创建短链（随机/自定义 slug、密码、定时、过期） |
| POST | `/api/v1/short-links/bulk` | 批量创建短链 |
| GET | `/api/v1/short-links/{id}` | 单条短链详情 + 生命周期计数 |
| PATCH | `/api/v1/short-links/{id}` | 更新短链 |
| DELETE | `/api/v1/short-links/{id}` | 软删除（立即停止跳转） |
| GET | `/api/v1/short-links/{id}/analytics?days=30` | 短链统计 |
| GET | `/api/v1/short-links/{id}/qr?format=png&size=640` | 生成二维码（PNG/SVG） |

### Pages（需 Pro+）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/pages` | Page 列表（含 blocks、域名、发布历史、套餐用量） |
| POST | `/api/v1/pages` | 创建 Page（link_page / landing / website / blog） |
| PATCH | `/api/v1/pages/{page_id}` | 更新 Page 资料/主题/SEO |
| POST | `/api/v1/pages/{page_id}/blocks` | 添加 Block |
| POST | `/api/v1/pages/{page_id}/publish` | 发布 Page |
| POST | `/api/v1/pages/{page_id}/assets` | 上传图片（multipart `file`） |
| GET | `/api/v1/pages/{page_id}/analytics?days=30` | Page 统计 |
| POST | `/api/v1/pages/{page_id}/domains` | 绑定域名（托管或付费外部） |
| POST | `/api/v1/pages/{page_id}/domains/{binding_id}/verify` | 验证外部域名 |

### Forms（API 需 Pro+；公开端点无需 Key）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `https://forms.digitalplat.org/f/{public_key}` | 获取已发布表单 schema + load token |
| POST | `https://forms.digitalplat.org/f/{public_key}/password` | 换取密码表单的短期 token |
| POST | `https://forms.digitalplat.org/f/{public_key}` | 提交表单 |
| GET | `/api/v1/forms` | 表单列表 |
| POST | `/api/v1/forms` | 创建表单（空白或模板） |
| GET | `/api/v1/forms/{form_id}` | 表单详情 |
| PATCH | `/api/v1/forms/{form_id}` | 更新表单 |
| PUT | `/api/v1/forms/{form_id}/fields` | 整体替换字段列表 |
| POST | `/api/v1/forms/{form_id}/publish` | 发布为版本化快照 |
| GET | `/api/v1/forms/{form_id}/submissions?status=unread&page=1&per_page=50` | 响应列表（分页） |
| GET | `/api/v1/forms/{form_id}/submissions/export.csv` | 导出 CSV |
| PATCH | `/api/v1/forms/{form_id}/submissions/{submission_id}` | 更新单条响应状态 |
| POST | `/api/v1/forms/{form_id}/submissions/bulk` | 批量更新响应（Scale+，≤200） |
| GET | `/api/v1/forms/{form_id}/analytics?days=30` | 表单统计 |
| GET | `/api/v1/forms/{form_id}/audit-log?limit=200` | 审计日志（Business+） |
| DELETE | `/api/v1/forms/{form_id}` | 删除（30 天回收站，`permanent=1` 立即） |

### Hosting（虚拟主机）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/hosting` | 主机总览（限额/资格/账号/工单/动态） |
| POST | `/api/v1/hosting/accounts` | 开通主机账号（provisioning 直到供应商确认） |
| GET | `/api/v1/hosting/accounts/{account_id}` | 主机账号详情 |
| POST | `/api/v1/hosting/accounts/{account_id}/domains` | 绑定域名（addon/parked/subdomain） |
| POST | `/api/v1/hosting/accounts/{account_id}/password/rotate` | 轮换 vPanel 密码（只发邮件） |
| POST | `/api/v1/hosting/accounts/{account_id}/tickets` | 创建工单 |

### Analytics（统计采集）

| 方法 | 地址 | 说明 |
|---|---|---|
| POST | `https://analytics.digitalplat.org/a/collect` | 采集事件（服务端需 `X-DigitalPlat-Server-Key: dps_xxxxx`） |
| GET | `https://analytics.digitalplat.org/a/app/dpa_xxxxx` | 应用活跃上报（无参数默认 `app_open`） |

---

## 分组详解

### 1. Domains（域名）

#### GET `/api/v1/domains` — 列出域名

返回 API Key 所属账号拥有的全部域名。

```json
{
  "success": true,
  "data": [
    {
      "name": "example.us.kg",
      "status": "ok",
      "slot_type": "subscription",
      "lifecycle_type": "subscription",
      "expiry_date": "2027-04-08",
      "nameservers": ["ns1.provider.com", "ns2.provider.com"]
    }
  ],
  "meta": {}
}
```

#### POST `/api/v1/domains` — 注册域名

使用外部 NS 注册新域名。`slot_type` 支持 `free` / `paid` / `subscription`。

```json
// 请求
{
  "domain": "example.us.kg",
  "slot_type": "subscription",
  "nameservers": ["ns1.provider.com", "ns2.provider.com"]
}

// 响应
{
  "success": true,
  "data": {
    "name": "example.us.kg",
    "status": "ok",
    "slot_type": "subscription",
    "lifecycle_type": "subscription"
  },
  "meta": {}
}
```

#### PATCH `/api/v1/domains/{domain}/nameservers` — 更新 NS

```json
// 请求
{ "nameservers": ["ns1.provider.com", "ns2.provider.com"] }

// 响应
{
  "success": true,
  "data": { "name": "example.us.kg", "nameservers": ["ns1.provider.com", "ns2.provider.com"] },
  "meta": {}
}
```

#### DELETE `/api/v1/domains/{domain}` — 删除域名

域名进入 `pendingdelete`：DNS 立即停用，7 天后释放。

```json
{
  "success": true,
  "data": { "domain": "example.us.kg", "status": "pendingdelete" },
  "meta": {}
}
```

### 2. Registered Domains（注册局 / 付费注册）

#### GET `/api/v1/registry/tlds` — 可用 TLD 目录

游标分页；查询参数：`query`、`category`、`status`、`sort`、`cursor`、`limit`。

```json
{
  "success": true,
  "data": {
    "registry": { "environment": "sandbox", "sandbox": true },
    "items": [{ "tld": "com", "min_years": 1, "max_years": 10 }],
    "tlds": [{ "tld": "com", "min_years": 1, "max_years": 10 }],
    "next_cursor": "MjQ",
    "total": 512
  },
  "meta": {}
}
```

#### POST `/api/v1/registry/search` — 查询域名/后缀

检查一个域名并从启用的 TLD 目录返回可用替代项。

```json
// 请求
{ "query": "example", "limit": 8, "cursor": null }

// 响应
{
  "success": true,
  "data": {
    "query": "example",
    "results": [{ "domain_ascii": "example.com", "available": true }],
    "next_cursor": "OA",
    "total": 500
  },
  "meta": {}
}
```

#### POST `/api/v1/registry/quotes` — 创建报价

针对注册 / 续费 / 转入 / 赎回创建 **10 分钟有效**的报价。

```json
// 请求
{ "domain": "example.com", "operation": "register", "years": 1 }

// 响应
{
  "success": true,
  "data": { "id": "quote-id", "domain_ascii": "example.com", "amount_minor": 1299, "currency": "USD" },
  "meta": {}
}
```

#### POST `/api/v1/registry/orders` — 创建注册订单

由当前报价 + 联系人资料创建幂等订单，**必须带 `Idempotency-Key` 头**。

```json
// 请求
{
  "quote_id": "quote-id",
  "contact_profile_id": "contact-id",
  "payment_method": "credits",
  "dns_mode": "hosted",
  "accept_agreement": true,
  "agreement_version": "2026-08-11"
}

// 响应
{
  "success": true,
  "data": { "id": "order-id", "domain": "example.com", "status": "completed" },
  "meta": {}
}
```

#### POST `/api/v1/domains/{domain}/renew` — 续费

走当前环境批准的支付流程。

```json
// 请求
{ "years": 1, "payment_method": "sandbox" }

// 响应
{ "success": true, "data": { "domain_kind": "registrar", "registry_status": "active" }, "meta": {} }
```

#### PATCH `/api/v1/domains/{domain}/contacts` — 更新注册联系人

```json
// 请求
{ "contact_profile_id": "contact-id" }

// 响应
{ "success": true, "data": { "status": "contacts_updated" }, "meta": {} }
```

#### PUT `/api/v1/domains/{domain}/dnssec` — 设置 DNSSEC

TLD 支持 DNSSEC 时替换外部 DS 记录。

```json
// 请求
{ "records": [{ "key_tag": 12345, "algorithm": 13, "digest_type": 2, "digest": "AABBCCDD" }] }

// 响应
{ "success": true, "data": { "records": [{ "key_tag": 12345 }] }, "meta": {} }
```

#### POST `/api/v1/domains/{domain}/child-nameservers` — 创建子 NS

在已注册域名下创建 glue 主机。

```json
// 请求
{ "hostname": "ns1.example.com", "addresses": ["192.0.2.10"] }

// 响应
{ "success": true, "data": { "hostname": "ns1.example.com", "status": "active" }, "meta": {} }
```

### 3. DigitalPlat DNS

#### GET `/api/v1/domains/{domain}/dns` — Hosted DNS 状态

返回 zone 状态、权威 NS、serial、当前限额、用量与记录。

```json
{
  "success": true,
  "data": {
    "domain": "example.us.kg",
    "mode": "hosted",
    "status": "active",
    "nameservers": ["dns1.digitalplat.org", "dns2.digitalplat.org"],
    "usage": { "zone_records": 4, "account_records": 21 },
    "limits": { "records_per_zone": 200, "records_per_account": 1000 }
  },
  "meta": {}
}
```

#### POST `/api/v1/domains/{domain}/dns/enable` — 启用 Hosted DNS

排队开通 zone；只有两个权威节点都以匹配的 SOA/NS 应答后才会变更父域委派。

```json
{
  "success": true,
  "data": {
    "operation_id": "28bd23f2-d1d3-4df6-bbe0-82331628a7d1",
    "zone": { "domain": "example.us.kg", "status": "provisioning" }
  },
  "meta": {}
}
```

#### GET `/api/v1/domains/{domain}/dns/records` — 记录列表

返回用户记录 + DigitalPlat 服务管理的只读记录。每条记录带 `etag`（更新时用）。

```json
{
  "success": true,
  "data": [
    {
      "id": "18ee109c8b5042bf989f05a54159dfda",
      "type": "A",
      "name": "@",
      "value": "192.0.2.25",
      "ttl": 300,
      "protected": false,
      "etag": "sha256-etag"
    }
  ],
  "meta": {}
}
```

#### POST `/api/v1/domains/{domain}/dns/records` — 创建记录

创建或扩展 RRset；单次可传 `value` 或最多 16 个 `values`。DNS 写请求需 `Idempotency-Key`。

```json
// 请求
{
  "type": "A",
  "name": "@",
  "ttl": 300,
  "values": ["192.0.2.25", "192.0.2.26"]
}

// 响应
{
  "success": true,
  "data": {
    "operation_id": "c05bd56d-44aa-4011-9a49-ae1b095ca99c",
    "records": [
      { "type": "A", "name": "@", "value": "192.0.2.25", "ttl": 300 }
    ]
  },
  "meta": {}
}
```

#### PATCH `/api/v1/domains/{domain}/dns/records/{record_id}` — 更新记录

更新记录值 / TTL / 停用状态。**必须用 `If-Match` 携带当前 ETag**，防止覆盖其他会话的修改。

```json
// 请求
{ "value": "192.0.2.30", "ttl": 600, "disabled": false }

// 响应
{
  "success": true,
  "data": {
    "operation_id": "3928e2ea-2b0d-43fc-a0be-97a3a02b2282",
    "record": { "type": "A", "name": "@", "value": "192.0.2.30", "ttl": 600 }
  },
  "meta": {}
}
```

#### DELETE `/api/v1/domains/{domain}/dns/records/{record_id}` — 删除记录

从 RRset 中删除一个值。受保护的服务记录无法通过用户 API 删除。

```json
{
  "success": true,
  "data": { "operation_id": "0384bcad-ce19-4b19-81db-b0700c5dca67" },
  "meta": {}
}
```

#### POST `/api/v1/domains/{domain}/dns/switch-external` — 切换外部 NS

替换父域委派并把 Hosted DNS zone 归档 7 天。SOA 预检失败时，复查后才能传 `force: true`。

```json
// 请求
{
  "nameservers": ["ns1.provider.example", "ns2.provider.example"],
  "force": false
}

// 响应
{
  "success": true,
  "data": {
    "operation_id": "746931ba-1c91-4bd2-a877-a7e68a0576bf",
    "zone": { "mode": "external", "status": "provisioning" }
  },
  "meta": {}
}
```

#### POST `/api/v1/domains/{domain}/dns/restore` — 恢复归档 zone

在 7 天恢复窗口内恢复已归档的 Hosted DNS zone。

```json
{
  "success": true,
  "data": {
    "operation_id": "482da838-52c1-493c-a068-e31dc8a3de16",
    "zone": { "mode": "hosted", "status": "provisioning" }
  },
  "meta": {}
}
```

#### POST `/api/v1/domains/{domain}/dns/import/preview` — BIND 导入预览

解析 BIND zone 文件、报告被跳过的记录、检查导入后的记录限额，不改动 DNS。

```json
// 请求
{ "zone_file": "$ORIGIN example.us.kg.\nwww 300 IN A 192.0.2.25\n" }

// 响应
{
  "success": true,
  "data": {
    "count": 1,
    "records": [{ "name": "www", "type": "A", "ttl": 300, "value": "192.0.2.25" }],
    "warnings": []
  },
  "meta": {}
}
```

#### POST `/api/v1/domains/{domain}/dns/import/apply` — BIND 导入应用

把预检过的 zone 文件作为单个数据库事务应用，并排队受影响的 RRset。

```json
// 请求
{ "zone_file": "$ORIGIN example.us.kg.\nwww 300 IN A 192.0.2.25\n" }

// 响应
{
  "success": true,
  "data": {
    "operation_ids": ["9a055c3e-6b63-45bf-a381-e00b9bfb8f8b"],
    "imported": 1,
    "warnings": []
  },
  "meta": {}
}
```

#### GET `/api/v1/domains/{domain}/dns/export` — 导出 BIND zone 文件

```text
$ORIGIN example.us.kg.
$TTL 300
@ IN NS dns1.digitalplat.org.
@ IN NS dns2.digitalplat.org.
www 300 IN A 192.0.2.25
```

### 4. Short Links（短链接）

#### GET `/api/v1/short-link-domains` — 自定义短域名列表

```json
{
  "success": true,
  "data": [
    {
      "id": 42,
      "hostname": "go.example.com",
      "status": "active",
      "cname_target": "go.digitalplat.org",
      "tls_status": "pending",
      "link_count": 12
    }
  ],
  "meta": { "count": 1 }
}
```

#### POST `/api/v1/short-link-domains` — 添加自定义短域名

预留主机名，返回一次性 TXT 验证值和 CNAME 目标。

```json
// 请求
{ "hostname": "go.example.com" }

// 响应
{
  "success": true,
  "data": {
    "id": 42,
    "hostname": "go.example.com",
    "status": "pending",
    "verification_record_name": "_digitalplat-verification.go.example.com",
    "verification_value": "digitalplat-verification=one-time-token",
    "cname_target": "go.digitalplat.org"
  },
  "meta": {}
}
```

#### POST `/api/v1/short-link-domains/{id}/verify` — 验证短域名

检查所有权 TXT 记录，匹配即激活。

```json
{ "success": true, "data": { "id": 42, "hostname": "go.example.com", "status": "active" }, "meta": {} }
```

#### POST `/api/v1/short-link-domains/{id}/rotate-verification` — 轮换验证值

作废旧验证值并返回新的一次性 TXT 值。

```json
{
  "success": true,
  "data": {
    "id": 42,
    "status": "pending",
    "verification_value": "digitalplat-verification=new-one-time-token"
  },
  "meta": {}
}
```

#### DELETE `/api/v1/short-link-domains/{id}` — 删除自定义短域名

需先删除或改绑所有使用该域名的链接。

```json
{ "success": true, "data": { "id": 42, "hostname": "go.example.com", "status": "deleted" }, "meta": {} }
```

#### GET `/api/v1/short-link-platform-domains` — 官方短域名列表

`is_default: true` 的项是创建短链时不传 `domain_id` 时的默认域名。

```json
{
  "success": true,
  "data": [
    { "id": 7, "hostname": "s.qzz.io", "domain_type": "platform", "is_default": true, "status": "active" }
  ],
  "meta": { "count": 1 }
}
```

#### GET `/api/v1/short-links` — 短链列表

支持 `query`、`status`、`include_archived`、`limit` 参数。`meta.api_usage` 返回当月额度使用情况。

```json
{
  "success": true,
  "data": [
    {
      "id": "a14f05c6709b45f8b6543ca893ab246d",
      "short_url": "https://s.qzz.io/launch-notes",
      "target_url": "https://example.com/product/launch",
      "status": "active",
      "click_count": 128
    }
  ],
  "meta": { "count": 1, "api_usage": { "used": 14, "limit": 50000 } }
}
```

#### POST `/api/v1/short-links` — 创建短链

支持随机或自定义 slug，可选密码 / 定时 / 过期控制。不传 `domain_id` 用官方默认域名。自定义 slug 会做滥用词校验，被拒返回 `blocked_slug_keyword`。

```json
// 请求
{
  "target_url": "https://example.com/product/launch",
  "slug": "launch-notes",
  "title": "Launch notes",
  "domain_id": 7,
  "password": "optional-secure-password",
  "expires_at": "2026-12-31T23:59:59Z"
}

// 响应
{
  "success": true,
  "data": {
    "id": "a14f05c6709b45f8b6543ca893ab246d",
    "slug": "launch-notes",
    "short_url": "https://s.qzz.io/launch-notes",
    "status": "active",
    "has_password": true
  },
  "meta": { "api_usage": { "used": 15, "limit": 50000 } }
}
```

#### POST `/api/v1/short-links/bulk` — 批量创建

单次上限随套餐；每条独立返回成功或失败。

```json
// 请求
{
  "links": [
    { "target_url": "https://example.com/one" },
    { "target_url": "https://example.com/two", "slug": "second-link" }
  ]
}

// 响应
{
  "success": true,
  "data": {
    "requested": 2,
    "created": 2,
    "failed": 0,
    "results": [
      { "index": 0, "success": true, "link": { "short_url": "https://s.qzz.io/k4m9q2xa" } },
      { "index": 1, "success": true, "link": { "short_url": "https://s.qzz.io/second-link" } }
    ]
  },
  "meta": { "api_usage": { "used": 16, "limit": 50000 } }
}
```

#### GET `/api/v1/short-links/{id}` — 短链详情

```json
{
  "success": true,
  "data": {
    "id": "a14f05c6709b45f8b6543ca893ab246d",
    "short_url": "https://s.qzz.io/launch-notes",
    "target_url": "https://example.com/product/launch",
    "status": "active",
    "click_count": 128,
    "qr_scan_count": 22
  },
  "meta": {}
}
```

#### PATCH `/api/v1/short-links/{id}` — 更新短链

可改目标地址、标题、状态、密码、定时、过期、归档状态。

```json
// 请求
{
  "target_url": "https://example.com/product/launch-v2",
  "status": "active",
  "expires_at": "2027-01-31T23:59:59Z"
}

// 响应
{
  "success": true,
  "data": {
    "id": "a14f05c6709b45f8b6543ca893ab246d",
    "target_url": "https://example.com/product/launch-v2",
    "status": "active",
    "version": 2
  },
  "meta": {}
}
```

#### DELETE `/api/v1/short-links/{id}` — 删除短链

软删除，立即停止跳转。

```json
{ "success": true, "data": { "id": "a14f05c6709b45f8b6543ca893ab246d", "status": "deleted" }, "meta": {} }
```

#### GET `/api/v1/short-links/{id}/analytics?days=30` — 短链统计

返回聚合点击、独立访客、二维码扫描、机器人、时间序列、来源、地区、设备、浏览器、操作系统。

```json
{
  "success": true,
  "data": {
    "range_days": 30,
    "summary": { "clicks": 128, "unique_visitors": 104, "qr_scans": 22, "bots": 3 },
    "timeseries": [
      { "date": "2026-07-17", "clicks": 18, "unique_visitors": 15, "qr_scans": 4, "bots": 1 }
    ],
    "dimensions": { "country": [{ "name": "US", "clicks": 54 }] }
  },
  "meta": {}
}
```

#### GET `/api/v1/short-links/{id}/qr?format=png&size=640` — 生成二维码

按需生成 PNG 或 SVG，重复下载不占单独二维码配额。响应为二进制图片：

```text
HTTP/1.1 200 OK
Content-Type: image/png
Content-Disposition: attachment; filename=digitalplat-launch-notes.png
```

### 5. Pages（需 Pro+）

#### GET `/api/v1/pages` — Page 列表

```json
{
  "success": true,
  "data": [
    {
      "id": "2f71ca81799b4f61ab21ec9a4c932870",
      "slug": "edward",
      "mode": "website",
      "display_name": "Edward",
      "status": "published",
      "public_url": "https://p.dpdns.org/edward"
    }
  ],
  "meta": { "count": 1 }
}
```

#### POST `/api/v1/pages` — 创建 Page

创建 Link Page / 落地页 / 网站 / 博客草稿；每种模式都有含空白在内的起始模板。

```json
// 请求
{
  "slug": "edward",
  "display_name": "Edward",
  "bio": "Building open internet infrastructure.",
  "mode": "website",
  "starter_template": "blank-website"
}

// 响应
{
  "success": true,
  "data": {
    "id": "2f71ca81799b4f61ab21ec9a4c932870",
    "slug": "edward",
    "mode": "website",
    "starter_template": "blank-website",
    "status": "draft",
    "default_url": "https://p.dpdns.org/edward"
  },
  "meta": {}
}
```

#### PATCH `/api/v1/pages/{page_id}` — 更新 Page 资料

可更新类型、用户名、显示名、bio、主题、许可的设计 token、SEO 字段、品牌、敏感内容提示。

```json
// 请求
{
  "display_name": "Edward — DigitalPlat",
  "bio": "Open infrastructure for a freer internet.",
  "mode": "website",
  "seo_title": "Edward on DigitalPlat Pages"
}

// 响应
{
  "success": true,
  "data": { "id": "2f71ca81799b4f61ab21ec9a4c932870", "display_name": "Edward — DigitalPlat", "status": "draft" },
  "meta": {}
}
```

#### POST `/api/v1/pages/{page_id}/blocks` — 添加 Block

类型包括 `hero`、`feature_grid`、`stats`、`testimonial`、`faq`、`cta`、`content_page`、`article`（示例使用 `link`）。

```json
// 请求
{
  "type": "link",
  "config": {
    "label": "Project website",
    "url": "https://example.com/project",
    "description": "Read the latest project update"
  },
  "is_enabled": true
}

// 响应
{
  "success": true,
  "data": { "id": "5b63ebed9550478db2fd2f94ed20b012", "type": "link", "position": 0, "is_enabled": true },
  "meta": {}
}
```

#### POST `/api/v1/pages/{page_id}/publish` — 发布 Page

发布到 `p.dpdns.org` 或主域名。

```json
{
  "success": true,
  "data": {
    "id": "2f71ca81799b4f61ab21ec9a4c932870",
    "status": "published",
    "is_published": true,
    "public_url": "https://p.dpdns.org/edward"
  },
  "meta": {}
}
```

#### POST `/api/v1/pages/{page_id}/assets` — 上传图片

multipart/form-data，字段名 `file`；可传头像、Page 图片、社交预览图。

```text
file=@avatar.png
kind=avatar
```

```json
{
  "success": true,
  "data": {
    "id": "89b69442a68b46dfa996613f7196e93e",
    "kind": "avatar",
    "mime_type": "image/webp",
    "size_bytes": 48122,
    "storage_provider": "local"
  },
  "meta": {}
}
```

#### GET `/api/v1/pages/{page_id}/analytics?days=30` — Page 统计

```json
{
  "success": true,
  "data": {
    "days": 30,
    "summary": { "views": 1800, "unique_visitors": 1322, "clicks": 624, "click_through_rate": 34.67 },
    "top_links": [{ "label": "Project website", "clicks": 401 }]
  },
  "meta": {}
}
```

#### POST `/api/v1/pages/{page_id}/domains` — 绑定 Page 域名

可绑定 DigitalPlat 托管域名或付费套餐的外部域名。托管域名在 DNS 解除前独占给 Pages。

```json
// 请求
{ "hostname": "links.example.com", "is_primary": true }

// 响应
{
  "success": true,
  "data": {
    "id": "76d32b09dd594bbf90073fdf46ce8448",
    "hostname": "links.example.com",
    "type": "external",
    "status": "pending_verification",
    "verification_record_name": "_digitalplat-pages.links.example.com"
  },
  "meta": {}
}
```

#### POST `/api/v1/pages/{page_id}/domains/{binding_id}/verify` — 验证外部域名

同时检查一次性所有权 TXT 记录和 CNAME/A 路由记录。

```json
{
  "success": true,
  "data": {
    "id": "76d32b09dd594bbf90073fdf46ce8448",
    "hostname": "links.example.com",
    "status": "active",
    "tls_status": "pending"
  },
  "meta": {}
}
```

### 6. Forms（表单）

公开端点基于 `https://forms.digitalplat.org`，使用表单 public key，**不需要面板 API Key**；管理端点走主 API `/api/v1/forms`，需 Pro+。

#### GET `/f/{public_key}` — 获取已发布表单

返回 schema、可用性、展示设置和短期 load token。

```json
{
  "ok": true,
  "form": {
    "key": "form_public_key",
    "name": "Product feedback",
    "available": true,
    "fields": [{ "key": "email", "type": "email", "required": true }],
    "load_token": "signed-load-token"
  }
}
```

#### POST `/f/{public_key}/password` — 解锁密码表单

用表单密码换短期 token；获取 schema 时放 `X-Form-Password-Token` 头，提交时用同一请求头或 `_password_token` 字段。

```json
// 请求
{ "password": "form-password" }

// 响应
{ "ok": true, "password_token": "short-lived-signed-token" }
```

#### POST `/f/{public_key}` — 提交表单

接受 JSON 或普通 HTML 表单数据；建议带 `Idempotency-Key` 以便安全重试；先取过 schema 的要带 load token。

```json
// 请求
{
  "answers": { "email": "person@example.com", "message": "Great work" },
  "_load_token": "signed-load-token"
}

// 响应
{
  "ok": true,
  "submission_id": "7e9f10536acb45698ddbd0a74bf5bf9c",
  "status": "unread",
  "confirmation_required": false
}
```

#### GET `/api/v1/forms` — 表单列表

```json
{
  "success": true,
  "data": [
    {
      "id": "6b46d27c51404f78bd83e522d49df96a",
      "name": "Product feedback",
      "status": "published",
      "hosted_url": "https://forms.digitalplat.org/edward/product-feedback",
      "totals": { "views": 1200, "starts": 480, "valid": 214, "spam": 6 }
    }
  ],
  "meta": { "count": 1 }
}
```

#### POST `/api/v1/forms` — 创建表单

```json
// 请求
{ "name": "Product feedback", "slug": "product-feedback", "template": "feedback" }

// 响应
{
  "success": true,
  "data": {
    "id": "6b46d27c51404f78bd83e522d49df96a",
    "name": "Product feedback",
    "status": "draft",
    "public_key": "form_public_key"
  },
  "meta": {}
}
```

#### GET `/api/v1/forms/{form_id}` — 表单详情

```json
{
  "success": true,
  "data": {
    "id": "6b46d27c51404f78bd83e522d49df96a",
    "name": "Product feedback",
    "status": "draft",
    "fields": [{ "key": "email", "type": "email", "required": true }]
  },
  "meta": {}
}
```

#### PATCH `/api/v1/forms/{form_id}` — 更新表单

可更新名称、URL、日程、响应上限、主题、成功提示、访问设置、条件逻辑。

```json
// 请求
{
  "name": "Product feedback 2026",
  "response_limit": 5000,
  "success": { "title": "Thank you", "message": "Your feedback was received." }
}

// 响应
{ "success": true, "data": { "id": "6b46d27c51404f78bd83e522d49df96a", "name": "Product feedback 2026" }, "meta": {} }
```

#### PUT `/api/v1/forms/{form_id}/fields` — 替换字段

整体替换草稿字段列表；`key` 必须唯一，字段数上限由套餐决定。

```json
// 请求
{
  "fields": [
    { "key": "email", "type": "email", "label": "Email", "required": true, "enabled": true, "page_number": 1, "config": {} },
    { "key": "message", "type": "long_text", "label": "Feedback", "required": true, "enabled": true, "page_number": 1, "config": { "max_length": 2000 } }
  ]
}

// 响应
{
  "success": true,
  "data": [
    { "key": "email", "type": "email", "label": "Email", "required": true },
    { "key": "message", "type": "long_text", "label": "Feedback", "required": true }
  ],
  "meta": {}
}
```

#### POST `/api/v1/forms/{form_id}/publish` — 发布表单

把当前草稿发布为版本化快照并开始接收响应。

```json
{
  "success": true,
  "data": {
    "id": "6b46d27c51404f78bd83e522d49df96a",
    "status": "published",
    "hosted_url": "https://forms.digitalplat.org/edward/product-feedback"
  },
  "meta": {}
}
```

#### GET `/api/v1/forms/{form_id}/submissions` — 响应列表

参数：`status=unread&page=1&per_page=50`。响应保留期随套餐。

```json
{
  "success": true,
  "data": {
    "submissions": [
      {
        "id": "7e9f10536acb45698ddbd0a74bf5bf9c",
        "status": "unread",
        "data": { "email": "person@example.com", "message": "Great work" },
        "submitted_at": "2026-07-21T12:00:00Z"
      }
    ],
    "pagination": { "page": 1, "total": 1, "pages": 1 }
  },
  "meta": {}
}
```

#### GET `/api/v1/forms/{form_id}/submissions/export.csv` — 导出 CSV

可加 `status=unread|read|archived|spam|partial|pending_confirmation` 过滤。

```text
submission_id,status,source,submitted_at,country,device,email,message
7e9f10536acb45698ddbd0a74bf5bf9c,unread,external,2026-07-21T12:00:00Z,US,desktop,person@example.com,Great work
```

#### PATCH `/api/v1/forms/{form_id}/submissions/{submission_id}` — 更新响应状态

状态取值：`unread` / `read` / `archived` / `spam`。

```json
// 请求
{ "status": "archived" }

// 响应
{ "success": true, "data": { "id": "7e9f10536acb45698ddbd0a74bf5bf9c", "status": "archived" }, "meta": {} }
```

#### POST `/api/v1/forms/{form_id}/submissions/bulk` — 批量更新响应

Scale / Enterprise 套餐可用，单次最多 200 条。

```json
// 请求
{ "submission_ids": ["7e9f10536acb45698ddbd0a74bf5bf9c"], "action": "mark_read" }

// 响应
{
  "success": true,
  "data": { "action": "mark_read", "processed": ["7e9f10536acb45698ddbd0a74bf5bf9c"], "failed": [] },
  "meta": {}
}
```

#### GET `/api/v1/forms/{form_id}/analytics?days=30` — 表单统计

```json
{
  "success": true,
  "data": {
    "days": 30,
    "summary": { "views": 1200, "starts": 480, "valid": 214, "conversion_rate": 17.83 },
    "dimensions": { "source": [{ "name": "newsletter", "count": 142 }] }
  },
  "meta": {}
}
```

#### GET `/api/v1/forms/{form_id}/audit-log?limit=200` — 审计日志

Business 及以上套餐可查看表单 / 工作流 / 团队 / 响应变更。

```json
{
  "success": true,
  "data": [
    { "action": "form_published", "source": "dashboard", "actor": "edward", "created_at": "2026-07-21T12:00:00Z" }
  ],
  "meta": {}
}
```

#### DELETE `/api/v1/forms/{form_id}` — 删除表单

进入 30 天回收站；需要连同保留响应立即删除时加 `permanent=1`。

```json
{ "success": true, "data": { "deleted": true }, "meta": {} }
```

### 7. Hosting（虚拟主机）

#### GET `/api/v1/hosting` — 主机总览

返回账号限额、开通资格、主机账号、已连接域名、工单和最近动态。

```json
{
  "success": true,
  "data": {
    "plan_id": "free",
    "usage": { "accounts": 0, "limit": 1, "remaining": 1, "hard_limit": 3 },
    "eligibility": { "github_kyc": true, "email_verified": true, "aup_accepted": true, "can_create": true },
    "accounts": []
  },
  "meta": {}
}
```

#### POST `/api/v1/hosting/accounts` — 开通主机账号

要求 GitHub 验证、已验证邮箱、接受 Hosting AUP，并带 `Idempotency-Key`。账号保持 `provisioning` 直到供应商回调确认激活。

```json
// 请求
{
  "domain_mode": "existing",
  "domain": "example.qzz.io",
  "dns_mode": "digitalplat"
}

// 响应
{
  "success": true,
  "data": {
    "id": "7f05b762-370f-4ef6-b952-3f21c0a2244e",
    "primary_domain": "example.qzz.io",
    "status": "provisioning"
  },
  "meta": {}
}
```

#### GET `/api/v1/hosting/accounts/{account_id}` — 主机账号详情

返回域名绑定、能力（capabilities）和活动记录。

```json
{
  "success": true,
  "data": {
    "id": "7f05b762-370f-4ef6-b952-3f21c0a2244e",
    "primary_domain": "example.qzz.io",
    "vpanel_username": "hname_12345678",
    "status": "active"
  },
  "meta": {}
}
```

#### POST `/api/v1/hosting/accounts/{account_id}/domains` — 绑定主机域名

准备 addon / parked / subdomain 连接；供应商回调确认后激活。

```json
// 请求
{
  "domain": "www.example.com",
  "binding_type": "addon",
  "dns_mode": "digitalplat"
}

// 响应
{
  "success": true,
  "data": {
    "domain": "www.example.com",
    "status": "pending_vpanel",
    "dns_mode": "digitalplat"
  },
  "meta": {}
}
```

#### POST `/api/v1/hosting/accounts/{account_id}/password/rotate` — 轮换 vPanel 密码

新密码发送到账号邮箱，**API 永远不返回密码**。

```json
{ "success": true, "data": { "rotated": true, "delivery": "email" }, "meta": {} }
```

#### POST `/api/v1/hosting/accounts/{account_id}/tickets` — 创建工单

```json
// 请求
{
  "subject": "Domain setup question",
  "message": "The domain is present in vPanel but has not become active."
}

// 响应
{
  "success": true,
  "data": { "id": "576388bc-8a64-4901-8af1-ab8d9dd097a1", "status": "open" },
  "meta": {}
}
```

### 8. Analytics（统计采集）

#### POST `https://analytics.digitalplat.org/a/collect` — 采集事件

浏览器端追踪用 property key；**服务端请求还必须带 property 设置页显示的 Analytics 服务端 key**。

```bash
curl -X POST "https://analytics.digitalplat.org/a/collect" \
  -H "Content-Type: application/json" \
  -H "X-DigitalPlat-Server-Key: dps_xxxxx" \
  -d '{"property":"dpa_xxxxx","event":"page_view","url":"https://example.com/docs"}'
```

#### GET `https://analytics.digitalplat.org/a/app/dpa_xxxxx` — 应用活跃上报

每个应用 property 有独立链接；不带查询参数即记录 `app_open`。

```bash
curl "https://analytics.digitalplat.org/a/app/dpa_xxxxx?event=app_open&version=1.0.0&platform=windows&client_id=INSTALL_ID"
```

---

## 附：对接 DNSHE-Manager 的注意点

- 认证模型与 Cloudflare 不同：DigitalPlat 用单一 Bearer API Key（`dp_live_` / `dp_test_`），没有 Zone 级 Token 概念，Key 即账号级权限
- 域名列表 `GET /api/v1/domains` 直接返回 `expiry_date`，无需像 Cloudflare 那样另查 RDAP 获取到期时间
- DNS 记录模型为 RRset（同名同类型多值合并为一条记录，最多 16 值），与 Cloudflare 的单记录模型不同；**更新记录必须携带 `If-Match: <etag>`**，面板里并发编辑需处理 412 冲突
- 所有 DNS 写操作和主机开通都必须生成并携带 `Idempotency-Key`（UUID 即可）
- 操作多为异步：DNS 变更返回 `operation_id`，Hosting 开通停在 `provisioning`，需要在面板里轮询状态
- 免费额度：Hosted DNS 每账号 1000 条 / 每 zone 200 条；Hosting 免费计划 1 个账号（hard limit 3）
