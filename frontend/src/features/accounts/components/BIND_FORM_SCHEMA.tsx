/**
 * 绑定账号弹窗 —— 表单 schema（UI 优化方案 P1）
 *
 * WHY 单独建这张表：绑定弹窗原先对 7 家托管商各写一段 JSX + 一个提交处理器
 * （`if provider === "dnshe"` 之类），表单字段、文案、端点、动作键、解析与刷新策略
 * 全都散落重复。这里把它们收敛成**纯数据 / 策略函数**，由 `GenericCredentialForm` /
 * `BindBatchForm` 统一渲染，编排层只跑一套通用提交逻辑 —— 新增一家托管商只需在
 * `BIND_FORM_SCHEMA` 里加一条，不再复制一整段表单与处理器。
 *
 * 铁律：只搬运，不改行为。字段 label / placeholder / 输入控件类型 / name / autoComplete /
 * 必填 / spellCheck、端点上送的 provider 值、动作 loading 键、按钮文案与图标、提示文案、
 * 单个表单是 <form> 还是 <div>、页脚形态、成功后的 toast / 清空 / 刷新 / 同步策略，
 * 均与原实现逐字（逐行为）一致。
 */

import { Cloud, Globe, Plus, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { MultiProviderKey, BindProvider } from "../../../types/provider";
import { MULTI_PROVIDER_META } from "../../providers/providerMeta";

/** 单个凭据输入字段的形态 */
export interface BindFieldSpec {
  /** 该字段在表单值袋里的键（alias 之外） */
  field: string;
  label: string;
  placeholder?: string;
  /**
   * 输入控件类型：
   * - text：普通 <input type="text">
   * - passwordInput：PasswordInput 组件（带小眼睛）
   * - passwordRaw：裸 <input type="password">（四家新托管商沿用）
   */
  component: "text" | "passwordInput" | "passwordRaw";
  name: string;
  autoComplete: string;
  required?: boolean;
  mono?: boolean;
  spellCheck?: boolean;
}

/** 页脚形态：duo=「取消 + 提交」两按钮；solo=单个整宽提交按钮 */
export type BindFooterKind = "duo" | "solo";

/**
 * 提交成功后的同步依赖（由编排层注入，避免 schema 反向依赖组件）。
 * 与原实现里从 props / AppDataContext 拿到的函数一一对应。
 */
export interface BindSyncDeps {
  fetchAccounts: () => Promise<void> | void;
  waitForAccountDomainSync: (
    accountIds: number[],
    label: string,
    baseline?: Map<number, string>,
    providerLookup?: (id: number) => string | undefined
  ) => Promise<void>;
  fetchCfZones: (accountIdFilter?: string) => Promise<void> | void;
  fetchDpDomains: (accountIdFilter?: string) => Promise<void> | void;
  fetchMultiProviderDomains: (key: MultiProviderKey, accountIdFilter?: string) => Promise<void> | void;
}

export const toAccountIds = (ids?: Array<number | string>): number[] =>
  (ids ?? []).map(Number).filter(Number.isFinite);

export interface BindApiData extends Record<string, unknown> {
  message?: string;
  fail_count?: number;
  success_count?: number;
  account?: { id?: number | string; alias?: string };
  account_ids?: Array<number | string>;
}

export interface BindSingleSpec {
  /** 请求体构造（入参：{ alias, ...各字段 }） */
  body: (v: Record<string, string>) => Record<string, unknown>;
  /** 提交前的本地校验：返回错误提示（null 表示通过） */
  validate: (v: Record<string, string>) => string | null;
  /** 成功的 toast 文案；缺省表示不弹 toast（CF / DP 原实现如此） */
  successToast?: (data: BindApiData, v: Record<string, string>) => string;
  /**
   * 成功分支（不含 toast / onClose / 清空表单 —— 那三步由编排层统一做）：
   * 刷新账号列表 + 等待域名落库后刷新对应 provider 列表。
   * 返回 Promise 表示编排层需 await（DNSHE 返回 void，原实现即 fire-and-forget）。
   */
  onSuccess: (data: BindApiData, v: Record<string, string>, deps: BindSyncDeps) => void | Promise<void>;
  errorFallback: string;
  catchToast: string;
}

export interface BindBatchSpec {
  /** 说明段（部分商带 <span> 高亮，故为节点） */
  batchIntro: ReactNode;
  /** 输入框 placeholder */
  batchPlaceholder: string;
  /** 输入框下方的补充提示节点（仅四家新托管商在批量面板里再放一次凭据指引） */
  batchExtraHint?: ReactNode;
  /** 输入框是否自绘拖拽手柄（仅 DNSHE） */
  batchResizable: boolean;
  /** 解析输入框：返回有效行（已是请求体字段形状）、无效行数、原始行数 */
  parse: (input: string) => { parsed: Array<Record<string, string>>; invalidLines: number; lineCount: number };
  emptyToast: string;
  invalidLineMsg: (n: number) => string;
  invalidToast: string;
  /** 成功 toast（含 level）；缺省表示不弹（DP / multi 原实现如此） */
  successToast?: (data: BindApiData) => { level: "success" | "warning"; msg: string };
  /** 成功分支：刷新账号列表 + 等待域名落库后刷新对应 provider 列表（同 single.onSuccess 语义） */
  onSuccess: (data: BindApiData, deps: BindSyncDeps) => void | Promise<void>;
  errorFallback: string;
  catchToast: string;
  /**
   * 行数上限（50）校验时机：
   * - raw：解析前按原始行数校验（DNSHE）
   * - parsed：解析后按有效行数校验（CF / DP / multi）
   */
  maxCountCheck: "raw" | "parsed";
  buildBody: (parsed: Array<Record<string, string>>) => Record<string, unknown>;
}

export interface BindProviderSchema {
  singleAction: string;
  batchAction: string;
  /**
   * 表单状态分组键。同一 formKey 的托管商共用一份表单值袋与批量输入/结果 ——
   * 原实现里四家新托管商共享 multiBind* / multiBatchBind* 三个 state，切换时保留输入；
   * 三家第一方各自独立。这里用 formKey 精确复刻这套分组。
   */
  formKey: string;
  /** 单个绑定是否用真 <form onSubmit>（仅 DNSHE） */
  singleUsesForm: boolean;

  aliasLabel: string;
  aliasName: string;
  aliasPlaceholder: string;

  /** 凭据字段（按渲染顺序）；单凭据型只有 1 个 */
  fields: BindFieldSpec[];

  /** 单个表单下方的提示节点（各商样式不同，直接给节点） */
  singleHint?: ReactNode;

  footerKind: BindFooterKind;
  submitLabel: string;
  submitIcon: LucideIcon;
  /** solo 页脚提交中的文案（duo 只用 spinner，无文案） */
  submitLoadingText?: string;

  single: BindSingleSpec;
  batch: BindBatchSpec;
}

/* ============================ DNSHE ============================ */
const DNSHE_SCHEMA: BindProviderSchema = {
  singleAction: "add-account",
  batchAction: "batch-add-accounts",
  formKey: "dnshe",
  singleUsesForm: true,
  aliasLabel: "账户别名 (可选，留空自动解析)",
  aliasName: "dnshe-bind-alias",
  aliasPlaceholder: "如：主账号、测试组",
  fields: [
    { field: "apiKey", label: "API Key", placeholder: "cfsd_xxxxxxxxxx", component: "text", name: "dnshe-bind-api-key", autoComplete: "off", required: true, mono: true },
    { field: "apiSecret", label: "API Secret", placeholder: "请输入 API Secret", component: "passwordInput", name: "dnshe-bind-api-secret", autoComplete: "new-password", required: true },
  ],
  singleHint: (
    <p className="text-[11px] text-content-muted leading-relaxed">
      别名留空时，系统会自动调用 DNSHE 密钥列表接口获取该 Key 的名称作为别名。
    </p>
  ),
  footerKind: "duo",
  submitLabel: "验证并绑定账号",
  submitIcon: Plus,
  single: {
    body: (v) => ({ alias: v.alias, api_key: v.apiKey, api_secret: v.apiSecret }),
    validate: (v) => (!v.apiKey?.trim() || !v.apiSecret?.trim() ? "API Key 与 API Secret 为必填项！" : null),
    successToast: (data, v) => `账号 [${data.account?.alias || v.alias || v.apiKey}] 验证并绑定成功！`,
    // 原实现：fetchAccounts() 与 waitForAccountDomainSync(...) 均不 await（fire-and-forget）
    onSuccess: (data, v, deps) => {
      deps.fetchAccounts();
      deps.waitForAccountDomainSync([Number(data.account?.id)], `账号 [${data.account?.alias || v.apiKey}] 绑定成功`);
    },
    errorFallback: "账号绑定失败，请检查密钥是否正确",
    catchToast: "绑定请求发送失败，请检查网络",
  },
  batch: {
    batchIntro: (
      <p className="text-xs text-content-muted leading-relaxed">
        每行填入一组 <span className="font-mono text-accent">API Key + API Secret</span>（用空格 / Tab / 逗号分隔），别名自动从 API Key 解析，无需填写。
      </p>
    ),
    batchPlaceholder: "cfsd_xxxxxxxx1 你的secret1\ncfsd_xxxxxxxx2 你的secret2\ncfsd_xxxxxxxx3,你的secret3",
    batchResizable: true,
    parse: (input) => {
      const lines = input.split(/[\n;；]+/).map((l) => l.trim()).filter(Boolean);
      let parsed: Array<Record<string, string>> = [];
      let invalidLines = 0;
      // 兼容 JSON 数组格式：[{"api_key":"cfsd_xx","api_secret":"yy","alias":"可选"}]
      try {
        const jsonParsed = JSON.parse(input.trim());
        if (Array.isArray(jsonParsed) && jsonParsed.length > 0 && jsonParsed[0]?.api_key) {
          parsed = jsonParsed.map((it) => ({
            alias: it.alias ? String(it.alias).trim() : "",
            api_key: String(it.api_key).trim(),
            api_secret: String(it.api_secret).trim(),
          }));
        }
      } catch {
        // 非 JSON，走逐行解析
      }
      if (parsed.length === 0) {
        for (const line of lines) {
          const parts = line.split(/[\s,，|]+/).map((p) => p.trim()).filter(Boolean);
          if (parts.length >= 2) {
            parsed.push({ api_key: parts[0], api_secret: parts[1], alias: parts.length >= 3 ? parts.slice(2).join(" ") : "" });
          } else {
            invalidLines++;
          }
        }
      }
      return { parsed, invalidLines, lineCount: lines.length };
    },
    emptyToast: "请先粘贴至少一条 API Key 与 API Secret",
    invalidLineMsg: (n) => `${n} 行格式不正确（每行需包含 API Key 与 API Secret），已自动跳过`,
    invalidToast: "未能解析出任何有效的账号信息，请检查输入格式",
    successToast: (data) => ({ level: "success", msg: data.message || "批量绑定完成" }),
    onSuccess: (data, deps) => {
      deps.fetchAccounts();
      deps.waitForAccountDomainSync((data.account_ids || []).map(Number), `${(data.account_ids || []).length} 个账号绑定成功`);
    },
    errorFallback: "批量绑定失败",
    catchToast: "批量绑定请求发送失败，请检查网络",
    maxCountCheck: "raw",
    buildBody: (parsed) => ({ accounts: parsed }),
  },
};

/* ============================ Cloudflare ============================ */
const CF_SCHEMA: BindProviderSchema = {
  singleAction: "cf-add-account",
  batchAction: "cf-batch-add-accounts",
  formKey: "cloudflare",
  singleUsesForm: false,
  aliasLabel: "账户别名（可选，留空自动解析）",
  aliasName: "cf-bind-alias",
  aliasPlaceholder: "留空将使用 Cloudflare 账号名称",
  fields: [
    { field: "token", label: "API Token", placeholder: "粘贴 Cloudflare API Token", component: "passwordInput", name: "cf-bind-token", autoComplete: "new-password", mono: true },
  ],
  singleHint: (
    <p className="text-[11px] text-content-muted leading-relaxed">
      在 Cloudflare 控制台「My Profile → API Tokens」创建 Token，权限需包含
      <span className="font-mono text-content-secondary"> Zone:Read </span>与
      <span className="font-mono text-content-secondary"> Zone DNS:Edit</span>
      。Token 仅用于调用 Cloudflare 官方 API，绑定后会加密存储并校验有效性。
    </p>
  ),
  footerKind: "duo",
  submitLabel: "验证并绑定账号",
  submitIcon: Cloud,
  single: {
    body: (v) => ({ provider: "cloudflare", alias: v.alias.trim(), api_token: v.token.trim() }),
    validate: (v) => (!v.token?.trim() ? "请填写 Cloudflare API Token" : null),
    // CF 成功分支不弹 toast（原实现如此）→ successToast 缺省
    onSuccess: async (data, _v, deps) => {
      await deps.fetchAccounts();
      if (data.account?.id) {
        await deps.waitForAccountDomainSync([Number(data.account.id)], "Cloudflare 账号绑定成功", undefined, () => "cloudflare");
      } else {
        await deps.fetchCfZones();
      }
    },
    errorFallback: "绑定 Cloudflare 账号失败",
    catchToast: "绑定 Cloudflare 账号请求失败",
  },
  batch: {
    batchIntro: (
      <p className="text-xs text-content-muted leading-relaxed">
        每行填入一个 <span className="font-mono text-sky-400">API Token</span>（用空格 / Tab / 逗号 / 竖线分隔），可选择性跟随别名：
        <span className="font-mono text-content-secondary">token 你的别名</span>。别名留空自动使用 Cloudflare 账号名称。
      </p>
    ),
    batchPlaceholder: "cfut_xxxxxxxxxxxx1 别名A\ncfut_xxxxxxxxxxxx2 别名B\ncfut_xxxxxxxxxxxx3",
    batchResizable: false,
    parse: (input) => {
      const lines = input.split(/[\n;；]+/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      const parsed: Array<Record<string, string>> = [];
      let invalidLines = 0;
      for (const line of lines) {
        const parts = line.split(/[\s,，|]+/).map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 1) {
          parsed.push({ api_token: parts[0], alias: parts.length >= 2 ? parts.slice(1).join(" ") : "" });
        } else {
          invalidLines++;
        }
      }
      return { parsed, invalidLines, lineCount: lines.length };
    },
    emptyToast: "请至少输入一条 Cloudflare API Token",
    invalidLineMsg: (n) => `${n} 行格式不正确（每行需包含 API Token），已自动跳过`,
    invalidToast: "未能解析出任何有效的账号信息，请检查输入格式",
    successToast: (data) => ({ level: data.fail_count === 0 ? "success" : "warning", msg: data.message || "批量绑定完成" }),
    onSuccess: async (data, deps) => {
      await deps.fetchAccounts();
      const ids: number[] = (data.account_ids || []).map(Number);
      if (ids.length > 0) {
        // 后台逐个同步 zones，落库后自动刷新（fetchCfZones 在等待函数末尾统一调用）
        await deps.waitForAccountDomainSync(ids, `${ids.length} 个 Cloudflare 账号绑定成功`, undefined, () => "cloudflare");
      } else {
        await deps.fetchCfZones();
      }
    },
    errorFallback: "批量绑定失败",
    catchToast: "批量绑定请求发送失败，请检查网络",
    maxCountCheck: "parsed",
    buildBody: (parsed) => ({ provider: "cloudflare", accounts: parsed }),
  },
};

/* ============================ DigitalPlat ============================ */
const DP_SCHEMA: BindProviderSchema = {
  singleAction: "dp-add-account",
  batchAction: "dp-batch-add-accounts",
  formKey: "digitalplat",
  singleUsesForm: false,
  aliasLabel: "账户别名（可选）",
  aliasName: "dp-bind-alias",
  aliasPlaceholder: "留空将使用 DigitalPlat ••••尾号",
  fields: [
    { field: "key", label: "API Key", placeholder: "粘贴 DigitalPlat API Key（dp_live_ / dp_test_ 开头）", component: "passwordInput", name: "dp-bind-key", autoComplete: "new-password", mono: true },
  ],
  singleHint: (
    <p className="text-[11px] text-content-muted leading-relaxed">
      在 DigitalPlat 控制台「API 密钥」页创建 API Key。Key 明文只在创建时显示一次，绑定后会加密存储并校验有效性。
    </p>
  ),
  footerKind: "duo",
  submitLabel: "验证并绑定账号",
  submitIcon: Globe,
  single: {
    body: (v) => ({ provider: "digitalplat", alias: v.alias.trim(), api_key: v.key.trim() }),
    validate: (v) => (!v.key?.trim() ? "请填写 DigitalPlat API Key" : null),
    // DP 成功分支不弹 toast（原实现如此）→ successToast 缺省
    onSuccess: async (data, _v, deps) => {
      await deps.fetchAccounts();
      if (data.account?.id) {
        await deps.waitForAccountDomainSync([Number(data.account.id)], "DigitalPlat 账号绑定成功", undefined, () => "digitalplat");
      } else {
        await deps.fetchDpDomains();
      }
    },
    errorFallback: "绑定 DigitalPlat 账号失败",
    catchToast: "绑定 DigitalPlat 账号请求失败",
  },
  batch: {
    batchIntro: (
      <p className="text-xs text-content-muted leading-relaxed">
        每行填入一个 <span className="font-mono text-sky-400">API Key</span>（用空格 / Tab / 逗号 / 竖线分隔），可选择性跟随别名：
        <span className="font-mono text-content-secondary">dp_live_xxx 别名A</span>。别名留空自动使用 Key 尾号。
      </p>
    ),
    batchPlaceholder: "dp_live_xxxxxxxxxxxx1 别名A\ndp_live_xxxxxxxxxxxx2 别名B\ndp_live_xxxxxxxxxxxx3",
    batchResizable: false,
    parse: (input) => {
      const lines = input.split(/[\n;；]+/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      const parsed: Array<Record<string, string>> = [];
      let invalidLines = 0;
      for (const line of lines) {
        const parts = line.split(/[\s,，|]+/).map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 1) {
          parsed.push({ api_key: parts[0], alias: parts.length >= 2 ? parts.slice(1).join(" ") : "" });
        } else {
          invalidLines++;
        }
      }
      return { parsed, invalidLines, lineCount: lines.length };
    },
    emptyToast: "请至少输入一条 DigitalPlat API Key",
    invalidLineMsg: (n) => `${n} 行格式不正确（每行需包含 API Key），已自动跳过`,
    invalidToast: "未能解析出任何有效的账号信息，请检查输入格式",
    // DP 批量成功分支不弹 toast（原实现如此）→ successToast 缺省
    onSuccess: async (data, deps) => {
      await deps.fetchAccounts();
      if (Array.isArray(data.account_ids) && data.account_ids.length > 0) {
        await deps.waitForAccountDomainSync(toAccountIds(data.account_ids), `${data.success_count} 个 DigitalPlat 账号绑定成功`, undefined, () => "digitalplat");
      } else {
        await deps.fetchDpDomains();
      }
    },
    errorFallback: "批量绑定失败",
    catchToast: "批量绑定请求失败",
    maxCountCheck: "parsed",
    buildBody: (parsed) => ({ provider: "digitalplat", accounts: parsed }),
  },
};

/** 四家新托管商（DNSPod / 阿里云 / 华为云 / Vercel）由 MULTI_PROVIDER_META 派生 */
function multiSchema(key: MultiProviderKey): BindProviderSchema {
  const meta = MULTI_PROVIDER_META[key];
  const fields: BindFieldSpec[] = [];
  if (!meta.singleCredential) {
    fields.push({ field: "primary", label: meta.primaryLabel, placeholder: `请输入 ${meta.primaryLabel}`, component: "text", name: `${key}-bind-primary`, autoComplete: "off", mono: true, spellCheck: false });
  }
  fields.push({ field: "secondary", label: meta.secondaryLabel, placeholder: `请输入 ${meta.secondaryLabel}`, component: "passwordRaw", name: `${key}-bind-secondary`, autoComplete: "new-password", mono: true, spellCheck: false });

  return {
    singleAction: `multi-add-${key}`,
    batchAction: `multi-batch-${key}`,
    formKey: "multi",
    singleUsesForm: false,
    aliasLabel: "账户别名 (可选，留空自动生成)",
    aliasName: `${key}-bind-alias`,
    aliasPlaceholder: `如：${meta.label} 主账号`,
    fields,
    singleHint: (
      <p className="text-[11px] text-content-muted leading-relaxed bg-elevated border border-border-base rounded-lg p-3">
        {meta.credentialHint}
      </p>
    ),
    footerKind: "solo",
    submitLabel: "验证并绑定",
    submitIcon: Plus,
    submitLoadingText: "正在验证凭据…",
    single: {
      body: (v) => {
        // 单凭据型（Vercel）只送 secondary；双凭据型两个都送（primary 为空串）
        const primary = meta.singleCredential ? "" : (v.primary ?? "").trim();
        return { provider: key, alias: (v.alias ?? "").trim(), api_key: primary, api_secret: (v.secondary ?? "").trim() };
      },
      validate: (v) => {
        if (meta.singleCredential) {
          return !(v.secondary ?? "").trim() ? `请填写 ${meta.secondaryLabel}` : null;
        }
        if (!(v.primary ?? "").trim() || !(v.secondary ?? "").trim()) {
          return `${meta.primaryLabel} 与 ${meta.secondaryLabel} 均为必填项！`;
        }
        return null;
      },
      successToast: () => `${meta.label} 账号绑定成功！`,
      onSuccess: async (data, _v, deps) => {
        await deps.fetchAccounts();
        if (data.account?.id) {
          await deps.waitForAccountDomainSync([Number(data.account.id)], `${meta.label} 账号绑定成功`, undefined, () => key);
        } else {
          await deps.fetchMultiProviderDomains(key);
        }
      },
      errorFallback: `${meta.label} 账号绑定失败`,
      catchToast: `绑定 ${meta.label} 账号请求失败`,
    },
    batch: {
      batchIntro: (
        <p className="text-xs text-content-muted leading-relaxed">
          每行填入一组凭据：<span className="font-mono text-sky-400">{meta.batchHint}</span>。
          别名留空时自动使用凭据尾号。
        </p>
      ),
      batchPlaceholder: meta.batchHint,
      batchExtraHint: (
        <p className="text-[11px] text-content-muted leading-relaxed bg-elevated border border-border-base rounded-lg p-3">
          {meta.credentialHint}
        </p>
      ),
      batchResizable: false,
      parse: (input) => {
        const lines = input.split(/[\n;；]+/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
        const parsed: Array<Record<string, string>> = [];
        let invalidLines = 0;
        for (const line of lines) {
          const parts = line.split(/[,，|\s]+/).map((p) => p.trim()).filter(Boolean);
          if (meta.singleCredential) {
            // 单凭据型：Token[,别名]
            if (parts.length >= 1) {
              parsed.push({ api_key: "", api_secret: parts[0], alias: parts.length >= 2 ? parts.slice(1).join(" ") : "" });
            } else {
              invalidLines++;
            }
          } else {
            // 双凭据型：凭据1,凭据2[,别名]
            if (parts.length >= 2) {
              parsed.push({ api_key: parts[0], api_secret: parts[1], alias: parts.length >= 3 ? parts.slice(2).join(" ") : "" });
            } else {
              invalidLines++;
            }
          }
        }
        return { parsed, invalidLines, lineCount: lines.length };
      },
      emptyToast: `请至少输入一条 ${meta.label} 凭据`,
      invalidLineMsg: (n) => `${n} 行格式不正确，已自动跳过`,
      invalidToast: "未能解析出任何有效的账号信息，请检查输入格式",
      // multi 批量成功分支不弹 toast（原实现如此）→ successToast 缺省
      onSuccess: async (data, deps) => {
        await deps.fetchAccounts();
        if (Array.isArray(data.account_ids) && data.account_ids.length > 0) {
          await deps.waitForAccountDomainSync(toAccountIds(data.account_ids), `${data.success_count} 个 ${meta.label} 账号绑定成功`, undefined, () => key);
        } else {
          await deps.fetchMultiProviderDomains(key);
        }
      },
      errorFallback: "批量绑定失败",
      catchToast: "批量绑定请求失败",
      maxCountCheck: "parsed",
      buildBody: (parsed) => ({ provider: key, accounts: parsed }),
    },
  };
}

export const BIND_FORM_SCHEMA: Record<BindProvider, BindProviderSchema> = {
  dnshe: DNSHE_SCHEMA,
  cloudflare: CF_SCHEMA,
  digitalplat: DP_SCHEMA,
  dnspod: multiSchema("dnspod"),
  alidns: multiSchema("alidns"),
  huaweicloud: multiSchema("huaweicloud"),
  vercel: multiSchema("vercel"),
};

/** 批量绑定逐条结果（各家共用同一形状） */
export type BindBatchResult = { api_key: string; alias?: string; success: boolean; message: string };
