import { useMemo } from "react";
import { ScrollText, LogIn, Server, Activity, RefreshCw } from "lucide-react";
import { Badge } from "../../../components/Badge";
import type { AppLog } from "../../../types/log";

/**
 * LogsPage —— 运行日志标签页
 *
 * 最近 100 条以表格倒序显示；活动期间增量更新，空闲停止轮询。
 */
export interface LogsPageProps {
  logs: AppLog[];
  loadingLogs: boolean;
  logCategory: "all" | "auth" | "api" | "operation";
  setLogCategory: (c: "all" | "auth" | "api" | "operation") => void;
  actionLoading: string | null;
  onClearLogs: () => void;
  streaming: boolean;
  onRefreshLogs: () => void;
}

/** Stable row nodes preserve expanded details during incremental updates. */
function logRowParts(log: AppLog) {
  return {
    time: new Date(log.created_at).toLocaleString("zh-CN"),
    // NOTE: 原先四种类型硬编码了「深底亮字」的暗色配色，却没有 dark: 变体——
    // 亮色主题下渲染成近乎全黑的药丸，与页面格格不入。现统一走 Badge 语义色。
    badge: (
      <Badge
        tone={
          log.type === "success" ? "ok"
          : log.type === "error" ? "danger"
          : log.type === "warning" ? "warn"
          : "idle"
        }
        className="uppercase flex-shrink-0"
      >
        {log.type}
      </Badge>
    ),
    details: log.details ? (
      <details className="mt-2 text-content-muted text-xs">
        <summary className="cursor-pointer hover:text-content-primary">查看详情</summary>
        <pre className="mt-2 p-2.5 rounded bg-elevated text-content-muted text-[11px] md:text-xs font-mono max-h-40 overflow-auto whitespace-pre-wrap break-all">{log.details}</pre>
      </details>
    ) : null,
  };
}

export function LogsPage(props: LogsPageProps) {
  const { logs, loadingLogs, logCategory, setLogCategory, actionLoading, onClearLogs, streaming, onRefreshLogs } = props;
  const rows = useMemo(() => [...logs].sort((a, b) => b.id - a.id), [logs]);

  return (
    <div className="space-y-4 pt-5 md:pt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base sm:text-lg font-bold text-content-primary">运行日志 (最近100条)</h2>
          <Badge tone={streaming ? "ok" : "idle"}>{streaming ? "实时更新" : "空闲 · 自动刷新已停止"}</Badge>
        </div>
        <div className="flex items-center gap-2">
        <button onClick={onRefreshLogs} disabled={loadingLogs} aria-label="刷新运行日志" className="p-2 rounded-lg text-content-muted hover:text-accent hover:bg-hovered disabled:opacity-50"><RefreshCw className={`w-4 h-4 ${loadingLogs ? "animate-spin" : ""}`} /></button>
        <button
          onClick={onClearLogs}
          disabled={actionLoading === "clear-logs"}
          className="bg-red-50 hover:bg-red-100 text-red-700 hover:text-red-800 border border-red-200 dark:bg-red-950/60 dark:hover:bg-red-900/60 dark:text-red-400 dark:hover:text-red-200 dark:border-red-900/50 px-3 py-2 sm:py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all flex-shrink-0"
        >
          清空运行日志
        </button>
        </div>
      </div>

      {/* 日志分类子标签 */}
      <div className="flex gap-2 flex-wrap">
        {([
          { key: "all", label: "全部", icon: <ScrollText className="w-4 h-4" /> },
          { key: "auth", label: "登录", icon: <LogIn className="w-4 h-4" /> },
          { key: "api", label: "API", icon: <Server className="w-4 h-4" /> },
          { key: "operation", label: "操作", icon: <Activity className="w-4 h-4" /> },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setLogCategory(t.key)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
              logCategory === t.key
                ? "bg-accent text-accent-contrast shadow-sm"
                : "bg-elevated text-content-muted hover:text-content-primary hover:bg-hovered border border-border-base"
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {loadingLogs && rows.length === 0 ? (
        <div className="flex justify-center py-20">
          <RefreshCw className="w-6 h-6 animate-spin text-accent" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-20 border border-dashed border-border-base rounded-xl bg-surface">
          <ScrollText className="w-12 h-12 text-content-muted mx-auto mb-3" />
          <p className="text-content-muted">该分类下暂无运行日志</p>
        </div>
      ) : (
        <div role="log" aria-label="运行日志（最新在前）" aria-live="polite" aria-relevant="additions" tabIndex={0}
          className="overflow-x-auto rounded-xl border border-border-base bg-surface scrollbar-thin">
          <table aria-label="最近100条运行日志" className="w-full min-w-[720px] table-fixed text-left text-sm">
            <thead className="bg-elevated text-xs text-content-muted">
              <tr>
                <th scope="col" className="w-44 px-4 py-4 font-medium">时间</th>
                <th scope="col" className="w-28 px-4 py-4 font-medium">类型</th>
                <th scope="col" className="w-32 px-4 py-4 font-medium">模块</th>
                <th scope="col" className="px-4 py-4 font-medium">描述信息</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-soft text-content-secondary">
            {rows.map((log) => {
              const parts = logRowParts(log);
              return (
                <tr
                  key={log.id}
                  className="hover:bg-hovered transition-colors"
                >
                  <td className="px-4 py-4 text-[11px] text-content-muted font-mono whitespace-nowrap">{parts.time}</td>
                  <td className="px-4 py-4">{parts.badge}</td>
                  <td className="px-4 py-4 font-semibold capitalize break-words">{log.category}</td>
                  <td className="px-4 py-4 break-words">
                    {log.message}
                    {parts.details}
                  </td>
                </tr>
              );
            })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
