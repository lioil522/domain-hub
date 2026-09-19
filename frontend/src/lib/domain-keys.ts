import { toASCII } from "../punycode";

/**
 * 域名匹配键：Punycode 小写 + 去首尾点（兼容 DNSHE 侧偶发的「.ddns.ge」空前缀形态）
 *
 * 从 `App.tsx` 抽出（Phase 5-1）。**纯搬运**，被 CF 到期推导、跨来源跳转与
 * DNSHE 交叉提示共用，因此放在 `lib/`（纯工具层，不依赖任何 App 状态）。
 *
 * NOTE: 放在 `lib/` 而非 `features/cloudflare/` —— 它是被多个 feature 共用的
 * 纯函数，若下沉到某个 feature 会让别的 feature 反向依赖它（feature→feature）。
 * 分层铁律：types → constants → lib → features。
 */
export const normalizeDomainKey = (value: string): string =>
  toASCII(String(value || "").trim().toLowerCase()).replace(/^\.+|\.+$/g, "");

/**
 * 判断是否为「注册域」（而非子域），与后端 /api/expiry 的 isRegistrableDomain 保持一致。
 * RDAP 只登记注册域，子域直接不查（显示 —，日期由用户手动补）；命中常见多段公共后缀
 * （co.uk 等）注册域应为 3 段，否则为 2 段。
 */
const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "ac.uk", "gov.uk",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "com.br", "net.br", "org.br",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "co.nz", "net.nz", "org.nz",
  "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in",
  "com.mx", "org.mx",
  "co.za", "org.za",
  "com.ar", "net.ar", "org.ar",
  "com.tr", "net.tr", "org.tr",
  "com.hk", "net.hk", "org.hk",
  "com.tw", "net.tw", "org.tw",
  "com.sg", "net.sg", "org.sg",
  "com.my", "net.my", "org.my",
  "co.kr", "ne.kr", "or.kr", "re.kr",
  "com.ru", "net.ru", "org.ru"
]);

export const isRegistrableDomain = (value: string): boolean => {
  const host = normalizeDomainKey(value);
  if (!host) return false;
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return false;
  const last2 = labels.slice(-2).join(".");
  return MULTI_PART_PUBLIC_SUFFIXES.has(last2) ? labels.length === 3 : labels.length === 2;
};

/**
 * 域名匹配候选键
 *
 * NOTE: Cloudflare 建区时按 UTS-46 直接删除「可忽略字符」（零宽空格 U+200B 等），
 * 因此带零宽前缀的域名在 CF 侧的 zone 名可能是剥除后的形态
 * （「\u200B.ddns.ge」→「ddns.ge」而非「xn--zug.ddns.ge」）。
 * 这里生成 原始归一化 / 剥除归一化 两个候选键，任一命中即视为同一域名；
 * 两种形态一致（普通域名）时只返回一个，避免无谓的比对。
 */
export const domainKeyCandidates = (value: string): string[] => {
  const raw = String(value || "");
  const normalized = normalizeDomainKey(raw);
  const stripped = normalizeDomainKey(raw.replace(/[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g, ""));
  return stripped === normalized ? [normalized] : [normalized, stripped];
};
