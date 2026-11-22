# 请求来源、客户端 IP 与初始化授权（2026-11-22）

第 2 项安全收尾，承接 Node 补救提交 `82bf9e3` 的三套远端成功验收。保留 Hono、共享 Worker/Node 业务及 schema v5，不更改 AES_KEY 或既有账户。

## CORS 与来源

- 空 `ALLOWED_ORIGIN` 真正默认同源，既不反射外域也不返回 `*`。
- 白名单为逗号分隔的明确 HTTP(S) origin，同源始终允许；兼容末尾 `/`，拒绝路径、凭据、`null`、通配符和无效配置（503），长度/条目数有界。
- 不可信 Origin 的**实际请求和预检**都在数据库/业务之前返回 403，而非仅隐藏响应。
- 补全 `PATCH`/`HEAD`；预检仅支持 Content-Type/Authorization，预检不访问数据库。
- Origin、请求方法、请求头均加入 Vary，并保留下游已有维度；错误响应也保留 CORS 头。
- 无 Origin 的 API 客户端仍需认证；浏览器明确标记 cross-site 却不带 Origin 时拒绝。CORS 不等于鉴权，也不能阻止任意非浏览器网络客户端。
- 不引入 cookie 跨域凭据；摘要诊断头可通过白名单跨域读取。

## 客户端 IP

运行时适配器产生每请求上下文，不通过“内部 HTTP 头”传递，公共 Worker 入口覆盖任何外部绑定中同名元数据。共享限流代码仅使用此上下文。

- Node 默认取 `incoming.socket.remoteAddress`，不信任 CF/X-Real-IP/XFF。
- `TRUSTED_PROXIES` 默认为空，只支持显式 IP/CIDR。只在 socket peer 可信时从右向左走 XFF，遇到第一个非信任地址停止；不直接使用最左端值。
- 无效/过长/超过 32 跳的链回退 socket，不从其他头补取。IPv6 和 IPv4-mapped IPv6 归一，避免同一 IP 因不同文本格式拆分限流计数。
- Node 的 `PUBLIC_ORIGIN` 显式声明 HTTPS 反代的对外来源；不从 Forwarded/X-Forwarded-Host/Proto 推断。
- Worker 只读边缘 CF-Connecting-IP，缺失/坏值统一 unknown，不退回 XFF。Cloudflare 官方文档明确同 zone Worker 子请求可影响该值，因此它是直接边缘 ingress 的限流信号，**不是跨 Worker 身份证明**；必须限制同 zone 不可信 Worker/错误代理配置。
- 反代必须追加它看到的真实 socket 地址或覆盖 XFF，且不能允许绕过反代；信任可被任意用户直连的广泛网段会重新引入伪造风险。

## 首次初始化

- 新安装须独立 `SETUP_TOKEN`，32–1024 非空白字符，建议另行随机 64 位 hex；不复用 AES_KEY/ADMIN_TOKEN，不内置默认值、不自动公开。
- 通过 `Authorization: Bearer <SETUP_TOKEN>` 发送，只授权尚未初始化的 setup；不能登录、访问管理 API 或重置已有账户。
- 缺/短配置返回 setup_locked 503；错误/缺授权码返回 401，失败按运行时 IP 限流到 429。持有有效高熵授权码的部署者不被匿名猜测锁死。
- 验证授权后才解析 JSON、进行密码哈希与原子 setup claim；拒绝 text/plain/表单媒体类型。原并发单获胜与失败回滚保证不变。
- 正向 setup 路径不增加 SQL，首 setup ≤50 与 bootstrap ≤44 门禁保留。
- 前端首次页面增加密码式授权码输入和未配置说明，只在 React 内存中保留；不进入 body、URL、浏览器持久存储或日志，成功后清空。旧 session 不覆盖显式的 setup Authorization。
- GitHub 部署同步同名 Secret，失败不忽略；缺值不清除 Worker 已有 Secret。Docker/Node 通过环境变量传入，Docker 冒烟使用隔离随机 token。
- 已有管理员/密码/2FA 不变；已初始化的 setup 永久拒绝。生产部署完成初始化后可删除 SETUP_TOKEN 配置，它不是日常登录令牌。

## 验证与边界

专项覆盖来源拒绝发生在 DB 之前、PATCH 预检/错误头、Vary、socket/代理链、IPv6、伪造元数据、缺/错 token、初始化锁与重放、真实 Node 进程限流，以及前端授权码生命周期。真实 workerd/Node 冒烟增加外域拒绝与未授权 setup 拒绝，再执行隔离授权初始化。

只有隔离数据测试，不更改生产账户或密钥。真实 TLS/反代拓扑、受限代理网段和用户账号内业务操作仍需部署者确认；不能把本地模拟代理头测试称为生产反代验收。GitHub 三套结果在提交后单独核对。

提交前全量 `verify:all` 成功：**375 个用例**、Worker/Node 构建与真实运行时冒烟、普通和自建前端、主题/发布产物/Docker 源码边界门禁通过。首 setup 与 bootstrap SQL 预算保持原门禁，不跳过 Node 并发启动测试。

参考（本批获取当前版本）：
- https://developers.cloudflare.com/fundamentals/reference/http-request-headers/
- https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
- https://github.com/honojs/node-server（HttpBindings/socket metadata）
