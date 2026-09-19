import type { FormEvent } from "react";
import { Input } from "../../../components/form/Input";
import { X, Plus, RefreshCw } from "lucide-react";

/**
 * LineSettingsPage —— 解析线路支持名单标签页（DNSHE 专属）
 *
 * JSX 从 App.tsx 逐字搬运（Phase 12）。线路名单状态仍由 App 持有（domainSupportsLine
 * 还需要被 DNS 解析弹窗消费），此组件只接收并展示。
 */
export interface LineSettingsPageProps {
  lineNsSuffixes: string[];
  onRemoveSuffix: (sfx: string) => void;
  newLineNsInput: string;
  setNewLineNsInput: (v: string) => void;
  onAddSuffix: (e: FormEvent) => void;
  onRestoreSuffixes: () => void;

  knownRootDomains: string[];
  rootNs: Record<string, string[] | null>;
  hasDnsheAccount: boolean;
  learnedLineRoots: string[];
  onClearLearnedLineRoots: () => void;
  onRefreshRootNs: () => void;
  nsHostMatchesSuffix: (ns: string) => boolean;
  actionLoading: string | null;
}

export function LineSettingsPage(props: LineSettingsPageProps) {
  const {
    lineNsSuffixes,
    onRemoveSuffix,
    newLineNsInput,
    setNewLineNsInput,
    onAddSuffix,
    onRestoreSuffixes,
    knownRootDomains,
    rootNs,
    hasDnsheAccount,
    learnedLineRoots,
    onClearLearnedLineRoots,
    onRefreshRootNs,
    nsHostMatchesSuffix,
    actionLoading,
  } = props;

  return (
    <div className="space-y-4 pt-5 md:pt-6">
      <div>
        <h2 className="text-base sm:text-lg font-bold text-content-primary">解析线路支持名单</h2>
        <p className="text-content-muted mt-1 text-sm">
          判定哪些根域名支持按线路解析（电信 / 联通 / 移动 / 海外 / 教育网）。这是 DNSHE 专属能力。
        </p>
      </div>
      {/* 解析线路支持名单 */}
      <div className="bg-surface border border-border-base rounded-2xl p-4 sm:p-5 space-y-4">
        <p className="text-xs text-content-muted leading-relaxed">
          上游 API 没有「域名是否支持按线路解析」的字段，本面板按根域名的
          <span className="font-mono text-accent"> NS 记录 </span>
          判断：NS 落在下列后缀内（即该根域托管在提供线路解析的 DNS 商），其下域名就可以选择
          电信 / 联通 / 移动 / 海外 / 教育网，其余只能保持默认。上游对不支持的域名会
          <b>静默忽略</b>线路参数而不报错，所以这里主动拦住，避免出现「设了线路却没生效」。
          NS 由后端查询并缓存 30 天。
        </p>

        <div className="flex flex-wrap gap-2">
          {lineNsSuffixes.length === 0 ? (
            <span className="text-xs text-content-muted">名单为空，所有域名都会按「不支持线路」处理</span>
          ) : (
            lineNsSuffixes.map((sfx) => (
              <span
                key={sfx}
                className="group flex items-center bg-sky-50 border border-sky-200 text-sky-700 dark:bg-sky-950/30 dark:border-sky-500/30 dark:text-sky-300 text-xs rounded-lg overflow-hidden"
              >
                <span className="px-2.5 py-1 font-mono">*.{sfx}</span>
                <button
                  onClick={() => onRemoveSuffix(sfx)}
                  className="px-1.5 py-1 text-sky-500/70 hover:text-sky-800 hover:bg-sky-100 border-l border-sky-200 dark:text-sky-400/60 dark:hover:text-sky-300 dark:hover:bg-sky-900/40 dark:border-sky-500/30 transition-all"
                  title={`从名单移除 ${sfx}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))
          )}
        </div>

        <form onSubmit={onAddSuffix} className="flex flex-wrap items-center gap-2">
          <Input size="sm" mono
            type="text"
            name="dnshe-line-ns-suffix"
            autoComplete="off"
            value={newLineNsInput}
            onChange={(e) => setNewLineNsInput(e.target.value)}
            placeholder="NS 后缀，如 alidns.com，可一次填多个（逗号 / 空格分隔）"
            className="flex-1 min-w-[12rem] text-content-primary placeholder:text-content-muted"
          />
          <button
            type="submit"
            className="btn-primary px-3 py-2 rounded-lg text-xs font-bold text-white flex items-center gap-1.5 flex-shrink-0"
          >
            <Plus className="w-3.5 h-3.5" /> 添加
          </button>
          <button
            type="button"
            onClick={onRestoreSuffixes}
            className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-3 py-2 rounded-lg text-xs font-semibold flex-shrink-0"
          >
            恢复默认
          </button>
        </form>

        {hasDnsheAccount && knownRootDomains.length > 0 && (
          <div className="pt-3 border-t border-border-soft space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold text-content-secondary">各根域名的 NS 与判定结果</div>
              <div className="flex items-center gap-2">
                {learnedLineRoots.length > 0 && (
                  <button
                    onClick={onClearLearnedLineRoots}
                    className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-2.5 py-1 rounded-lg text-[11px] font-semibold flex-shrink-0"
                    title="清空「实测已确认」标记，让判定完全回到 NS 名单"
                  >
                    清空实测标记
                  </button>
                )}
                <button
                  onClick={onRefreshRootNs}
                  disabled={actionLoading === "ns-lookup"}
                  className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-2.5 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1.5 flex-shrink-0 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${actionLoading === "ns-lookup" ? "animate-spin" : ""}`} />
                  重新查询 NS
                </button>
              </div>
            </div>
            {knownRootDomains.map((root) => {
              const ns = rootNs[root];
              const learned = learnedLineRoots.includes(root);
              const on = learned || (!!ns && ns.length > 0 && ns.some(nsHostMatchesSuffix));
              // NS 尚未查到时判定实际走 provider_account_id 兜底，标注出来免得用户以为面板失灵
              const unknown = !ns || ns.length === 0;
              return (
                <div key={root} className="text-[11px] font-mono flex flex-wrap items-baseline gap-x-2">
                  <span className={on ? "text-sky-700 dark:text-sky-300 font-bold" : "text-content-muted"}>
                    {root}
                  </span>
                  <span className="text-content-muted">→</span>
                  <span className="text-content-secondary break-all">
                    {unknown ? "NS 未知（判定回退到服务商 ID）" : ns!.join("、")}
                  </span>
                  {on && <span className="text-[10px] text-sky-700 dark:text-sky-300">（支持线路）</span>}
                  {learned && <span className="text-[10px] text-emerald-700 dark:text-emerald-300">（实测已确认）</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
