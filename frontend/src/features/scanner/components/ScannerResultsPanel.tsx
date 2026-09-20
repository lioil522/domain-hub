import { CheckCircle2, Plus, ScrollText } from "lucide-react";
import type { UseScannerReturn } from "../hooks/useScanner";

interface ScannerResultsPanelProps {
  scanner: UseScannerReturn;
}

export function ScannerResultsPanel({ scanner }: ScannerResultsPanelProps) {
  const {
    scanProgress,
    availableDomainsList,
    scanStatus,
    scanLogs,
    handleRegisterFromResult,

  } = scanner;

  if (scanProgress.total <= 0) return null;

  if (scanProgress.total <= 0) return null;

  return (
                  <div className="bg-surface border border-border-base rounded-2xl p-6 shadow-xl space-y-4">
                    <div className="flex items-center justify-between text-xs font-semibold text-content-secondary">
                      <span>查重进度: {scanProgress.checked} / {scanProgress.total} ({Math.round((scanProgress.checked / scanProgress.total) * 100)}%)</span>
                      <span className="text-emerald-400 font-bold">🎉 发现可用免费域名: {availableDomainsList.length} 个</span>
                    </div>

                    {/* 进度条 */}
                    <div className="w-full bg-elevated rounded-full h-3 overflow-hidden border border-border-base">
                      <div
                        className="bg-accent h-full transition-all duration-300"
                        style={{ width: `${Math.round((scanProgress.checked / scanProgress.total) * 100)}%` }}
                      ></div>
                    </div>

                    {/* 发现可注册域名的实时表格 */}
                    <div className="space-y-3 pt-2">
                      <h4 className="text-sm font-bold text-content-primary flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        发现未注册域名 (点击注册)
                      </h4>

                      {availableDomainsList.length === 0 ? (
                        <div className="text-center py-8 bg-hovered rounded-xl border border-border-base text-xs text-content-muted">
                          {scanStatus === "running" ? "正在高频查重校验中，请稍候..." : "暂未查出可用的域名"}
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                          {availableDomainsList.map((item, idx) => (
                            <div
                              key={idx}
                              className="bg-emerald-50 border border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-500/30 rounded-xl p-3 flex items-center justify-between gap-2 hover:border-emerald-500 transition-all"
                            >
                              <div className="min-w-0">
                                <span className="font-mono text-sm font-bold text-content-primary block truncate">
                                  {item.fullDomain}
                                </span>
                                <span className="text-[10px] text-content-muted block mt-0.5">
                                  查出时间: {item.time}
                                </span>
                              </div>

                              <button
                                onClick={() => handleRegisterFromResult(item)}
                                className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-3 py-2 sm:py-1.5 rounded-lg shadow transition-all flex items-center gap-1 flex-shrink-0"
                              >
                                <Plus className="w-3.5 h-3.5" /> 注册
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 实时爆破扫描中文日志卡片 */}
                    <div className="space-y-3 pt-4 border-t border-border-base">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-bold text-content-primary flex items-center gap-2">
                          <ScrollText className="w-4 h-4 text-accent" />
                          实时查询日志 (自动滚动最新 50 条)
                        </h4>
                        <span className="text-xs text-content-muted font-mono">
                          {scanLogs.length > 0 ? `最新推送: ${scanLogs[0].time}` : "等待扫码响应..."}
                        </span>
                      </div>

                      <div className="bg-elevated rounded-xl p-3.5 border border-border-base font-mono text-xs max-h-56 overflow-y-auto space-y-1.5 scrollbar-thin">
                        {scanLogs.length === 0 ? (
                          <div className="text-center py-6 text-content-muted">
                            正在高频检测中，实时中文日志流水将在此处高频输出...
                          </div>
                        ) : (
                          scanLogs.map((log) => (
                            <div key={log.id} className="flex items-start gap-2 border-b border-border-base pb-1 last:border-0">
                              <span className="text-content-muted font-semibold flex-shrink-0">[{log.time}]</span>
                              <span className={`min-w-0 break-all ${
                                log.status === "available"
                                  ? "text-emerald-400 font-bold"
                                  : log.status === "error"
                                  ? "text-amber-400"
                                  : "text-content-muted"
                              }`}>
                                {log.text}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
  );
}
