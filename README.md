# Domain Hub 2.0

> 多服务商域名管理、DNS 管理、扫描、账号与系统配置的一体化控制台。

Domain Hub 2.0 是一个 **Cloudflare Worker + React/Vite** 架构的域名管理系统，目标是把 Cloudflare、DigitalPlat、DNSHE、华为云及其他服务商的账号、域名、DNS、配额、日志、扫描和自动化能力统一到一个界面中。

当前代码库处于 **Phase 4 架构重构完成 / 持续硬化阶段**。本阶段重点不是增加大量业务功能，而是降低巨型文件耦合、建立明确的 Controller / ViewModel / Feature / API 边界，并用架构检查阻止重构成果回退。

---

## 目录

- [主要能力](#主要能力)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [前端架构](#前端架构)
- [后端架构](#后端架构)
- [Scanner 架构](#scanner-架构)
- [主题系统](#主题系统)
- [Phase 4 重构内容](#phase-4-重构内容)
- [本地开发](#本地开发)
- [验证与测试](#验证与测试)
- [架构约束](#架构约束)
- [生产构建与部署](#生产构建与部署)
  - [部署方式选择](#部署方式选择)
  - [方案 A：Cloudflare Worker 手动部署](#方案-a-cloudflare-worker-手动部署)
  - [方案 B：GitHub Actions 自动部署到 Cloudflare](#方案-b-github-actions-自动部署到-cloudflare)
  - [Cloudflare API Token 创建](#cloudflare-api-token-创建)
  - [Cloudflare Token 必要权限](#cloudflare-token-必要权限)
  - [GitHub Secrets 配置](#github-secrets-配置)
  - [首次工作流部署](#首次工作流部署)
  - [Cloudflare 部署验收](#cloudflare-部署验收)
  - [方案 C：Docker / 自建部署](#方案-c-docker--自建部署)
  - [Docker Compose 使用 GHCR 镜像](#docker-compose-使用-ghcr-镜像)
  - [Docker 从源码构建](#docker-从源码构建)
  - [Docker GitHub Actions 自动构建](#docker-github-actions-自动构建)
  - [GHCR 私有镜像拉取](#ghcr-私有镜像拉取)
  - [Docker 数据、备份与升级](#docker-数据备份与升级)
  - [反向代理与 HTTPS](#反向代理与-https)
  - [发布与回滚](#发布与回滚)
- [开发约定](#开发约定)
- [后续工作](#后续工作)

---

## 主要能力

### 域名与 DNS

- 多服务商账号统一管理
- 域名列表、搜索、筛选及跨模块跳转
- Cloudflare DNS 管理
- DNSHE DNS 管理
- 多来源 DNS 记录操作
- NS / 根域名发现与配置
- DNS 配额及状态信息

### 服务商与账号

- Cloudflare
- DigitalPlat
- DNSHE
- 华为云
- 自定义服务商
- 多账号管理及账号状态同步
- 服务商能力按功能拆分，避免页面层直接依赖 SDK

### Scanner

- 单域名扫描
- 批量扫描
- 词库
- 保留前缀
- 顺序扫描
- WHOIS / 域名可用性相关能力
- 批量任务规划、任务池和执行器
- 扫描状态持久化

### 系统能力

- 设置管理
- 日志
- 配额
- 数据备份
- Telegram / Webhook 通知
- 自动化任务与 Cron
- 统一 API 请求及错误处理
- 架构与主题回归检查

---

## 技术栈

### Backend / Worker

- TypeScript
- Cloudflare Workers
- Hono
- Wrangler
- Cloudflare Workers Types
- D1 / SQLite 兼容数据访问
- esbuild

### Frontend

- React 18
- TypeScript
- Vite 5
- Tailwind CSS
- Lucide React
- QRCode React

### Runtime

建议使用：

```text
Node.js >= 22.5.0
npm
```

---

## 项目结构

```text
Domain-Hub-2.0/
├── src/                           # Worker / Backend
│   ├── actions/
│   ├── audit/
│   ├── auth/
│   ├── cache/
│   ├── cron/
│   ├── db/
│   ├── errors/
│   ├── middleware/
│   ├── providers/
│   ├── repositories/
│   ├── routes/
│   ├── scanner/
│   ├── search/
│   ├── services/
│   ├── types/
│   └── index.ts
│
├── frontend/
│   ├── src/
│   │   ├── api/                  # 前端 API 边界
│   │   ├── app/                  # App / Controller / Navigation
│   │   ├── components/           # 通用组件
│   │   ├── design-system/        # Design System 拆分模块
│   │   ├── features/             # 按业务领域拆分
│   │   ├── hooks/
│   │   ├── lib/
│   │   ├── state/
│   │   ├── styles/
│   │   └── types/
│   ├── package.json
│   └── vite.config.ts
│
├── server/                       # Node / SQLite 验证与运行支持
├── tests/
│   ├── unit/
│   └── integration/
├── docs/
│   └── architecture/
├── scripts/
├── architecture-check.mjs
├── contrast-check.mjs
├── cascade-check.mjs
├── package.json
└── wrangler.toml
```

---

## 前端架构

当前前端采用 **App Shell → Controller → Feature → ViewModel → Component** 的分层方式。

```text
App.tsx
  │
  ▼
AppController / AppProviders / AppShell
  │
  ▼
useAppControllerView
  │
  ├── controller/useAppAlerts
  ├── controller/useAppDataState
  ├── controller/useAppUiState
  ├── controller/useAppControllerNavigation
  └── 其他 Controller Capability
  │
  ▼
features/*
  │
  ▼
Hooks / Services / ViewModels
  │
  ▼
UI Components
```

`App.tsx` 保持为路由与应用装配入口，不再承载整个应用的业务逻辑。

`useAppControllerView.tsx` 负责应用级组合，但具体能力应该继续进入独立 Controller 边界，而不是重新堆积回单一 Hook。

### Controller Navigation

跨模块跳转集中在：

```text
frontend/src/app/controller/useAppControllerNavigation.ts
```

它负责 DNSHE / Cloudflare / DigitalPlat 等模块之间的跳转、搜索上下文同步及相关高亮触发，避免页面组件直接操作跨 feature 状态。

---

## 后端架构

后端遵循：

```text
Route
  ↓
Service
  ↓
Repository / Provider Adapter
  ↓
Database / External API
```

Route 层不应直接：

- 构造 Provider Client
- 直接从 DatabaseManager 创建业务 Service
- 承载复杂业务流程

服务商差异应收敛到 Provider / Adapter / Service 层，Route 保持轻量。

---

## Scanner 架构

Scanner 是当前重构程度最高的功能之一。

```text
RegisterPage
  │
  ├── ScannerModeTabs
  ├── SingleDomainPanel
  └── BatchScannerConfig
       │
       ├── BatchRuleEditor
       ├── WordBankPanel
       ├── ReservedPrefixPanel
       ├── SequentialScannerPanel
       ├── BatchBasicOptions
       ├── RootDomainSelector
       └── ScannerControlBar
```

Scanner Hook 进一步拆分：

```text
useScanner
├── useScannerState
├── useScannerWordBanks
├── useScannerBatchScan
├── useScannerWhois
├── useScannerRootDomains
└── useScannerReservedPrefixes
```

批量扫描执行链：

```text
规则解析
  ↓
Batch Planner
  ↓
Batch Pool
  ↓
Batch Executor
  ↓
API / Worker
  ↓
React State
  ↓
Scanner ViewModel
  ↓
UI
```

Scanner UI 不应直接依赖完整的 `UseScannerReturn`，子组件通过 `scanner-view-model.ts` 获取对应能力切片。

---

## 主题系统

系统目前包含多个主题，其中包括：

- 默认主题
- 深色主题
- **流玻 · 液态玻璃**

主题由 Design System、主题 Token、组件样式和全局 CSS 共同组成。

主题选择器必须同时维护：

```text
视觉样式
+
独立 selected 状态标记
+
当前主题指示
```

`ThemePicker` 使用独立的 `data-selected="true"` 标记维护选中态，避免主题自身的 `!important` 或层叠规则覆盖选中高亮。

主题修改后应至少运行：

```bash
npm run check:theme
```

---

## Phase 4 重构内容

Phase 4 重点解决应用层和大型 Feature 文件的职责过载问题。

### 4-B Controller Boundary

新增：

```text
frontend/src/app/controller/useAppControllerNavigation.ts
```

将跨模块导航、搜索同步及跳转高亮从 `useAppControllerView.tsx` 中抽离。

### 4-C Design System

`DesignSystem.tsx` 从大型展示文件拆成：

```text
frontend/src/design-system/
├── primitives.tsx
└── sections/
    ├── DesignSystemTheme.tsx
    ├── DesignSystemControls.tsx
    ├── DesignSystemInputs.tsx
    └── DesignSystemAdvanced.tsx
```

### 4-D Cloudflare DNS Panel

`useCfDnsPanel.ts` 的状态、元数据及动作拆分为：

```text
frontend/src/features/dns/hooks/cf-dns-panel/
├── useCfDnsPanelState.ts
├── useCfDnsPanelMeta.ts
└── useCfDnsPanelActions.ts
```

### 4-E Settings

`SettingsPage.tsx` 拆分为多个独立设置区块：

```text
frontend/src/features/settings/components/sections/
├── SettingsAppearance.tsx
├── SettingsBackend.tsx
├── SettingsSecurity.tsx
├── SettingsRenewal.tsx
├── SettingsNotifications.tsx
└── SettingsDataBackup.tsx
```

### 4-F Custom Providers

自定义服务商 Hook 拆为状态、数据、动作及类型边界：

```text
frontend/src/features/custom/hooks/custom-providers/
├── types.ts
├── useCustomProvidersState.ts
├── useCustomProvidersData.ts
└── useCustomProvidersActions.ts
```

### 4-G API Request Boundary

新增：

```text
frontend/src/api/request.ts
```

统一处理：

- HTTP status
- JSON 解析
- API 错误
- 网络异常
- 请求结果类型

业务模块不应重新自行实现重复的 `response.json()` / 错误转换逻辑。

---

## 本地开发

### 1. 安装根依赖

```bash
npm install
```

### 2. 安装前端依赖

```bash
npm --prefix frontend install
```

根目录与 `frontend` 是两个独立的 npm package，因此必须分别安装依赖。

### 3. 启动 Worker

```bash
npm run dev
```

### 4. 启动前端

```bash
npm --prefix frontend run dev
```

### 5. 前端生产构建

```bash
npm --prefix frontend run build
```

Self-host 构建：

```bash
npm --prefix frontend run build:selfhost
```

---

## 验证与测试

推荐在提交修改前运行完整验证：

```bash
npm run verify:all
```

该命令包含：

```text
Architecture Check
Worker TypeScript Check
Worker Build
Invariant Tests
Node Verification
Node Unit Tests
Frontend Build
Theme / Contrast Check
```

### 单项验证

架构：

```bash
npm run check:architecture
```

Worker TypeScript：

```bash
npm run verify:worker
```

Worker Build：

```bash
npm run build:worker
```

全部不变量测试：

```bash
npm run test:invariants
```

Node 验证：

```bash
npm run verify:node
```

主题检查：

```bash
npm run check:theme
```

前端 TypeScript：

```bash
npm --prefix frontend run typecheck
```

---

## 测试覆盖重点

当前测试包括：

- DNS State Machine
- Search Ranking
- Provider Registry
- Scanner Worker
- Scanner Sequence
- Scanner Batch Planner
- Scanner Batch Executor
- Telegram Notification
- Backup Diff
- API HTTP Boundary
- Architecture Integration
- D1 / SQLite
- Huawei Cloud Signature
- Credentials

新增业务能力时，应优先同时增加对应的单元测试或架构回归测试。

---

## 架构约束

`architecture-check.mjs` 是本项目重要的长期护栏。

它会检查包括但不限于：

- `App.tsx` 不得重新膨胀
- `useAppControllerView.tsx` 保持在受控范围
- Controller Capability 文件必须存在
- Scanner Page / Hook 保持轻量
- Scanner 不得绕过 storage boundary 直接读写 `localStorage`
- Scanner 子组件不得直接调用 `useScanner`
- Phase 4 大型 Feature 文件不得重新变成 God File
- API 业务层不得绕过 `apiJson()` 自行解析响应 JSON
- Route 层不得直接实例化 Provider Client
- Route 层不得直接构造业务 Service
- ThemePicker 必须保留独立的 selected marker

目的不是追求“文件行数越少越好”，而是防止已经解决的架构问题重新出现。

---

## 设计原则

### 1. 页面负责组合，不负责实现全部业务

页面组件应主要完成布局、组合和事件连接。

### 2. Hook 负责单一能力

一个 Hook 如果同时管理 UI 状态、网络请求、缓存、持久化、业务规则和复杂执行流程，应继续拆分。

### 3. 跨模块行为进入 Controller / Service

不要在任意页面里直接操作其他 feature 的内部状态。

### 4. UI 通过 ViewModel 获取所需数据

大型业务 Hook 返回的完整对象不应直接传给所有子组件。

### 5. API 错误统一处理

前端网络错误、HTTP 错误和后端业务错误应在 API Boundary 统一归一化。

### 6. 保留行为，优先降低耦合

重构默认要求：

```text
功能行为不变
API 契约不变
视觉行为不变
数据格式不变
```

只有在明确的修复任务中才修改实际业务行为。

---

## 通知系统

Telegram / Webhook 发送结果必须明确区分：

```text
ok: true
```

与：

```text
ok: false
```

网络异常、HTTP 错误以及 Telegram API 返回 `ok:false` 都不得被包装成成功响应。

前端的“测试消息已发送”提示必须建立在真实的成功结果之上。

---

## 数据与持久化

Scanner 的本地持久化通过独立 storage boundary 管理，包括：

- 自定义根域名
- 保留前缀
- 保留过滤开关
- 扫描游标

业务 Hook 不应重新直接操作这些 `localStorage` Key。

---

## 生产构建与部署

Domain Hub 2.0 当前提供三条正式部署路径：

```text
A. Cloudflare Worker 手动部署
   本地电脑 → Wrangler → Cloudflare Worker + D1

B. GitHub Actions 自动部署
   push main / 手动运行 Workflow → GitHub Actions → Cloudflare Worker + D1

C. Docker / 自建部署
   GHCR 镜像 或 本地 Docker Build → Docker Compose → Node + SQLite
```

三种方式使用同一套业务代码，但运行时的数据层不同：

| 部署方式 | API | 数据库 | 定时任务 | 前端 |
|---|---|---|---|---|
| Cloudflare Worker | Hono / Worker | D1 | Cron Trigger | Worker Static Assets |
| GitHub Actions → Worker | 同上 | D1 | Cron Trigger | Worker Static Assets |
| Docker | Hono / Node | SQLite | Node 内置定时器 | Node 同端口静态托管 |

> 推荐生产环境优先使用 **GitHub Actions → Cloudflare Worker**。它最适合持续发布，并且仓库已经提供 `.github/workflows/deploy.yml`。如果希望完全脱离 Cloudflare Worker，则使用 Docker。

---

### 部署前统一准备

无论选择哪一种方式，先确认：

```bash
node -v
npm -v
```

Node.js 建议使用当前 `package.json` 要求的：

```text
Node.js >= 22.5.0
```

安装依赖：

```bash
npm install
npm --prefix frontend install
```

然后执行完整验证：

```bash
npm run verify:all
```

生产部署前至少应该看到：

```text
Architecture             PASS
Worker TypeScript        PASS
Worker Build             PASS
Invariant Tests          PASS
Node Verification       PASS
Node Tests               PASS
Frontend Build           PASS
Theme / Contrast         PASS
```

---

## 部署方式选择

### 选择 Cloudflare Worker，如果你需要

- Cloudflare 原生 D1
- Cloudflare Cron Trigger
- Workers Static Assets
- 全球边缘部署
- 不维护服务器
- GitHub push 后自动发布

### 选择 Docker，如果你需要

- 自己掌控服务器
- SQLite 本地数据库
- 不依赖 Cloudflare Worker
- 内网部署
- 家庭服务器 / NAS / VPS / Docker 主机
- 通过 Nginx、Caddy 或其他网关自行反代

---

## 方案 A：Cloudflare Worker 手动部署

### A-1. 登录 Cloudflare

```bash
npx wrangler login
npx wrangler whoami
```

`wrangler login` 适合本地交互开发；CI/CD 推荐使用 API Token，因为 Token 可以按账号、Worker、Zone 精细限制权限。Cloudflare 当前文档也将 API Token 定位为 CI/CD、脚本和自动化系统的推荐凭据。[Cloudflare Workers 授权与 API Token](https://developers.cloudflare.com/workers/authorization/)

### A-2. 创建 D1

```bash
npx wrangler d1 create domain-hub-db
```

记下返回的：

```text
数据库名称：domain-hub-db
数据库 ID：xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

然后修改 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "domain-hub-db"
database_id = "你的 D1 database_id"
```

### A-3. 初始化远程 D1

```bash
npx wrangler d1 execute domain-hub-db --remote --file=./schema.sql
```

生产数据库请明确使用 `--remote`，不要误把本地数据库当成线上库。

### A-4. 配置加密密钥

推荐主动生成并保存：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

然后：

```bash
npx wrangler secret put AES_KEY
```

粘贴生成的 64 位十六进制字符串。

> `AES_KEY` 一旦用于生产数据加密就不要随意更换。它用于解密已经写入数据库的 API Secret 与 2FA/TOTP 密钥。数据库备份必须与 AES_KEY 一起保存。

可选：

```bash
npx wrangler secret put ADMIN_TOKEN
```

通知：

```bash
npx wrangler secret put WEBHOOK_URL
npx wrangler secret put WEBHOOK_TYPE
```

### A-5. 构建前端

```bash
npm --prefix frontend run build
```

确认存在：

```text
frontend/dist/index.html
frontend/dist/assets/*
```

### A-6. 部署

```bash
npm run deploy
```

当前 `wrangler.toml` 使用：

```toml
[assets]
directory = "./frontend/dist"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*"]
```

因此 API 和 React 前端由同一个 Worker 提供，不需要单独部署 Cloudflare Pages。

---

## Cloudflare API Token 创建

GitHub Actions 部署不要使用个人账户密码，也不要把 Global API Key 放进仓库。推荐建立专用 API Token，并只授予 Domain Hub 所需权限。

Cloudflare 当前创建 Token 的入口是：

```text
Cloudflare Dashboard
→ My Profile
→ API Tokens
→ Create Token
```

本仓库的 GitHub Actions 示例默认按 **User API Token** 编写，因为 Workflow 使用 `CLOUDFLARE_API_TOKEN` 调用 Wrangler，并可通过 `/user/tokens/verify` 做 Token 状态验证。Cloudflare 也支持 Account API Token；如果改用 Account API Token，应使用对应 Account 的 Token 验证接口，并确认所用 Wrangler/API 操作支持该 Token 类型。Cloudflare 官方当前文档说明，API Token 在生成后只显示一次，应立即保存到安全位置。[Cloudflare 创建 API Token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)

### 推荐的 Token 名称

例如：

```text
Domain-Hub-GitHub-Actions
```

如果你希望区分生产和测试环境，可以分别创建：

```text
Domain-Hub-Production
Domain-Hub-Staging
```

### Token 的资源范围

推荐只允许访问 Domain Hub 使用的 Cloudflare Account。

如果 Token 页面支持更细的 Worker 资源范围，长期 Token 应只作用于：

```text
Worker: domain-hub
```

而不是整个 Cloudflare 账号里的所有 Worker。

---

## Cloudflare Token 必要权限

这是当前仓库 `.github/workflows/deploy.yml` 对应的权限说明。

### 最小推荐配置

| 类别 | 权限 | 范围 | 用途 |
|---|---|---|---|
| Account / Workers | Workers Scripts Edit（新权限模型可对应 Workers Editor） | `domain-hub` Worker 或账号 | `wrangler deploy`、Worker 代码更新、Secret 写入 |
| Account / D1 | D1 Edit | 当前 Cloudflare Account | **仅当**让 Workflow 自动查找/创建 D1 时需要 |
| Zone | Zone Read | 使用自定义域名的 Zone | Workflow 自动检测 Zone |
| Zone | Workers Routes Read | 使用自定义域名的 Zone | Workflow 自动检测既有 Worker Route |

Cloudflare 当前文档规定：部署已经存在的 Worker 至少需要 Worker Editor；如果部署过程还需要变更 Route 或 Custom Domain，则还需要受影响 Zone 的 `Workers Routes Write`。绑定 D1 时，部署 Worker 本身不需要额外的 D1 权限；D1 权限主要用于直接读取/写入数据库或创建数据库。[Cloudflare Workers 权限模型](https://developers.cloudflare.com/workers/authorization/workers/)；[Cloudflare API Token 权限](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)

### 关于 D1：两种模式

本仓库的 Workflow 支持两种方式。

#### 模式 1：推荐的最小权限模式

先手动创建 D1：

```bash
npx wrangler d1 create domain-hub-db
```

然后把 D1 ID 放进 GitHub Secret：

```text
CLOUDFLARE_D1_DATABASE_ID
```

这样 Workflow 会直接使用这个 ID，不需要调用“创建 D1”接口。

这种模式下，CI Token 可以不授予 `D1 Edit`。

#### 模式 2：一键创建 D1

不配置：

```text
CLOUDFLARE_D1_DATABASE_ID
```

Workflow 会尝试：

```text
查询 domain-hub-db
      ↓
存在 → 使用现有数据库
不存在 → 创建 domain-hub-db
      ↓
写回 wrangler.toml
```

此时 Token 必须有：

```text
Account → D1 Edit
```

Cloudflare 当前 API 权限表明确提供 `D1 Read` 和 `D1 Edit`，D1 通过 HTTP API 写入时也要求 D1 Edit。[Cloudflare API Token 权限](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)；[Cloudflare D1 Release Notes](https://developers.cloudflare.com/d1/platform/release-notes/)

### 关于 Zone / Workers Routes 权限

当前仓库的 Workflow 会自动尝试检测：

```text
Custom Domains
Worker Routes
workers.dev 子域
```

所以如果你希望“自动检测自定义域名并把访问 URL 写入 GitHub Actions Summary”，保留：

```text
Zone → Zone Read
Zone → Workers Routes Read
```

即可。

当前 Workflow **不会主动创建、修改或删除 Worker Route / Custom Domain**，因此仅为了当前自动检测逻辑，不需要 `Workers Routes Write`。

如果以后修改 Workflow，让它自动创建/修改 Route 或 Custom Domain，再增加：

```text
Zone → Workers Routes Write
```

Cloudflare 当前官方文档对此权限要求有明确说明。[Cloudflare Workers 角色与权限](https://developers.cloudflare.com/workers/authorization/workers/)

### 第一次创建 Worker 的权限

Cloudflare 当前权限模型规定：如果目标 Worker 尚不存在，创建新 Worker 需要 Workers product-level Admin；仅有已经存在 Worker 的 per-Worker Editor 权限不能创建这个 Worker。[Cloudflare Workers 角色与权限](https://developers.cloudflare.com/workers/authorization/workers/)

因此第一次部署有两个选择：

#### 方案 A：先在 Dashboard 创建 Worker

先手动创建：

```text
Workers & Pages
→ Create
→ Worker
→ domain-hub
```

创建后，CI Token 使用较小权限即可。

#### 方案 B：允许首次 CI 创建 Worker

临时使用：

```text
Workers → Admin
```

完成首次部署后立即更换为长期低权限 Token。

> 推荐方案 A。这样可以避免长期 CI Token 持有创建/删除所有 Worker 的权限。

### 是否应该使用“Edit Cloudflare Workers”模板？

Cloudflare 当前提供的 `Edit Cloudflare Workers` 模板会一次性带上多个 Worker 相关权限，其中包含 Routes、KV、R2 等，不一定全部被 Domain Hub 使用。[Cloudflare API Token 模板](https://developers.cloudflare.com/fundamentals/api/reference/template/)

因此：

```text
追求简单：使用模板，再按资源范围收窄。
追求最小权限：使用 Custom Token，只给 Domain Hub 实际使用的权限。
```

---

## Token 创建后的验证

Cloudflare 官方提供：

```bash
curl "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

正常应该看到：

```json
{
  "success": true,
  "result": {
    "status": "active"
  }
}
```

该接口用于确认 Token 是否有效以及是否处于 active 状态。[Cloudflare Verify Token API](https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/)；[Cloudflare 创建 API Token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)

PowerShell：

```powershell
$headers = @{ Authorization = "Bearer $env:CLOUDFLARE_API_TOKEN" }
Invoke-RestMethod `
  -Uri "https://api.cloudflare.com/client/v4/user/tokens/verify" `
  -Headers $headers
```

不要把真实 Token 直接写进命令历史；推荐先放进当前终端环境变量。

---

## 方案 B：GitHub Actions 自动部署到 Cloudflare

仓库已经提供：

```text
.github/workflows/deploy.yml
```

它会在：

```text
push → main
```

或者：

```text
GitHub → Actions → Deploy to Cloudflare → Run workflow
```

时执行。

### Workflow 实际执行顺序

```text
Checkout
  ↓
Node.js 22
  ↓
npm ci
frontend npm ci
  ↓
D1 查询 / 创建 / 绑定
  ↓
检测 Custom Domain / Worker Routes
  ↓
frontend build
  ↓
wrangler deploy
  ↓
AES_KEY 检查 / 创建 / 同步
  ↓
可选 ADMIN_TOKEN / WEBHOOK_URL / ALLOWED_ORIGIN
  ↓
输出最终访问地址
```

也就是说，不能只把代码推到 GitHub 就认为部署完成；Cloudflare Token、Account ID 以及必要的 Secrets 必须先配置。

---

## GitHub Secrets 配置

进入：

```text
GitHub Repository
→ Settings
→ Secrets and variables
→ Actions
→ New repository secret
```

GitHub 官方当前的仓库 Secret 配置入口就是该路径，Secret 会在 Workflow 中显式引用时才注入。[GitHub Actions Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)；[GitHub Secrets 概览](https://docs.github.com/en/actions/concepts/security/secrets)

### 必填 Secret

#### `CLOUDFLARE_API_TOKEN`

值：

```text
刚刚创建的 Cloudflare API Token
```

不要提交到：

```text
.env
wrangler.toml
README.md
源码
```

#### `CLOUDFLARE_ACCOUNT_ID`

Cloudflare Account ID。

常见获取位置：

```text
Cloudflare Dashboard
→ 对应 Account
→ Overview / Account Home
→ Account ID
```

### 强烈推荐

#### `CLOUDFLARE_D1_DATABASE_ID`

推荐手动创建 D1 后填入：

```text
xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

这样 CI 不需要创建 D1，Token 可以进一步收权。

### `AES_KEY`

推荐主动配置。

生成：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

把输出保存为 GitHub Secret：

```text
AES_KEY
```

Workflow 的行为是：

```text
有 GitHub AES_KEY
   ↓
同步该值到 Worker

没有 GitHub AES_KEY
   ↓
Worker 已存在 AES_KEY？
   ├─ 是 → 保持原值
   └─ 否 → 自动生成随机 AES_KEY
```

> 生产环境推荐你自己保存 `AES_KEY`，这样服务器、Cloudflare、备份系统之间的恢复关系更清晰。

### 可选 Secret

| Secret | 用途 |
|---|---|
| `ADMIN_TOKEN` | 应急管理员令牌 |
| `WEBHOOK_URL` | 全局 Webhook URL |
| `ALLOWED_ORIGIN` | 前后端分离部署时的 CORS 白名单 |

`ALLOWED_ORIGIN` 在当前同源部署中通常不需要。

---

## GitHub Actions 最小 Secrets 组合

### 推荐组合

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_D1_DATABASE_ID
AES_KEY
```

这是最适合长期生产运行的组合：

```text
D1 已提前创建
CI Token 不需要 D1 Create
AES_KEY 固定且可恢复
```

### 一键创建 D1 组合

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
AES_KEY
```

同时给 Token：

```text
D1 Edit
```

Workflow 会自动查找或创建 `domain-hub-db`。

---

## GitHub Actions 首次工作流部署

### 第 1 步：创建 D1（推荐手动）

```bash
npx wrangler d1 create domain-hub-db
```

保存 database ID。

### 第 2 步：创建 Cloudflare API Token

至少准备：

```text
Workers Scripts Edit / Workers Editor
```

如果不提前创建 D1，再增加：

```text
D1 Edit
```

如果需要自动检测自定义域名，再增加：

```text
Zone Read
Workers Routes Read
```

### 第 3 步：把 Token 放进 GitHub Secret

```text
CLOUDFLARE_API_TOKEN
```

### 第 4 步：配置 Account ID

```text
CLOUDFLARE_ACCOUNT_ID
```

### 第 5 步：配置 D1 ID

```text
CLOUDFLARE_D1_DATABASE_ID
```

### 第 6 步：配置 AES_KEY

```text
AES_KEY
```

### 第 7 步：执行 Workflow

```text
GitHub
→ Actions
→ Deploy to Cloudflare
→ Run workflow
```

或者：

```bash
git add .
git commit -m "deploy: domain hub"
git push origin main
```

### 第 8 步：检查日志

正常情况下应该看到：

```text
Install Dependencies
        ↓
Setup & Bind Cloudflare D1 Database
        ↓
Auto Detect Custom Domain
        ↓
Build Frontend
        ↓
Deploy Worker
        ↓
Auto-Configure & Sync AES_KEY
        ↓
Summarize Access URL
```

### 第 9 步：打开访问地址

Workflow 最后会输出：

```text
### 访问地址
https://你的域名
```

或者：

```text
https://domain-hub.<你的 workers.dev 子域>.workers.dev
```

首次访问后，在登录页面创建管理员用户名和密码。

---

## Cloudflare 部署验收

### 1. Worker

```bash
npx wrangler deployments list
```

### 2. 站点

打开：

```text
https://你的域名/
```

### 3. API

浏览器开发者工具：

```text
Network
→ /api/auth/status
```

### 4. D1

```bash
npx wrangler d1 execute domain-hub-db --remote \
  --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

### 5. Token / Worker Secret

```bash
npx wrangler secret list
```

不要把 Secret 的值打印进 CI 日志。

### 6. Cron

检查 Cloudflare Worker 的 Cron Trigger 是否存在，并在后续运行中查看 Worker 日志。

当前 `wrangler.toml` 的默认 Cron：

```text
0 2 * * *
30 2 * * *
```

按 UTC 解释，也就是北京时间 10:00 和 10:30。

---

## 方案 C：Docker / 自建部署

项目已经提供完整自建版：

```text
Dockerfile
 docker-compose.yml
 .dockerignore
 .env.example
 server/index.ts
 server/d1-sqlite.ts
```

Docker 运行时结构：

```text
Browser
  ↓
Nginx / Caddy / 直接 :8787
  ↓
Domain Hub Container
  ├── React Static Assets
  ├── Hono API
  ├── SQLite
  └── Node Cron Timer
```

### Docker 版与 Cloudflare 版差异

```text
Cloudflare:
D1 + Cron Trigger + Workers Static Assets

Docker:
SQLite + Node 定时器 + Node 静态文件服务
```

业务代码 `src/` 保持共用。

---

## Docker Compose 使用 GHCR 镜像

仓库的 `.env.example` 已经包含 Docker 版所有主要配置。

### C-1. 安装 Docker

确认：

```bash
docker --version
docker compose version
```

### C-2. 创建部署目录

Linux 示例：

```bash
sudo mkdir -p /opt/domain-hub
sudo chown -R $USER:$USER /opt/domain-hub
cd /opt/domain-hub
```

### C-3. 准备 Compose 文件

把仓库中的：

```text
docker-compose.yml
.env.example
```

复制到服务器：

```text
docker-compose.yml
.env
```

例如：

```bash
cp .env.example .env
```

### C-4. 编辑 `.env`

最小配置：

```dotenv
IMAGE_REPO=ghcr.io/lioil522/domain-hub
IMAGE_TAG=latest
TZ=Asia/Shanghai
```

实际 `docker-compose.yml` 当前使用固定的：

```text
ghcr.io/lioil522/domain-hub:latest
```

如果你准备使用 `.env` 中的镜像变量，建议按团队自己的发布策略调整 Compose 文件。

### C-5. AES_KEY

推荐生产环境主动配置：

```dotenv
AES_KEY=这里放64位十六进制随机字符串
```

生成：

```bash
openssl rand -hex 32
```

或者：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

如果留空，Node 服务首次启动会生成：

```text
/data/aes.key
```

并持久化在 Docker Volume 中。

### C-6. 启动

```bash
docker compose pull
docker compose up -d
```

查看：

```bash
docker compose ps
docker compose logs -f domain-hub
```

### C-7. 健康检查

```bash
curl http://127.0.0.1:8787/healthz
```

正常：

```json
{"ok":true}
```

Docker 镜像本身也已经包含 `HEALTHCHECK`，会定期请求 `/healthz`。

### C-8. 首次访问

浏览器：

```text
http://服务器IP:8787
```

然后在登录页面自行设置管理员用户名和密码。

---

## Docker 从源码构建

如果你不想依赖 GHCR，也可以直接从源码构建。

### C-9. 构建镜像

在仓库根目录：

```bash
docker build -t domain-hub:local .
```

Dockerfile 是多阶段构建：

```text
阶段 1：前端
node:24-bookworm-slim
→ npm ci
→ npm run build:selfhost

阶段 2：后端
node:24-bookworm-slim
→ npm ci
→ tsc
→ Node / SQLite 测试
→ esbuild

阶段 3：运行时
node:24-bookworm-slim
→ 只复制最终 server.mjs
→ 只复制 frontend/dist
→ 不携带 node_modules
→ node 用户运行
```

### C-10. 使用本地镜像启动

最简单：

```bash
docker run -d \
  --name domain-hub \
  -p 8787:8787 \
  -v domain-hub-data:/data \
  -e TZ=Asia/Shanghai \
  -e AES_KEY="你的AES_KEY" \
  domain-hub:local
```

然后：

```bash
curl http://127.0.0.1:8787/healthz
```

### C-11. 使用 Compose 启动本地镜像

把 `docker-compose.yml` 中：

```yaml
image: ghcr.io/lioil522/domain-hub:latest
```

改成：

```yaml
image: domain-hub:local
```

再执行：

```bash
docker compose up -d
```

> 当前 Compose 文件只有 `image:`，没有 `build:`。因此仅执行 `docker compose up -d --build` 不会自动根据 Dockerfile 构建本地镜像；需要先执行 `docker build -t domain-hub:local .`，或者自行在 Compose 中增加 `build: .`。

---

## Docker 架构与多平台

当前 GitHub Actions Docker Workflow 会原生构建：

```text
linux/amd64
linux/arm64
```

因此服务器是：

```text
Intel / AMD VPS
```

或：

```text
ARM64 NAS / ARM 云服务器
```

都可以直接拉对应多架构镜像。

本地构建只针对当前 Docker 架构；需要交叉构建时：

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t domain-hub:local-multi \
  .
```

---

## Docker GitHub Actions 自动构建

仓库提供：

```text
.github/workflows/docker.yml
```

它会：

```text
push branch
   ↓
构建 amd64 + arm64
   ↓
运行容器冒烟测试
   ↓
检查 /healthz
   ↓
检查首次初始化
   ↓
检查鉴权 401
   ↓
检查登录 Session
   ↓
检查前端静态资源
   ↓
检查 Cron 排程
   ↓
检查镜像没有 node_modules
   ↓
检查非 root 用户
   ↓
推送 GHCR
   ↓
合并多架构 manifest
```

### Docker Workflow 的 GitHub Token 权限

`.github/workflows/docker.yml` 已经声明：

```yaml
permissions:
  contents: read
  packages: write
```

因此它使用 GitHub Actions 自动提供的：

```text
GITHUB_TOKEN
```

向同一仓库对应的 GHCR 发布镜像，不需要另外创建一个 GitHub PAT。GitHub 官方当前也推荐在 GitHub Actions 发布 Container Registry 包时使用 `GITHUB_TOKEN`，并授予 `packages: write`。[GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)；[GitHub Actions 发布 Docker 镜像](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)

### Docker Workflow 的发布规则

当前：

```text
main
 ↓
latest
```

例如：

```text
v2.1.0
 ↓
2.1.0
2.1
```

Pull Request 只进行构建和冒烟测试，不推送正式镜像。

---

## GHCR 私有镜像拉取

如果 GHCR Package 设置为 Public：

```bash
docker pull ghcr.io/<owner>/<repo>:latest
```

无需登录。

如果 Package 是 Private，则服务器需要登录 GHCR。

GitHub Container Registry 的命令行私有包认证使用 Personal Access Token (classic)，拉取私有包至少需要 `read:packages`。GitHub 官方也说明，GitHub Actions 自己发布仓库关联包时优先使用 `GITHUB_TOKEN`。[GitHub Container Registry 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

### 创建 GHCR 拉取 Token

GitHub：

```text
Settings
→ Developer settings
→ Personal access tokens
→ Tokens (classic)
→ Generate new token (classic)
```

至少：

```text
read:packages
```

如果需要从命令行直接管理私有包，再按实际操作增加其他权限；Docker 服务器仅拉取镜像通常只需要 `read:packages`。

### 登录服务器

```bash
echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u <你的GitHub用户名> --password-stdin
```

然后：

```bash
docker compose pull
docker compose up -d
```

不要把 Token 写进 `docker-compose.yml`。

---

## Docker 数据、备份与升级

Docker 版最重要的数据在：

```text
/data
```

包括：

```text
/data/domain-hub.db
/data/domain-hub.db-wal
/data/domain-hub.db-shm
/data/aes.key
```

实际文件名以当前程序启动时输出为准。

### 备份 Volume

先停机：

```bash
docker compose stop
```

查看 Volume：

```bash
docker volume ls | grep domain-hub
```

推荐将 Volume 中的 `/data` 做定期备份。

如果使用 Compose 默认 Volume：

```bash
docker inspect domain-hub
```

找到：

```text
Mounts
```

对应的宿主机 Volume 信息。

### 更简单的文件级备份

如果你明确使用 Docker named volume，可以临时挂载另一个容器进行打包：

```bash
docker run --rm \
  -v domain-hub-data:/data:ro \
  -v "$PWD:/backup" \
  alpine \
  tar czf /backup/domain-hub-data-$(date +%F).tar.gz /data
```

恢复：

```bash
docker run --rm \
  -v domain-hub-data:/data \
  -v "$PWD:/backup" \
  alpine \
  tar xzf /backup/domain-hub-data-YYYY-MM-DD.tar.gz -C /
```

> 恢复前先停止 Domain Hub，避免 SQLite 在运行中被覆盖。

### 升级 GHCR 镜像

```bash
docker compose pull
docker compose up -d
```

查看：

```bash
docker compose ps
docker compose logs --tail=100 domain-hub
```

### 升级后检查

```bash
curl http://127.0.0.1:8787/healthz
```

然后打开面板检查：

```text
登录
账号
域名
DNS
Scanner
设置
通知
日志
```

---

## Docker Cron 与时区

Cloudflare 版使用 Cron Trigger；Docker 版则由 `server/index.ts` 启动一个 Node 定时器。

默认：

```dotenv
CRON_UTC_HOUR=2
CRON_UTC_MINUTE=0
```

它按 UTC 调度。

北京时间：

```text
UTC 02:00
= 北京时间 10:00
```

如果需要北京时间凌晨 2 点：

```dotenv
CRON_UTC_HOUR=18
CRON_UTC_MINUTE=0
```

关闭自动同步/续期：

```dotenv
DISABLE_CRON=1
```

然后手动同步。

---

## Docker 端口与反向代理

默认：

```text
8787
```

局域网或测试环境可以直接：

```text
http://服务器IP:8787
```

生产环境推荐：

```text
Internet
   ↓
HTTPS 443
   ↓
Nginx / Caddy
   ↓
127.0.0.1:8787
   ↓
Domain Hub
```

### 推荐 Compose 端口绑定

将：

```yaml
ports:
  - "8787:8787"
```

改为：

```yaml
ports:
  - "127.0.0.1:8787:8787"
```

这样 Docker 服务不会直接暴露到公网，由 Nginx/Caddy 统一处理 TLS。

---

## 反向代理与 HTTPS

### Nginx 示例

```nginx
server {
    listen 443 ssl http2;
    server_name hub.example.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

HTTP → HTTPS：

```nginx
server {
    listen 80;
    server_name hub.example.com;
    return 301 https://$host$request_uri;
}
```

### Caddy 示例

```text
hub.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy 会负责 HTTPS 证书申请和续期。

### CORS

Docker 前后端同源时：

```dotenv
ALLOWED_ORIGIN=
```

通常保持为空。

只有前端与 API 被拆到不同域名时才配置：

```dotenv
ALLOWED_ORIGIN=https://frontend.example.com
```

---

## Docker 安全建议

### 1. 不要把 8787 直接暴露到公网

生产：

```yaml
ports:
  - "127.0.0.1:8787:8787"
```

### 2. 保持数据目录持久化

必须保留：

```yaml
volumes:
  - domain-hub-data:/data
```

否则删除容器后数据库和 AES_KEY 都可能一起丢失。

### 3. 不要频繁更换 AES_KEY

更换 AES_KEY 之前必须确认是否需要重新加密历史 Secret；不要直接“为了安全”随机换一个。

### 4. 私有 GHCR Token 不要进 Compose

使用：

```bash
docker login ghcr.io
```

或者服务器 Secret 管理系统。

### 5. 镜像尽量按 Digest 固定

Tag：

```text
ghcr.io/lioil522/domain-hub:latest
```

会随着发布变化。

更严格的生产部署可以固定：

```text
ghcr.io/lioil522/domain-hub@sha256:xxxxxxxx...
```

这样发布与回滚完全可复现。GitHub 官方也支持按 digest 拉取容器镜像。[GitHub Container Registry 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

---

## 发布与回滚

### Cloudflare 回滚思路

部署 Worker 后先观察：

```text
登录
API
账号
DNS
Cron
日志
```

Cloudflare Worker 保留历史版本，可以通过 Dashboard 或 Wrangler 管理部署版本。生产环境不要在刚上线后立即删除旧版本。

### Docker 回滚到上一个 tag

例如现在：

```text
ghcr.io/lioil522/domain-hub:2.1.0
```

出现问题后切回：

```text
2.0.9
```

修改 `.env` / Compose 中的镜像版本：

```dotenv
IMAGE_TAG=2.0.9
```

然后：

```bash
docker compose pull
docker compose up -d
```

### Digest 回滚

如果需要绝对固定某次构建：

```text
ghcr.io/lioil522/domain-hub@sha256:<digest>
```

切换后：

```bash
docker compose pull
docker compose up -d
```

### 回滚前不要删除数据卷

代码版本可以回滚，但：

```text
/data
```

必须保持不变。

数据库 schema 的升级如果不可逆，要先备份再升级。

---

## 完整 GitHub Actions + Cloudflare 发布清单

```text
[ ] GitHub 仓库已准备
[ ] Cloudflare Account ID 已确认
[ ] Worker domain-hub 已创建（推荐首次手动创建）
[ ] D1 domain-hub-db 已创建
[ ] D1 Database ID 已记录
[ ] Cloudflare API Token 已创建
[ ] Token 使用最小权限
[ ] CLOUDFLARE_API_TOKEN 已加入 GitHub Secrets
[ ] CLOUDFLARE_ACCOUNT_ID 已加入 GitHub Secrets
[ ] CLOUDFLARE_D1_DATABASE_ID 已加入 GitHub Secrets
[ ] AES_KEY 已加入 GitHub Secrets
[ ] ADMIN_TOKEN（可选）
[ ] WEBHOOK_URL（可选）
[ ] ALLOWED_ORIGIN（通常为空）
[ ] npm run verify:all 本地通过
[ ] Push main 或手动运行 Workflow
[ ] Workflow Build Frontend 通过
[ ] Workflow Deploy Worker 通过
[ ] AES_KEY Sync 通过
[ ] Actions Summary 出现访问地址
[ ] 浏览器能打开首页
[ ] 首次管理员初始化成功
[ ] /api/auth/status 正常
[ ] D1 表已存在
[ ] Cron Trigger 正常
```

---

## 完整 Docker 发布清单

```text
[ ] Docker / Docker Compose 已安装
[ ] 服务器目录已创建
[ ] docker-compose.yml 已准备
[ ] .env 已准备
[ ] GHCR 为 Public，或服务器已 docker login ghcr.io
[ ] AES_KEY 已准备或确认自动生成
[ ] /data 已持久化
[ ] 端口仅本机暴露
[ ] Nginx / Caddy HTTPS 已配置
[ ] docker compose pull
[ ] docker compose up -d
[ ] /healthz 返回 {"ok":true}
[ ] 首次管理员初始化成功
[ ] 登录成功
[ ] 账号 / 域名 / DNS 正常
[ ] Cron 日志正常
[ ] 数据 Volume 已备份
[ ] AES_KEY 已备份
```

---

## 官方部署参考

Cloudflare：

- API Token 创建：<https://developers.cloudflare.com/fundamentals/api/get-started/create-token/>
- API Token 权限：<https://developers.cloudflare.com/fundamentals/api/reference/permissions/>
- Workers 授权：<https://developers.cloudflare.com/workers/authorization/>
- Workers 角色与 Wrangler：<https://developers.cloudflare.com/workers/authorization/workers/>
- D1 Wrangler：<https://developers.cloudflare.com/d1/wrangler-commands/>
- Static Assets / SPA：<https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/>

GitHub：

- Actions Secrets：<https://docs.github.com/en/actions/concepts/security/secrets>
- Actions 中使用 Secrets：<https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets>
- GHCR Container Registry：<https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry>
- GitHub Actions 发布 Docker 镜像：<https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images>

---

## 开发流程

推荐工作流：

```text
修改代码
  ↓
npm run check:architecture
  ↓
相关单元测试
  ↓
npm run verify:all
  ↓
人工 UI / 功能回归
  ↓
提交
```

涉及主题、Design System 或视觉层的修改时，再检查：

```bash
npm run check:theme
```

涉及 API Boundary 时，再运行：

```bash
npm run test:unit:api-http
```

涉及 Scanner 时，再运行：

```bash
npm run test:unit:scanner
npm run test:unit:scanner-sequence
npm run test:unit:scanner-batch-planner
npm run test:unit:scanner-batch-executor
```

---

## 当前阶段

### 已完成

- App / Controller 基础拆分
- Scanner 多阶段拆分
- Scanner ViewModel Boundary
- Scanner Storage Boundary
- Scanner Batch Planner / Pool / Executor
- DNSHE Modal Boundary
- Controller Navigation Boundary
- Design System Boundary
- Cloudflare DNS Panel Boundary
- Settings Boundary
- Custom Providers Boundary
- BIND Form Schema Boundary
- API Request / Error Boundary
- Architecture Guardrails
- Theme selected-state guard

### 当前维护重点

1. 保持 Phase 4 边界稳定，不让大文件重新膨胀。
2. 持续补齐业务级测试与集成测试。
3. 做性能、Bundle 和运行时行为审计。
4. 清理死代码、重复类型及历史兼容层。
5. 继续降低 Controller 和 Feature 层之间的隐式耦合。

---

## 贡献与重构规则

提交大型重构时，请同时提供：

- 变更原因
- 受影响的架构边界
- 对应测试
- 架构 Guard 是否需要增加或更新
- UI 行为是否保持一致

不要通过“临时复制一个 Hook”“在页面中再加一个 API 请求”“直接读取其他模块内部状态”的方式绕开现有边界。

---

## License

本仓库当前 README 未定义独立的开源许可证条款。实际发布时请以仓库中的许可证文件或项目所有者的正式声明为准。
