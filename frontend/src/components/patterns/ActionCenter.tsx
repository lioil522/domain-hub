import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, CheckCircle2, XCircle, PauseCircle, Clock, RefreshCw, X } from "lucide-react";
import type { ApiFetch } from "../../api/client";
import { actionsApi } from "../../api/endpoints/actions";

type ActionItem = {
  id: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  error?: string | null;
  metadata?: unknown;
};

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
  if (status === "failed") return <XCircle className="w-4 h-4 text-[var(--state-danger-fg)] flex-shrink-0" />;
  if (status === "cancelled") return <PauseCircle className="w-4 h-4 text-content-muted flex-shrink-0" />;
  if (status === "queued") return <Clock className="w-4 h-4 text-content-muted flex-shrink-0" />;
  return <Activity className="w-4 h-4 text-accent animate-pulse flex-shrink-0" />;
}

export function ActionCenter({ apiFetch }: { apiFetch: ApiFetch }) {
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [loading, setLoading] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await actionsApi.list(apiFetch, 12) as { actions?: ActionItem[] };
      if (Array.isArray(response?.actions)) setActions(response.actions);
    } catch {
      // Action Center is auxiliary UI; failures must not break the shell.
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  // 计算当前活动中的任务数（排队中或运行中）
  const activeCount = useMemo(
    () => actions.filter((item) => item.status === "queued" || item.status === "running").length,
    [actions]
  );

  // 1. 首次挂载只拉取一次（初始徽标）
  useEffect(() => {
    void load();
  }, [load]);

  // 2. 自适应智能轮询：仅在有活动任务或展开面板时轮询，闲置时自动休眠
  useEffect(() => {
    const shouldPoll = open || activeCount > 0;
    if (!shouldPoll) return;

    const interval = activeCount > 0 ? 3000 : 6000;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void load();
    }, interval);

    return () => window.clearInterval(timer);
  }, [open, activeCount, load]);

  // 3. 监听全局 action 触发唤醒事件
  useEffect(() => {
    const handleWakeup = () => void load();
    window.addEventListener("action:refresh", handleWakeup);
    return () => window.removeEventListener("action:refresh", handleWakeup);
  }, [load]);

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
      void load(); // 展开瞬间立即拉取一次最新状态
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
            {actions.length === 0 ? (
              <div className="py-8 text-center text-xs text-content-muted">
                暂无后台操作记录
              </div>
            ) : (
              actions.map((item) => {
                const progressPct = Math.max(0, Math.min(100, Number(item.progress) || 0));
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
                          {statusText(item.status)}
                        </span>
                      </div>
                      <span className="text-xs font-semibold text-accent font-mono ml-2 flex-shrink-0">
                        {progressPct}%
                      </span>
                    </div>

                    {/* 进度条槽体与动态填充 */}
                    <div className="h-1.5 rounded-full bg-elevated/90 border border-border-base/40 overflow-hidden">
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
