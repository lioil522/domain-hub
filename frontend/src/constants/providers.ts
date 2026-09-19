import type { Account } from "../types/account";
import type { ProviderOption } from "../components/ProviderPicker";
import type { BrandKey } from "../components/BrandLogo";
import { MULTI_PROVIDER_META, MULTI_PROVIDER_ORDER } from "../features/providers/providerMeta";

/**
 * DNSHE 账号 / 域名的 provider 白名单
 *
 * 🔴 WHY 用白名单而不是黑名单：原实现是
 * `a.provider !== "cloudflare" && !== "digitalplat" && !== "custom"`。
 * 续七新增四家托管商（dnspod / alidns / huaweicloud / vercel）时这个黑名单**没有同步**，
 * 于是它们的账号会落进「DNSHE 账号」区（真实 bug：华为云账号出现在 DNSHE 列表里）。
 *
 * 白名单的容错方向相反：将来再加托管商时若忘了同步，新托管商只会「不显示」，
 * 而**不会**错误地混进 DNSHE 列表 —— 后者会误导用户、可能触发错误操作。
 * 后端的 `getDomains` 仍用黑名单（漏掉新托管商的行属「不显示」的安全方向）。
 */
export const DNSHE_PROVIDERS: readonly NonNullable<Account["provider"]>[] = ["dnshe"];

/**
 * 绑定弹窗里「账号提供商」下拉的选项目录 —— 顺序即呈现顺序。
 *
 * WHY 单独建这张表：绑定弹窗原先把 7 家平铺成一行按钮，标签文案在弹窗里
 * 手写了一遍（"DNSHE" / "Cloudflare" / "DigitalPlat"）—— 与侧栏的 label
 * 是两份独立字面量，改名时必然漏改一处。现在统一由这里驱动，
 * 四家新托管商仍复用 MULTI_PROVIDER_META，杜绝漂移。
 *
 * NOTE: group 用来在相邻不同组之间画一条分隔线（见 ProviderPicker）。
 * 这里把自有服务 DNSHE 与其余第三方托管商分段 —— 它是本项目最初围绕的
 * 服务，与「外接的六家」在语义上确实不同类。
 */
export const BIND_PROVIDER_CATALOG: ProviderOption[] = [
  { key: "dnshe", label: "DNSHE", brand: "dnshe", group: "first-party" },
  { key: "cloudflare", label: "Cloudflare", brand: "cloudflare", group: "third-party" },
  { key: "digitalplat", label: "DigitalPlat", brand: "digitalplat", group: "third-party" },
  ...MULTI_PROVIDER_ORDER.map((key) => ({
    key,
    label: MULTI_PROVIDER_META[key].label,
    brand: key as BrandKey,
    group: "third-party"
  }))
];
