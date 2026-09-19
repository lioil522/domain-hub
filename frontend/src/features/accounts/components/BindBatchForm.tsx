/**
 * 绑定账号弹窗 —— 通用「批量绑定」面板（UI 优化方案 P1）
 *
 * 由 `BindProviderSchema` + 受控输入值驱动，7 家托管商共用同一份渲染逻辑。
 * 唯一的形态差异（DNSHE 的自绘拖拽调高手柄）由 `schema.batchResizable` 控制。
 *
 * NOTE: 纯展示，不含请求逻辑；提交回调由编排层注入。
 * DOM / className / 文案全部来自 schema，与原实现逐字一致。
 */

import { Play, RefreshCw } from "lucide-react";
import { Textarea } from "../../../components/form/Textarea";
import type { BindBatchResult, BindProviderSchema } from "./BIND_FORM_SCHEMA";
import { BindBatchResults } from "./BindBatchResults";

export interface BindBatchFormProps {
  schema: BindProviderSchema;
  actionLoading: string | null;
  value: string;
  setValue: (v: string) => void;
  /** 自绘拖拽手柄的 pointerdown（仅 batchResizable 时挂载） */
  onResizeStart?: (e: React.PointerEvent<HTMLDivElement>) => void;
  textareaRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
  onSubmit: () => void;
  results: BindBatchResult[] | null;
}

/** 与提交/按钮计数口径一致的行数统计 */
function countLines(v: string): number {
  return v.split(/[\n;；]+/).map((l) => l.trim()).filter(Boolean).length;
}

export function BindBatchForm({
  schema,
  actionLoading,
  value,
  setValue,
  onResizeStart,
  textareaRef,
  onSubmit,
  results,
}: BindBatchFormProps) {
  const busy = actionLoading === schema.batchAction;

  return (
    <div className="space-y-4 pt-1">
      {schema.batch.batchIntro}

      {schema.batch.batchResizable ? (
        <div className="relative">
          <Textarea mono
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={6}
            spellCheck={false}
            placeholder={schema.batch.batchPlaceholder}
            className="w-full text-content-secondary"
            style={{ height: 160, transition: "none" }}
          />
          <div
            onPointerDown={onResizeStart}
            className="absolute bottom-0 right-1 h-4 w-10 cursor-ns-resize touch-none select-none flex items-center justify-center gap-[3px]"
            title="拖拽调整高度"
          >
            <span className="block w-3.5 h-[3px] rounded-full bg-current opacity-50" />
            <span className="block w-3.5 h-[3px] rounded-full bg-current opacity-50" />
          </div>
        </div>
      ) : (
        <Textarea mono
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={schema.batch.batchPlaceholder}
          className="w-full text-content-secondary"
          style={{ height: 160 }}
        />
      )}

      {schema.batch.batchExtraHint}

      <button
        onClick={onSubmit}
        disabled={busy}
        className="w-full btn-primary py-2.5 rounded-lg font-semibold text-sm text-white flex items-center justify-center gap-2 disabled:opacity-50"
      >
        {busy ? (
          <>
            <RefreshCw className="w-4 h-4 animate-spin" /> 正在批量验证绑定…
          </>
        ) : (
          <>
            <Play className="w-4 h-4" /> 开始批量绑定 ({countLines(value)} 条)
          </>
        )}
      </button>

      {results && <BindBatchResults results={results} />}
    </div>
  );
}
