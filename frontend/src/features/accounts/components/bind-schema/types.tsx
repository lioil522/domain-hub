import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { MultiProviderKey } from "../../../../types/provider";

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

/** 批量绑定结果行：后端返回给批量绑定结果面板的统一形状。 */
export type BindBatchResult = { api_key: string; alias?: string; success: boolean; message: string };
