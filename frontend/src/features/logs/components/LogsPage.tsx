import { ScrollText, LogIn, Server, Activity, RefreshCw } from "lucide-react";
import { Badge } from "../../../components/Badge";
import type { AppLog } from "../../../types/log";

/**
 * LogsPage —— 运行日志标签页
 *
 * JSX 从 App.tsx 逐字搬运（Phase 12）。`logRowParts`（表格行 / 手机卡片共用的字段节点）
 * 原先定义在 App 内、仅日志页使用，一并迁入。日志过滤后的结果由 App 计算后传入。
 */
export interface LogsPageProps {
  logs: AppLog[];
  loadingLogs: boolean;
  logCategory: "all" | "auth" | "api" | "operation";
  setLogCategory: (c: "all" | "auth" | "api" | "operation") => void;
  actionLoading: string | null;
  onClearLogs: () => void;
}

/** 单条日志在「表格行」与「手机卡片」两种布局下共用的字段节点 */
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
      <pre className="mt-2 p-2.5 rounded bg-elevated text-content-muted text-[11px] md:text-xs font-mono max-h-40 overflow-auto whitespace-pre-wrap break-all">
        {log.details}
      </pre>
    ) : null,
  };
}

export function LogsPage(props: LogsPageProps) {
  const { logs, loadingLogs, logCategory, setLogCategory, actionLoading, onClearLogs } = props;

  return (
    <div className="space-y-4 pt-5 md:pt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base sm:text-lg font-bold text-content-primary">运行日志 (最近100条)</h2>
        <button
          onClick={onClearLogs}
          disabled={actionLoading === "clear-logs"}
          className="bg-red-50 hover:bg-red-100 text-red-700 hover:text-red-800 border border-red-200 dark:bg-red-950/60 dark:hover:bg-red-900/60 dark:text-red-400 dark:hover:text-red-200 dark:border-red-900/50 px-3 py-2 sm:py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all flex-shrink-0"
        >
          清空运行日志
        </button>
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

      {loadingLogs ? (
        <div className="flex justify-center py-20">
          <RefreshCw className="w-6 h-6 animate-spin text-accent" />
        </div>
      ) : logs.length === 0 ? (
        <div className="text-center py-20 border border-dashed border-border-base rounded-xl bg-surface">
          <ScrollText className="w-12 h-12 text-content-muted mx-auto mb-3" />
          <p className="text-content-muted">该分类下暂无运行日志</p>
        </div>
      ) : (
        <>
          {/* ≥md：保持原有 4 列表格（固定列宽合计 416px + p-4 内边距，在手机上必然横向溢出） */}
          <div className="hidden md:block bg-surface border border-border-base rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-elevated text-content-muted text-xs border-b border-border-base">
                    <th scope="col" className="p-4 w-44">时间</th>
                    <th scope="col" className="p-4 w-28">类型</th>
                    <th scope="col" className="p-4 w-32">模块</th>
                    <th scope="col" className="p-4">描述信息</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-soft font-medium">
                  {logs.map((log) => {
                    const parts = logRowParts(log);
                    return (
                      <tr key={log.id} className="hover:bg-hovered transition-colors">
                        <td className="p-4 text-xs text-content-muted font-mono">{parts.time}</td>
                        <td className="p-4 text-xs">{parts.badge}</td>
                        <td className="p-4 text-xs text-content-secondary font-semibold capitalize">
                          {log.category}
                        </td>
                        <td className="p-4 text-content-secondary">
                          <div>{log.message}</div>
                          {parts.details}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* <md：每条日志一张卡片，字段纵向堆叠 */}
          <div className="md:hidden space-y-2">
            {logs.map((log) => {
              const parts = logRowParts(log);
              return (
                <div
                  key={log.id}
                  className="bg-surface border border-border-base rounded-xl p-3 space-y-2"
                >
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
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
