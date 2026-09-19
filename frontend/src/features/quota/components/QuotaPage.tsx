import { RefreshCw, Database, AlertTriangle } from "lucide-react";
import type { Quota } from "../../../types/quota";

/**
 * QuotaPage —— DNSHE 账户域名配额概览标签页
 *
 * JSX 从 App.tsx 逐字搬运（Phase 12）。状态由 App 提供（配额随「按需拉取」effect 刷新）。
 */
export interface QuotaPageProps {
  quotas: Quota[];
  loadingQuotas: boolean;
  /** 拉取配额；force=true 为强制回源刷新 */
  fetchQuotas: (force?: boolean) => void;
}

export function QuotaPage(props: QuotaPageProps) {
  const { quotas, loadingQuotas, fetchQuotas } = props;

  return (
    <div className="pt-5 md:pt-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4 sm:mb-6">
        <h2 className="text-base sm:text-lg font-bold text-content-primary">DNSHE 账户域名配额概览</h2>
        <button
          onClick={() => fetchQuotas(true)}
          disabled={loadingQuotas}
          className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-3 py-2 sm:py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 disabled:opacity-60 flex-shrink-0"
          title="强制从 DNSHE 重新拉取配额"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loadingQuotas ? "animate-spin" : ""}`} />
          刷新
        </button>
      </div>

      {loadingQuotas ? (
        <div className="flex justify-center py-20">
          <RefreshCw className="w-8 h-8 animate-spin text-accent" />
        </div>
      ) : quotas.length === 0 ? (
        <div className="text-center py-20 border border-dashed border-border-base rounded-xl bg-surface">
          <Database className="w-12 h-12 text-content-muted mx-auto mb-3" />
          <p className="text-content-muted">没有查到配额数据。请确保至少绑定了一个账户，并且密钥配置无误。</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
          {quotas.map((q, idx) => {
            if (q.error) {
              return (
                <div key={idx} className="bg-red-50 border border-red-200 dark:bg-red-950/20 dark:border-red-900/50 rounded-xl p-4 sm:p-5">
                  <h3 className="font-bold text-red-700 dark:text-red-400 truncate">{q.alias}</h3>
                  <p className="text-red-800 dark:text-red-300 text-sm mt-2 flex items-start gap-1.5">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span className="min-w-0 break-words">API 调用异常: {q.error}</span>
                  </p>
                </div>
              );
            }

            const percent = q.total > 0 ? Math.round((q.used / q.total) * 100) : 0;

            return (
              <div key={q.account_id} className="glass-card rounded-xl p-4 sm:p-5 border border-border-base">
                <div className="flex justify-between items-center gap-2 mb-4">
                  <h3 className="font-bold text-content-primary text-base sm:text-lg truncate min-w-0">{q.alias}</h3>
                  <span className="text-xs bg-accent-soft text-accent px-2 py-0.5 rounded-full flex-shrink-0">
                    可用: {q.available}
                  </span>
                </div>

                {/* 环形/条形进度展示 */}
                <div className="space-y-3">
                  <div className="flex justify-between text-xs text-content-muted">
                    <span>已用子域名: {q.used} / {q.total}</span>
                    <span>{percent}%</span>
                  </div>
                  <div className="w-full bg-elevated h-2 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        percent > 85 ? "bg-red-500" : percent > 60 ? "bg-amber-500" : "bg-accent"
                      }`}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 mt-6 pt-4 border-t border-border-base text-center">
                  <div>
                    <span className="block text-[11px] text-content-muted">基础配额</span>
                    <span className="text-sm font-semibold text-content-secondary">{q.base}</span>
                  </div>
                  <div>
                    <span className="block text-[11px] text-content-muted">邀请赠送</span>
                    <span className="text-sm font-semibold text-content-secondary">+{q.invite_bonus}</span>
                  </div>
                  <div>
                    <span className="block text-[11px] text-content-muted">总配额</span>
                    <span className="text-sm font-semibold text-content-primary">{q.total}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
