import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, CheckCircle2, AlertTriangle, XCircle, PauseCircle, Clock, RefreshCw, X } from "lucide-react";
import { mergeSyncActions, isExecutingAction, type ActionItem } from "../../lib/action-center-state";
import { syncStatusText } from "../../lib/sync-status";
import type { SliceState } from "../../lib/sliced-sync";
import type { ApiFetch } from "../../api/client";
import { createActionFeed } from "../../lib/action-feed";
import type { OperationEvent } from "../../lib/operation-activity";

function label(type: string): string {
  const labels: Record<string, string> = {
    sync: "同步",
    renew: "续期",
    "batch-delete": "批量删除",
    "batch-create": "批量创建",
    "dns-update": "DNS 更新",
    scanner: "扫描",
    backup: "备份",
    restore: "恢复",
  };
  return labels[type] || type;
}

function statusText(status: ActionItem["status"]): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "partial":
      return "部分完成";
    case "failed":
      return "执行失败";
    case "cancelled":
      return "已取消";
    case "running":
      return "执行中";
    case "queued":
      return "排队中";
    default:
      return status;
  }
}

function StatusIcon({ status }: { status: ActionItem["status"] }) {
  if (status === "completed") return <CheckCircle2 className="w-4 h-4 text-accent flex-shrink-0" />;
  if (status === "partial") return <AlertTriangle className="w-4 h-4 text-state-warn-fg flex-shrink-0" />;
  if (status === "failed") return <XCircle className="w-4 h-4 text-[var(--state-danger-fg)] flex-shrink-0" />;
  if (status === "cancelled") return <PauseCircle className="w-4 h-4 text-content-muted flex-shrink-0" />;
  if (status === "queued") return <Clock className="w-4 h-4 text-content-muted flex-shrink-0" />;
  return <Activity className="w-4 h-4 text-accent animate-pulse flex-shrink-0" />;
}

export function ActionCenter({ apiFetch, sessionToken, syncStates, syncEnabled, onActivityChange }: { apiFetch: ApiFetch; sessionToken: string | null; syncStates: Record<number, SliceState>; syncEnabled: boolean; onActivityChange: (active: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [loading, setLoading] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const feed = useMemo(() => createActionFeed(apiFetch, sessionToken, setActions, setLoading), [apiFetch, sessionToken]);
  const load = feed.load;
  const items = useMemo(() => mergeSyncActions(actions, syncStates), [actions, syncStates]);

  // 计算当前活动中的任务数（排队中或运行中）
  const activeCount = useMemo(
    () => items.filter(item => isExecutingAction(item, syncEnabled)).length,
    [items, syncEnabled]
  );
  useEffect(() => { onActivityChange(activeCount > 0); }, [activeCount, onActivityChange]);

  // 1. 首次挂载只拉取一次（初始徽标）
  useEffect(() => {
    feed.start(); setActions([]); setLoading(false);
    void load();
    return () => feed.stop();
  }, [feed, load]);

  // 2. 仅活动期间读取本地状态；展开空闲面板不启动定时轮询
  useEffect(() => {
    const shouldPoll = activeCount > 0;
    if (!shouldPoll) return;

    const interval = 3000;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void load();
    }, interval);

    return () => window.clearInterval(timer);
  }, [activeCount, load]);

  // 3. 监听全局 action 触发唤醒事件
  useEffect(() => {
    const handleWakeup = () => void load(true);
    window.addEventListener("action:refresh", handleWakeup);
    const operation = (event: Event) => { const detail = (event as CustomEvent<OperationEvent>).detail; if (detail.session === sessionToken && detail.phase === "end" && detail.actionsChanged) void load(true); };
    const visibility = () => { if (!document.hidden) void load(); };
    window.addEventListener("domain-hub:operation", operation);
    document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("action:refresh", handleWakeup); window.removeEventListener("domain-hub:operation", operation); document.removeEventListener("visibilitychange", visibility); };
  }, [load, sessionToken]);

  // 4. 全方位自动收起交互：
  //    ① 监听 pointerdown（触控/鼠标点击外部自动收起）
  //    ② 监听 Escape 键自动收起
  //    ③ 页面滚动时自动收起（排除面板自身的滚轮滚动）
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };

    const handleScroll = (e: Event) => {
      if (
        panelRef.current &&
        (panelRef.current === e.target || panelRef.current.contains(e.target as Node))
      ) {
        return;
      }
      setOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [open]);

  const handleToggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      void load(true); // 展开瞬间立即拉取一次最新状态
    }
  };

  return (
    <div ref={containerRef} className="relative flex-shrink-0">
      {/* 顶栏图标触发器 */}
      <button
        type="button"
        onClick={handleToggleOpen}
        className={`relative p-2 rounded-xl text-content-muted hover:text-content-primary hover:bg-hovered/80 transition-all ${
          open ? "bg-hovered text-accent" : ""
        }`}
        title="操作中心"
        aria-label="操作中心"
        aria-expanded={open}
      >
        <Activity className={`w-5 h-5 ${activeCount > 0 ? "text-accent animate-pulse" : ""}`} />
        {activeCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-accent text-[10px] leading-4 text-[var(--accent-contrast)] text-center font-bold shadow-sm">
            {activeCount > 9 ? "9+" : activeCount}
          </span>
        )}
      </button>

      {/* 展开的下拉操作中心面板 */}
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 mt-2 w-[calc(100vw-1.5rem)] sm:w-96 max-h-[28rem] overflow-y-auto overscroll-contain dropdown-panel p-3.5 z-modal flex flex-col space-y-3 scrollbar-thin"
        >
          {/* 面板头部 */}
          <div className="flex items-center justify-between pb-2 border-b border-border-base/60">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-content-primary tracking-wide">操作中心</span>
              {activeCount > 0 ? (
                <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-md bg-accent/15 text-accent border border-accent/25 animate-pulse">
                  {activeCount} 进行中
                </span>
              ) : (
                <span className="px-1.5 py-0.5 text-[10px] text-content-muted rounded-md bg-surface/50 border border-border-base/40">
                  空闲
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void load()}
                disabled={loading}
                className="p-1 rounded-lg hover:bg-hovered text-content-muted hover:text-accent transition-colors disabled:opacity-50"
                title="手动刷新"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-1 rounded-lg hover:bg-hovered text-content-muted hover:text-content-primary transition-colors"
                title="关闭面板"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* 任务列表 */}
          <div className="space-y-2 overflow-y-auto flex-1 pr-0.5">
            {items.length === 0 ? (
              <div className="py-8 text-center text-xs text-content-muted">
                暂无后台操作记录
              </div>
            ) : (
              items.map((item) => {
                const progressPct = Math.round(Math.max(0, Math.min(100, Number(item.progress) || 0)));
                return (
                  <div
                    key={item.id}
                    className="p-2.5 rounded-xl bg-surface/40 hover:bg-surface/70 border border-border-base/50 hover:border-accent/30 transition-all space-y-2"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <StatusIcon status={item.status} />
                        <span className="font-semibold text-content-primary truncate">{label(item.type)}</span>
                        <span className="text-[10px] text-content-muted font-mono bg-elevated px-1.5 py-0.5 rounded border border-border-base/30">
                          {item.sync_status ? item.advancing ? "同步中" : item.sync_status === "queued" ? "等待继续" : item.sync_status === "blocked" ? "需处理" : item.sync_status === "paused" ? "暂缓" : statusText(item.status) : statusText(item.status)}
                        </span>
                      </div>
                      <span className="text-xs font-semibold text-accent font-mono ml-2 flex-shrink-0">
                        {progressPct}%
                      </span>
                    </div>
                    {item.sync_status && <div className="text-[11px] text-content-muted space-y-1">
                      <div className="font-medium text-content-secondary truncate">{item.alias || `账号 ${item.accountId}`}</div>
                      <div>{syncStatusText({ ...item, accountId: item.accountId ?? 0, status: item.sync_status }, syncEnabled)}</div>
                      {item.last_completed_at && <div>最后完整成功 {new Date(item.last_completed_at * 1000).toLocaleString()}</div>}
                    </div>}

                    {/* 进度条槽体与动态填充 */}
                    <div role="progressbar" aria-label={`${label(item.type)}进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPct} className="h-1.5 rounded-full bg-elevated/90 border border-border-base/40 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-accent to-accent-hover transition-all duration-300 shadow-[0_0_8px_rgb(var(--accent-rgb)/0.4)]"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>

                    {item.error && (
                      <div className="text-[11px] text-[var(--state-danger-fg)] line-clamp-2 px-1">
                        {item.error}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ActionCenter;
