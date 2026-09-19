/**
 * 绑定账号弹窗（Phase 3-A 从 App.tsx 抽出；UI 优化方案 P1 改为数据驱动）
 *
 * 统一承载 7 家托管商（DNSHE / Cloudflare / DigitalPlat + 四个新托管商）的
 * 「单个 / 批量」账号绑定。内部完全由 `BIND_FORM_SCHEMA` 驱动 —— 表单字段、文案、
 * 校验、请求体、解析、成功后的刷新策略全部是数据，**不为任何一家单独写一段表单
 * 或处理器**（铁律 3）。原先 6 处 `if provider === ...` 与 8 个几乎雷同的提交处理器，
 * 已收敛成统一的 `submitSingle` / `submitBatch`。
 *
 * 表单值用一个 `Record<string, string>` 袋子按 provider 分别存放（每家一套 alias + 凭据），
 * 切换托管商时保留各自输入（与原实现一致：multiBind* 是共享的，其余各家独立）。
 *
 * App 只需传 8 个 props（其中 apiFetch / showToast / fetchAccounts 直接取自 AppDataContext）。
 */

import { ModalOverlay } from "../../../components/ModalOverlay";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { MultiProviderKey, BindProvider } from "../../../types/provider";
import { BIND_PROVIDER_CATALOG } from "../../../constants/providers";
import { BrandLogo, toBrandKey } from "../../../components/BrandLogo";
import { ProviderPicker } from "../../../components/ProviderPicker";
import { useAppData } from "../../../state/AppDataContext";
import { BIND_FORM_SCHEMA, type BindBatchResult, type BindSyncDeps } from "./BIND_FORM_SCHEMA";
import { GenericCredentialForm } from "./GenericCredentialForm";
import { BindBatchForm } from "./BindBatchForm";

export interface BindAccountModalProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭弹窗 */
  onClose: () => void;
  /** 当前 actionLoading 键（按钮禁用判断，由 App 持有并与其他页面共享） */
  actionLoading: string | null;
  setActionLoading: (v: string | null) => void;
  /** 等待账号域名在后端落库后再刷新列表（依赖较多，仍留在 App） */
  waitForAccountDomainSync: (
    accountIds: number[],
    label: string,
    baseline?: Map<number, string>,
    providerLookup?: (id: number) => string | undefined
  ) => Promise<void>;
  /** 各 provider 域名列表刷新（仍在 App / 后续 Phase 迁移） */
  fetchCfZones: (accountIdFilter?: string) => Promise<void> | void;
  fetchDpDomains: (accountIdFilter?: string) => Promise<void> | void;
  fetchMultiProviderDomains: (key: MultiProviderKey, accountIdFilter?: string) => Promise<void> | void;
}

/** 每家一套的表单值袋：alias + 各凭据字段（字段名取自 schema） */
type FormValues = Record<string, string>;

/** 各 provider 的初始值袋：DNSHE 与四家新托管商各一套（保持切换时互不干扰） */
const EMPTY_VALUES: FormValues = { alias: "" };

export function BindAccountModal(props: BindAccountModalProps) {
  const { open, onClose, actionLoading, setActionLoading, waitForAccountDomainSync, fetchCfZones, fetchDpDomains, fetchMultiProviderDomains } = props;
  // 跨切能力直接从全局上下文取，不再由 App 透传
  const { apiFetch, showToast, fetchAccounts } = useAppData();

  const [bindProvider, setBindProvider] = useState<BindProvider>("dnshe");
  const [bindMode, setBindMode] = useState<"single" | "batch">("single");

  /**
   * 表单值：按 provider 分桶存放。
   *
   * NOTE: 四家新托管商共用 "dnspod"/"alidns"/"huaweicloud"/"vercel" 四个桶；原实现里
   * multiBind* 三个 state 是四家共享的（切换时保留），与这里「每家一个桶」的可见行为
   * 一致 —— 每个桶在切换后仍保留各自输入，只有同一个 provider 内单/批量共享 alias。
   */
  const [valuesByProvider, setValuesByProvider] = useState<Record<string, FormValues>>({});

  // 批量输入与结果：也按 provider 分桶（原文各家独立 state）
  const [batchInput, setBatchInput] = useState<Record<string, string>>({});
  const [batchResults, setBatchResults] = useState<Record<string, BindBatchResult[] | null>>({});

  // 批量输入框引用（自绘拖拽调整高度用，仅 DNSHE）
  const batchTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const schema = BIND_FORM_SCHEMA[bindProvider];
  // 表单分组键：四家新托管商共用 "multi"（复刻原 multiBind* 共享 state 的行为）
  const formKey = schema.formKey;
  const values = valuesByProvider[formKey] ?? EMPTY_VALUES;
  const currentBatchInput = batchInput[formKey] ?? "";

  const setField = (field: string, v: string) => {
    setValuesByProvider((prev) => ({
      ...prev,
      [formKey]: { ...(prev[formKey] ?? EMPTY_VALUES), [field]: v },
    }));
  };

  // 批量输入框自绘拖拽手柄：直接改 DOM 高度，不走 React 渲染，保证跟手
  const handleBatchResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    const ta = batchTextareaRef.current;
    if (!ta) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = ta.offsetHeight;
    const move = (ev: PointerEvent) => {
      const h = Math.max(96, Math.min(480, startH + (ev.clientY - startY)));
      ta.style.height = `${h}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // 弹窗每次重新打开时清空全部托管商的表单状态
  //
  // NOTE: 绑定弹窗每次重新打开时清空**全部**托管商的表单状态（单条凭据 / 别名、
  // 批量输入、上次结果），避免上次取消 / 失败 / 成功残留的内容在下次打开时被误提交。
  useEffect(() => {
    if (!open) return;
    setValuesByProvider({});
    setBatchInput({});
    setBatchResults({});
  }, [open]);

  // 编排层注入给 schema 成功策略的同步依赖
  const deps: BindSyncDeps = {
    fetchAccounts,
    waitForAccountDomainSync,
    fetchCfZones,
    fetchDpDomains,
    fetchMultiProviderDomains,
  };

  // ===== 通用提交：单个绑定 =====
  const submitSingle = async () => {
    const s = schema.single;
    const err = s.validate(values);
    if (err) {
      showToast("error", err);
      return;
    }

    setActionLoading(schema.singleAction);
    try {
      const res = await apiFetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(s.body(values)),
      });
      const data = await res.json();
      if (data.success) {
        const toast = s.successToast?.(data, values);
        if (toast) showToast("success", toast);
        onClose();
        setValuesByProvider((prev) => ({ ...prev, [formKey]: { ...EMPTY_VALUES } }));
        await Promise.resolve(s.onSuccess(data, values, deps));
      } else {
        showToast("error", data.message || s.errorFallback);
      }
    } catch {
      showToast("error", s.catchToast);
    } finally {
      setActionLoading(null);
    }
  };

  // ===== 通用提交：批量绑定 =====
  const submitBatch = async () => {
    const b = schema.batch;
    const { parsed, invalidLines, lineCount } = b.parse(currentBatchInput);

    if (lineCount === 0) {
      showToast("error", b.emptyToast);
      return;
    }
    if (b.maxCountCheck === "raw" && lineCount > 50) {
      showToast("error", "单次最多批量绑定 50 个账号");
      return;
    }
    if (invalidLines > 0) {
      showToast("warning", b.invalidLineMsg(invalidLines));
    }
    if (parsed.length === 0) {
      showToast("error", b.invalidToast);
      return;
    }
    if (b.maxCountCheck === "parsed" && parsed.length > 50) {
      showToast("error", "单次最多批量绑定 50 个账号");
      return;
    }

    setActionLoading(schema.batchAction);
    setBatchResults((prev) => ({ ...prev, [formKey]: null }));
    try {
      const res = await apiFetch("/api/accounts/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b.buildBody(parsed)),
      });
      const data = await res.json();
      if (data.success) {
        setBatchResults((prev) => ({ ...prev, [formKey]: data.results || [] }));
        const toast = b.successToast?.(data);
        if (toast) showToast(toast.level, toast.msg);
        setBatchInput((prev) => ({ ...prev, [formKey]: "" }));
        await Promise.resolve(b.onSuccess(data, deps));
      } else {
        showToast("error", data.message || b.errorFallback);
      }
    } catch {
      showToast("error", b.catchToast);
    } finally {
      setActionLoading(null);
    }
  };

  if (!open) return null;

  return (
    <ModalOverlay>
      <div role="dialog" aria-labelledby="bind-account-modal-title" className="bg-surface border border-border-base w-full max-w-lg max-h-[90dvh] rounded-xl overflow-hidden flex flex-col shadow-2xl">
        <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between border-b border-border-base flex-shrink-0">
          <h3 id="bind-account-modal-title" className="text-lg font-bold text-content-primary flex items-center gap-1.5">
            {/* 标题图标跟随所选托管商，与下拉里的品牌图标一致 ——
                用户选完之后，标题就是「我正要绑定哪家」的即时确认。 */}
            {toBrandKey(bindProvider) && (
              <BrandLogo brand={toBrandKey(bindProvider)!} size={20} />
            )}
            绑定 {BIND_PROVIDER_CATALOG.find((o) => o.key === bindProvider)?.label ?? ""} 账号
          </h3>
          <button
            onClick={() => onClose()}
            className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
          {/* 提供商与方式切换 */}
          <div className="space-y-3">
            <div>
              <span className="block text-xs font-semibold text-content-muted mb-1.5">账号提供商</span>
              {/* 点击展开选择 —— 收起时只占一行并显示当前选择，
                  展开后纵向列出全部 7 家（带真实品牌图标）。 */}
              <ProviderPicker
                options={BIND_PROVIDER_CATALOG}
                value={bindProvider}
                onChange={(key) => setBindProvider(key as BindProvider)}
                ariaLabel="账号提供商"
              />
            </div>
            <div>
              <span className="block text-xs font-semibold text-content-muted mb-1.5">绑定方式</span>
              <div
                role="group"
                aria-label="绑定方式"
                className="grid grid-cols-2 gap-1 bg-elevated border border-border-base rounded-lg p-1"
              >
                <button
                  type="button"
                  onClick={() => setBindMode("single")}
                  className={`py-1.5 rounded-md text-xs font-semibold transition-all ${
                    bindMode === "single" ? "bg-accent-gradient shadow" : "text-content-muted hover:text-content-primary"
                  }`}
                >
                  单个绑定
                </button>
                <button
                  type="button"
                  onClick={() => setBindMode("batch")}
                  className={`py-1.5 rounded-md text-xs font-semibold transition-all ${
                    bindMode === "batch" ? "bg-accent-gradient shadow" : "text-content-muted hover:text-content-primary"
                  }`}
                >
                  批量绑定
                </button>
              </div>
            </div>
          </div>

          {/* 单个绑定表单（数据驱动，7 家共用） */}
          {bindMode === "single" && (
            <GenericCredentialForm
              schema={schema}
              actionLoading={actionLoading}
              alias={values.alias ?? ""}
              setAlias={(v) => setField("alias", v)}
              values={values}
              setValue={setField}
              onSubmit={submitSingle}
              onCancel={onClose}
            />
          )}

          {/* 批量绑定面板（数据驱动，7 家共用） */}
          {bindMode === "batch" && (
            <BindBatchForm
              schema={schema}
              actionLoading={actionLoading}
              value={currentBatchInput}
              setValue={(v) => setBatchInput((prev) => ({ ...prev, [formKey]: v }))}
              onResizeStart={handleBatchResizeStart}
              textareaRef={batchTextareaRef}
              onSubmit={submitBatch}
              results={batchResults[formKey] ?? null}
            />
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}
