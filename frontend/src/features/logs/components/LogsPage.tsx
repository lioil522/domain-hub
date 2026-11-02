import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollText, LogIn, Server, Activity, RefreshCw, ArrowDown } from "lucide-react";
import { Badge } from "../../../components/Badge";
import type { AppLog } from "../../../types/log";

/**
 * LogsPage —— 运行日志标签页
 *
 * 最近 100 条按时间线追加；活动期间增量更新，空闲停止轮询。
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
  const rows = useMemo(() => [...logs].sort((a, b) => a.id - b.id), [logs]);
  const viewport = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const lastId = rows[rows.length - 1]?.id;
  useEffect(() => {
    if (following && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [lastId, rows.length, following]);

  return (
    <div className="space-y-4 pt-5 md:pt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base sm:text-lg font-bold text-content-primary">运行日志 (最近100条)</h2>
          <Badge tone={streaming ? "ok" : "idle"}>{streaming ? "实时追加" : "空闲 · 自动刷新已停止"}</Badge>
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
        <div className="relative">
          <div ref={viewport} role="log" aria-label="运行日志时间线" aria-live="polite" aria-relevant="additions" tabIndex={0}
            onScroll={() => { const element = viewport.current; if (element) setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 48); }}
            className="max-h-[68vh] min-h-48 overflow-y-auto overscroll-contain rounded-xl border border-border-base bg-surface p-3 sm:p-5 scrollbar-thin">
            <ol className="space-y-3 border-l border-border-base ml-2 pl-5">
            {rows.map((log) => {
              const parts = logRowParts(log);
              return (
                <li
                  key={log.id}
                  className="relative bg-elevated/40 border border-border-base rounded-xl p-3 space-y-2 break-words"
                >
                  <span aria-hidden="true" className={`absolute -left-7 top-4 w-3 h-3 rounded-full border-2 border-surface ${log.type === "error" ? "bg-state-danger-fg" : log.type === "warning" ? "bg-state-warn-fg" : "bg-accent"}`} />
                  <div className="flex items-center justify-between gap-2 text-xs">
                    {parts.badge}
                    <span className="text-content-muted font-mono truncate">{parts.time}</span>
                  </div>
                  <div className="text-sm text-content-secondary break-words">{log.message}</div>
                  <div className="flex items-center gap-1.5 text-[11px] text-content-muted">
                    <Server className="w-3 h-3 flex-shrink-0" />
                    <span className="capitalize">{log.category}</span>
                  </div>
                  {parts.details}
                </li>
              );
            })}
            </ol>
          </div>
          {!following && <button onClick={() => setFollowing(true)} className="absolute bottom-3 right-4 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-accent-contrast shadow-lg"><ArrowDown className="w-3.5 h-3.5" />跟随最新日志</button>}
        </div>
      )}
    </div>
  );
}
