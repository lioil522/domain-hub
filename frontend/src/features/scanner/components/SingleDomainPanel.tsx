import { Search, Plus, AlertTriangle, CheckCircle2 } from "lucide-react";
import { toASCII, hasNonASCII } from "../../../punycode";
import { CustomSelect } from "../../../components/form/CustomSelect";
import type { Account } from "../../../types/account";
import type { UseScannerReturn } from "../hooks/useScanner";

interface SingleDomainPanelProps {
  scanner: UseScannerReturn;
  dnsheAccounts: Account[];
  actionLoading: string | null;
}

export function SingleDomainPanel({ scanner, dnsheAccounts, actionLoading }: SingleDomainPanelProps) {
  const {
    allRootDomains,
    searchSubdomain,
    setSearchSubdomain,
    searchRootdomain,
    setSearchRootdomain,
    whoisLoading,
    whoisResult,
    registerAccountId,
    setRegisterAccountId,
    handleCheckWhois,
    handleRegisterSubdomain,
  } = scanner;

  return (
              <div className="space-y-6">
                {/* 1. 单域名 WHOIS 查重表单卡片 */}
                <div className="bg-surface border border-border-base rounded-2xl p-6 shadow-xl space-y-6">
                  <div>
                    <h3 className="text-lg font-bold text-content-primary flex items-center gap-2">
                      <Search className="w-5 h-5 text-accent" /> 单精准域名 WHOIS 查重与注册
                    </h3>
                    <p className="text-xs text-content-muted mt-1">
                      输入您心仪的二级前缀，选择 9 大免费根域名之一，实时检测域名注册状态及 WHOIS 到期详细信息。
                    </p>
                  </div>

                  <form onSubmit={handleCheckWhois} className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-end">
                    <div className="sm:col-span-6 space-y-2">
                      <label htmlFor="registerpage-fld1" className="block text-xs font-semibold text-content-secondary">
                        二级域名前缀:
                      </label>
                      <input id="registerpage-fld1"
                        type="text"
                        placeholder="例如: myapp 或 中文域名"
                        value={searchSubdomain}
                        onChange={(e) => setSearchSubdomain(e.target.value)}
                        className="w-full bg-elevated border border-border-base focus:border-accent rounded-xl px-4 py-3 text-sm text-content-primary placeholder-content-muted focus:outline-none"
                      />
                    </div>

                    <div className="sm:col-span-3 space-y-2">
                      <span className="block text-xs font-semibold text-content-secondary">
                        根域名后缀:
                      </span>
                      <CustomSelect
                        value={searchRootdomain}
                        onChange={setSearchRootdomain}
                        bare
                        ariaLabel="根域名后缀"
                        options={allRootDomains.map((rd) => ({ value: rd, label: `.${rd}` }))}
                        className="bg-elevated border border-border-base focus:border-accent rounded-xl px-4 py-3 text-sm text-content-primary focus:outline-none"
                      />
                    </div>

                    <div className="sm:col-span-3">
                      <button
                        type="submit"
                        disabled={whoisLoading}
                        className="w-full bg-accent-gradient hover:opacity-95 text-accent-contrast font-bold text-sm px-6 py-3 rounded-xl transition-all shadow-lg shadow-accent flex items-center justify-center gap-2 disabled:opacity-50"
                      >
                        <Search className={`w-4 h-4 ${whoisLoading ? "animate-spin" : ""}`} />
                        {whoisLoading ? "正在查询..." : "WHOIS 查重"}
                      </button>
                    </div>
                  </form>

                  {/* 中文前缀实时 Punycode 预览（置于表单外，避免撑乱 grid 行高） */}
                  {hasNonASCII(searchSubdomain) && (
                    <p className="text-[11px] text-accent -mt-2 font-mono">
                      将以 Punycode 提交：<span className="font-bold">{toASCII(searchSubdomain.trim())}.{searchRootdomain}</span>
                    </p>
                  )}
                </div>

                {/* 2. WHOIS 查询结果展示 */}
                {whoisResult && (
                  <div>
                    {!whoisResult.registered ? (
                      /* 未注册：绿色可注册卡片 */
                      <div className="bg-surface border border-emerald-500/30 rounded-2xl p-4 sm:p-6 shadow-xl space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border-base pb-4">
                          <div className="min-w-0">
                            <span className="inline-block bg-emerald-50 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400 text-xs font-bold px-2.5 py-1 rounded-full mb-1">
                              尚未注册
                            </span>
                            <h4 className="text-lg sm:text-xl font-bold text-content-primary break-all">
                              {whoisResult.searchedDomain}
                            </h4>
                          </div>
                          <div className="text-emerald-400 text-xs sm:text-sm font-semibold flex items-start sm:items-center gap-1 min-w-0">
                            <CheckCircle2 className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0 mt-0.5 sm:mt-0" />
                            该域名目前仍处于未注册状态，可以立即在线注册！
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 items-end">
                          <div className="space-y-2">
                            <span className="block text-xs font-semibold text-content-secondary">
                              选择注册的目标账号:
                            </span>
                            <CustomSelect
                              value={String(registerAccountId)}
                              onChange={(v) => setRegisterAccountId(Number(v))}
                              bare
                              ariaLabel="选择注册的目标账号"
                              options={
                                dnsheAccounts.length === 0
                                  ? [{ value: "", label: "暂无可用的绑定账号" }]
                                  : dnsheAccounts.map((acc) => ({
                                      value: String(acc.id),
                                      label: `${acc.alias} (ID: ${acc.id})`,
                                    }))
                              }
                              className="bg-elevated border border-border-base focus:border-accent rounded-xl px-4 py-3 text-sm text-content-primary focus:outline-none"
                            />
                          </div>

                          <div>
                            <button
                              onClick={handleRegisterSubdomain}
                              disabled={actionLoading === "register-subdomain" || dnsheAccounts.length === 0}
                              className="w-full bg-emerald-600 hover:bg-emerald-500 border border-transparent text-white font-bold text-sm px-6 py-3 rounded-xl transition-all shadow-lg flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Plus className="w-4 h-4" />
                              {actionLoading === "register-subdomain" ? "正在注册中..." : "一键注册该域名"}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      /* 已被注册：红色提示卡片 */
                      <div className="bg-surface border border-red-500/30 rounded-2xl p-4 sm:p-6 shadow-xl space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border-base pb-4">
                          <div className="min-w-0">
                            <span className="inline-block bg-red-50 text-red-700 dark:bg-red-500/20 dark:text-red-400 text-xs font-bold px-2.5 py-1 rounded-full mb-1">
                              已被注册
                            </span>
                            <h4 className="text-lg sm:text-xl font-bold text-content-secondary break-all">
                              {whoisResult.searchedDomain}
                            </h4>
                          </div>
                          <div className="text-red-400 text-xs sm:text-sm font-semibold flex items-center gap-1 flex-shrink-0">
                            <AlertTriangle className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" />
                            已被他人抢先注册
                          </div>
                        </div>

                        {/* WHOIS 详细数据表 */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs pt-2">
                          <div className="bg-elevated p-3 rounded-lg border border-border-base">
                            <span className="text-content-muted">注册时间：</span>
                            <span className="text-content-secondary font-medium ml-1">{whoisResult.registered_at || "保密 / 未公开"}</span>
                          </div>
                          <div className="bg-elevated p-3 rounded-lg border border-border-base">
                            <span className="text-content-muted">到期时间：</span>
                            <span className="text-content-secondary font-medium ml-1">{whoisResult.expires_at || "保密 / 未公开"}</span>
                          </div>
                          <div className="bg-elevated p-3 rounded-lg border border-border-base sm:col-span-2">
                            <span className="text-content-muted">当前 NS 域名服务器：</span>
                            <span className="text-content-secondary font-medium ml-1">
                              {Array.isArray(whoisResult.nameservers) ? whoisResult.nameservers.join(", ") : "系统默认 NS"}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
  );
}
