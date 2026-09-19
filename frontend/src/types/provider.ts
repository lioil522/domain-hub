/** 四个新接入托管商的 provider key（与后端 AccountProvider 取值严格一致） */
export type MultiProviderKey = "dnspod" | "alidns" | "huaweicloud" | "vercel";

/**
 * 跨来源搜索 / 时间轴跳转的来源键。
 *
 * WHY 单独定义而不直接用 TabKey：DNSHE / Cloudflare / DigitalPlat 在标签页里
 * 的 key 是 "domains" / "cloudflare" / "digitalplat"，但跳转分派用的是短键
 * ("dnshe" / "cf" / "dp")。这层映射是历史命名差异，收敛成一个类型让
 * toJumpSource 的返回值与 handleCrossSourceJump 的参数严格对齐，
 * 避免新增托管商时两边各改一半。
 */
export type JumpSource = "dnshe" | "cf" | "dp" | "custom" | MultiProviderKey;

/**
 * 绑定弹窗里可选的托管商。
 *
 * WHY 复用 MultiProviderKey 而不是再列一遍字符串：四个新托管商在绑定弹窗里的
 * 分支与在各自标签页里完全同名，手写第二遍必然和 MULTI_PROVIDER_META 漂移。
 */
export type BindProvider = "dnshe" | "cloudflare" | "digitalplat" | MultiProviderKey;
