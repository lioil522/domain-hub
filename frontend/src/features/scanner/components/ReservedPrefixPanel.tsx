import { Plus, RefreshCw, X } from "lucide-react";
import type { ReservedPrefixModel } from "../utils/scanner-view-model";

interface ReservedPrefixPanelProps {
  scanner: ReservedPrefixModel;
}

export function ReservedPrefixPanel({ scanner }: ReservedPrefixPanelProps) {
  const {
    reservedPrefixes,
    enableReservedFilter,
    newReservedInput,
    setNewReservedInput,
    handleAddReserved,
    handleRemoveReserved,
    handleResetReserved,
    toggleReservedFilter,
  } = scanner;

  return (
    <div className="space-y-3 border-t border-border-base pt-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <label htmlFor="registerpage-fld4" className="flex items-center gap-2 cursor-pointer">
          <input id="registerpage-fld4"
            type="checkbox"
            checked={enableReservedFilter}
            onChange={(e) => toggleReservedFilter(e.target.checked)}
            className="w-4 h-4 accent-red-500"
          />
          <span className="text-xs font-semibold text-content-secondary">
            启用官方保留前缀排除
            <span className="text-content-muted font-normal ml-1">
              (整词匹配，如 ai 被排除但 ailu 仍会查询)
            </span>
          </span>
        </label>
        <button
          onClick={handleResetReserved}
          className="text-xs font-semibold text-content-muted hover:text-content-primary border border-border-base hover:border-content-muted bg-elevated hover:bg-hovered px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 shrink-0"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          恢复默认
        </button>
      </div>

      {enableReservedFilter && (
        <div className="space-y-2.5 pl-6">
          {/* 已有名单标签 */}
          <div className="flex flex-wrap gap-2">
            {reservedPrefixes.length === 0 ? (
              <span className="text-[11px] text-content-muted italic">
                名单为空，当前不会排除任何前缀
              </span>
            ) : (
              reservedPrefixes.map((p) => (
                <span
                  key={p}
                  className="group flex items-center bg-red-50 border border-red-200 text-red-700 dark:bg-red-950/30 dark:border-red-500/30 dark:text-red-300 text-xs rounded-lg overflow-hidden"
                >
                  <span className="px-2.5 py-1 font-mono">{p}</span>
                  <button
                    onClick={() => handleRemoveReserved(p)}
                    className="px-1.5 py-1 text-red-500/70 hover:text-red-800 hover:bg-red-100 border-l border-red-200 dark:text-red-400/60 dark:hover:text-red-300 dark:hover:bg-red-900/40 dark:border-red-500/30 transition-all"
                    title={`从名单移除 ${p}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))
            )}
          </div>

          {/* 添加输入框 */}
          <form onSubmit={handleAddReserved} className="flex items-center gap-2">
            <input
              type="text"
              value={newReservedInput}
              onChange={(e) => setNewReservedInput(e.target.value)}
              placeholder="添加保留前缀，可一次粘贴多个（逗号/空格分隔）"
              className="flex-1 bg-elevated border border-border-base rounded-xl px-3 py-2 text-content-primary text-xs focus:border-red-500/60 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!newReservedInput.trim()}
              className="bg-elevated hover:bg-hovered text-content-secondary hover:text-content-primary border border-border-base text-xs font-semibold px-3 py-2 rounded-xl transition-all flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              添加
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
