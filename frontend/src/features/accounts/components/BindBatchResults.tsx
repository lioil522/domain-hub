/**
 * 绑定账号弹窗 —— 批量绑定逐条结果明细（UI 优化方案 P1）
 *
 * 7 家托管商的批量结果列表 DOM 完全一致（原文件里重复了 4 遍），拆文件时收敛到
 * 这一个组件。DOM / className 逐字保留。
 */

import { CheckCircle2, X } from "lucide-react";
import type { BindBatchResult } from "./BIND_FORM_SCHEMA";

export interface BindBatchResultsProps {
  results: BindBatchResult[];
}

export function BindBatchResults({ results }: BindBatchResultsProps) {
  if (!results || results.length === 0) return null;
  return (
    <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
      {results.map((r, idx) => (
        <div
          key={idx}
          className={`flex items-start justify-between gap-2 text-xs px-3 py-2 rounded-lg border ${
            r.success
              ? "bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-500/10 dark:border-emerald-500/30 dark:text-emerald-300"
              : "bg-red-50 border-red-200 text-red-700 dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-300"
          }`}
        >
          <div className="min-w-0">
            <div className="font-mono truncate">{r.api_key}</div>
            {r.alias && <div className="text-content-muted truncate">别名: {r.alias}</div>}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {r.success ? <CheckCircle2 className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
            <span>{r.success ? "成功" : r.message}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
