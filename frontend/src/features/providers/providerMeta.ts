import type { MultiProviderKey } from "../../types/provider";

/**
 * 新托管商的前端展示配置
 *
 * WHY 集中成一张表：四个页面的渲染逻辑完全相同，差异只有这些展示层字段。
 * 表驱动后新增第五家只需在这里加一行 + 一个 TabKey，不必再复制一份页面代码。
 */
export const MULTI_PROVIDER_META: Record<
  MultiProviderKey,
  {
    /** 侧栏与页面标题显示名 */
    label: string;
    /** 侧栏 badge 与卡片主色（Tailwind 色名，用于 text-* / bg-* 拼接） */
    accent: string;
    /** 来源徽章色（Badge source）*/
    source: "dnspod" | "alidns" | "huaweicloud" | "vercel";
    /** 主凭据字段的中文名（单凭据型为空，只用 secondary） */
    primaryLabel: string;
    /** 副凭据字段的中文名（Vercel 的 Token 放这里，primary 不用） */
    secondaryLabel: string;
    /** 凭据获取指引（绑定表单下方的说明文案） */
    credentialHint: string;
    /** 是否只需要一个凭据（true 时表单只显示 secondary 一个输入框） */
    singleCredential: boolean;
    /** 单凭据型在批量绑定里用的请求字段名 */
    batchField: "api_key" | "api_token";
    /** 批量绑定每行的格式说明 */
    batchHint: string;
  }
> = {
  dnspod: {
    label: "DNSPod",
    accent: "sky",
    source: "dnspod",
    primaryLabel: "SecretId",
    secondaryLabel: "SecretKey",
    credentialHint:
      "请到腾讯云控制台「访问管理 → API 密钥管理」创建密钥。注意：DNSPod 控制台里的「API Token」是另一套凭据，本面板使用腾讯云 API 密钥（SecretId 以 AKID 或 IKID 开头）。",
    singleCredential: false,
    batchField: "api_key",
    batchHint: "每行一条，格式：SecretId,SecretKey 或 SecretId,SecretKey,别名",
  },
  alidns: {
    label: "阿里云 DNS",
    accent: "orange",
    source: "alidns",
    primaryLabel: "AccessKeyId",
    secondaryLabel: "AccessKeySecret",
    credentialHint:
      "请到阿里云控制台「访问控制 → 用户 → 创建 AccessKey」获取。建议使用 RAM 子账号并授予 AliyunDNSFullAccess 策略，避免用主账号 AccessKey。",
    singleCredential: false,
    batchField: "api_key",
    batchHint: "每行一条，格式：AccessKeyId,AccessKeySecret 或 AccessKeyId,AccessKeySecret,别名",
  },
  huaweicloud: {
    label: "华为云 DNS",
    accent: "rose",
    source: "huaweicloud",
    primaryLabel: "AccessKey ID (AK)",
    secondaryLabel: "Secret Access Key (SK)",
    credentialHint:
      "请到华为云控制台「我的凭证 → 访问密钥」创建。请确认该 IAM 用户已被授予 DNS FullAccess 策略。" +
      "注意：华为云分中国站与国际站两个相互独立的站点，账号与 AK/SK 不通用 —— 请用与域名同站点的密钥。" +
      "本面板使用华为云全局终端节点，中国站与国际站的账号都无需额外配置即可绑定。",
    singleCredential: false,
    batchField: "api_key",
    batchHint: "每行一条，格式：AK,SK 或 AK,SK,别名",
  },
  vercel: {
    label: "Vercel",
    accent: "gray",
    source: "vercel",
    primaryLabel: "",
    secondaryLabel: "Access Token",
    credentialHint:
      "请到 vercel.com/account/tokens 创建 Access Token。若域名属于某个 Team，创建 Token 时需勾选对应 Team 的 Scope。",
    singleCredential: true,
    batchField: "api_token",
    batchHint: "每行一条，格式：Token 或 Token,别名",
  },
};

/** 侧栏顺序（与 TabKey 声明顺序保持一致） */
export const MULTI_PROVIDER_ORDER: MultiProviderKey[] = ["dnspod", "alidns", "huaweicloud", "vercel"];

/**
 * 各托管商「账号分组收起状态」的 localStorage 键。
 *
 * WHY 集中成一张表：这四组键原先在 App.tsx 里写了**两遍**（useState 初始化器
 * 一份、persist 函数里又一份），任何一次改名漏改一处，就会出现「收起状态存进去
 * 却读不回来」的静默 bug。收敛到这里后与 MULTI_PROVIDER_ORDER 同源，新增第五家
 * 只需在这里加一行。
 */
export const MULTI_PROVIDER_COLLAPSED_STORAGE: Record<MultiProviderKey, string> = {
  dnspod: "DNSHE_DNSPOD_COLLAPSED_ACCOUNTS",
  alidns: "DNSHE_ALIDNS_COLLAPSED_ACCOUNTS",
  huaweicloud: "DNSHE_HUAWEI_COLLAPSED_ACCOUNTS",
  vercel: "DNSHE_VERCEL_COLLAPSED_ACCOUNTS",
};

/** 跨源搜索结果面板里各新托管商的标题色（与来源令牌同一色相，深浅档各自适配） */
export const MULTI_PROVIDER_SEARCH_COLORS: Record<MultiProviderKey, string> = {
  dnspod: "text-blue-600 dark:text-blue-400",
  alidns: "text-rose-600 dark:text-rose-400",
  huaweicloud: "text-red-600 dark:text-red-400",
  vercel: "text-slate-600 dark:text-slate-300",
};
