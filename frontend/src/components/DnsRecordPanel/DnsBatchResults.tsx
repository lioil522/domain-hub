/**
 * DNS 解析记录面板 —— 批量操作结果明细块
 *
 * 批量添加与批量修改的「结果逐条明细」DOM 完全一致（原文件里重复了两遍），
 * 拆文件时收敛到这一个组件。DOM / className 逐字保留。
 */

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { DnsBatchResult } from "./types";

export interface DnsBatchResultsProps {
  results: DnsBatchResult[];
}

export function DnsBatchResults({ results }: DnsBatchResultsProps) {
  return (
    <div className="space-y-1 max-h-40 overflow-y-auto bg-surface border border-border-base rounded-lg p-3 text-xs">
      {results.map((r, i) => (
        <div key={i} className={`flex items-start gap-2 ${r.success ? "text-emerald-500" : "text-red-500"}`}>
          {r.success ? (
            <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          ) : (
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          )}
          <span className="font-mono break-all">
            {r.label} — {r.message}
          </span>
        </div>
      ))}
    </div>
  );
}
