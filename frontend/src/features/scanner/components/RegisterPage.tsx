/**
 * RegisterPage —— 「注册查重」标签页（activeTab === "register"）。
 *
 * 由 App.tsx 纯搬运抽出（Phase 9）。DOM / className / 文案逐字未改，行为保持一致。
 * 状态与动作全部来自 useScanner；本组件只负责渲染，并从 scanner 对象解构所需字段。
 *
 * 两种模式：
 *   A. 精准单域名查重（WHOIS 查重 + 一键注册）
 *   B. 规则多域名查重（规则词库 / 顺序模式 / 断点续查 / 实时日志）
 *
 * 与原始 App 内联 JSX 的唯一差异（均为等价改写）：
 *   - 「暂停查询」按钮内联逻辑 → scanner.pauseScan()
 *   - 「重新开始」按钮内联逻辑 → scanner.resetScan()
 *   - 结果卡片「注册」按钮内联回填逻辑 → scanner.handleRegisterFromResult(item)
 */
import {
  Search,
  Sparkles,
  Play,
  Plus,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  X,
  Info,
  RefreshCw,
  Pencil,
  Download,
  ScrollText
} from "lucide-react";
import { toASCII, hasNonASCII } from "../../../punycode";
import { BANK_KIND_META, type BankKind } from "../../../wordbanks";
import { CustomSelect } from "../../../components/form/CustomSelect";
import { BUILTIN_TOKENS } from "../../../rulegen";
import type { Account } from "../../../types/account";
import type { UseScannerReturn } from "../hooks/useScanner";

interface RegisterPageProps {
  scanner: UseScannerReturn;
  dnsheAccounts: Account[];
  actionLoading: string | null;
}

export function RegisterPage({ scanner, dnsheAccounts, actionLoading }: RegisterPageProps) {
  const {
    // 常量
    DEFAULT_ROOT_DOMAINS,
    MAX_PREFIXES,
    // 根域名
    allRootDomains,
    newRootInput,
    setNewRootInput,
    handleAddCustomRootDomain,
    handleRemoveCustomRootDomain,
    // 单域名 WHOIS / 注册
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
    // 模式切换
    regMode,
    setRegMode,
    // 规则生成
    batchRules,
    setBatchRules,
    excludeChars,
    setExcludeChars,
    selectedRoots,
    setSelectedRoots,
    batchLength,
    setBatchLength,
    rulePreview,
    formatDuration,
    // 顺序模式
    seqMode,
    setSeqMode,
    seqCharset,
    setSeqCharset,
    seqLength,
    setSeqLength,
    seqStart,
    setSeqStart,
    // 扫描控制 / 进度 / 结果
    scanStatus,
    scanProgress,
    availableDomainsList,
    scanLogs,
    scanCursor,
    handleStartBatchScan,
    handleExportAvailableTxt,
    clearScanCursor,
    handleRegisterFromResult,
    ignorePool,
    setIgnorePool,
    resetScan,
    pauseScan,
    showToast,
    // 保留前缀
    reservedPrefixes,
    enableReservedFilter,
    newReservedInput,
    setNewReservedInput,
    handleAddReserved,
    handleRemoveReserved,
    handleResetReserved,
    toggleReservedFilter,
    // 词库
    wordBanks,
    openCreateBank,
    openEditBank,
    handleDeleteBank,
    handleResetBanks,
    appendWordbank,
  } = scanner;

  return (
          <div className="space-y-6 max-w-5xl mx-auto pt-5 md:pt-6">
            
            {/* 模式选择导航 */}
            <div className="flex flex-col sm:flex-row bg-surface p-1.5 rounded-2xl border border-border-base gap-2">
              <button
                onClick={() => setRegMode("single")}
                className={`flex-1 py-3 text-sm font-bold rounded-xl transition-all flex items-center justify-center gap-2 ${
                  regMode === "single"
                    ? "bg-accent text-accent-contrast shadow-lg shadow-accent"
                    : "text-content-muted hover:text-content-primary hover:bg-hovered"
                }`}
              >
                <Search className="w-4 h-4" /> 精准单域名查重
              </button>
              <button
                onClick={() => setRegMode("batch")}
                className={`flex-1 py-3 text-sm font-bold rounded-xl transition-all flex items-center justify-center gap-2 ${
                  regMode === "batch"
                    ? "bg-accent text-accent-contrast shadow-lg shadow-accent"
                    : "text-content-muted hover:text-content-primary hover:bg-hovered"
                }`}
              >
                <Sparkles className="w-4 h-4 text-amber-400" /> 规则多域名查重
              </button>
            </div>

            {/* 模式 A: 精准单域名查重卡片 */}
            {regMode === "single" && (
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
            )}

            {/* 模式 B: 规则多域名查重控制台 */}
            {regMode === "batch" && (
              <div className="space-y-6">
                
                {/* 规则与生成配置卡片 */}
                <div className="bg-surface border border-border-base rounded-2xl p-6 shadow-xl space-y-6">
                  
                  {/* 1. 生成规则输入框 */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-baseline flex-wrap gap-x-2 gap-y-1 min-w-0">
                        <label htmlFor="registerpage-fld2" className="block text-sm font-semibold text-content-secondary shrink-0">
                          生成规则:
                        </label>
                        {/* 组合数预估：由各槽位大小相乘得出，不实际生成。
                            放在标题行而非输入框下方 —— 标题行本就有横向留白，不额外占高度。 */}
                        {rulePreview.parsed.unknownTokens.length > 0 ? (
                          <span className="text-xs text-red-400 flex items-center gap-1.5 min-w-0">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">
                              无法识别的标签：{rulePreview.parsed.unknownTokens.join("、")}
                            </span>
                          </span>
                        ) : rulePreview.emptiedByExclude ? (
                          <span className="text-xs text-amber-400 flex items-center gap-1.5 min-w-0">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">
                              排除字符「{excludeChars.trim()}」把某一位的候选全滤掉了，组合数为 0
                            </span>
                          </span>
                        ) : rulePreview.total > 0 ? (
                          <span className="text-xs text-content-muted flex items-center gap-1.5">
                            <Info className="w-3.5 h-3.5 shrink-0 text-accent" />
                            当前规则穷举将会产生
                            <span className="text-red-400 font-bold">
                              {rulePreview.total.toLocaleString()}
                            </span>
                            条域名组合
                          </span>
                        ) : null}
                      </div>
                      <button
                        onClick={() => {
                          setBatchRules("");
                          showToast("info", "已清空生成规则");
                        }}
                        disabled={!batchRules}
                        className="shrink-0 text-xs font-semibold text-content-muted hover:text-red-700 border border-border-base hover:border-red-300 bg-elevated hover:bg-red-50 dark:hover:text-red-400 dark:hover:border-red-500/40 dark:hover:bg-red-950/30 px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        一键清空
                      </button>
                    </div>
                    <div className="flex items-center bg-elevated border border-border-base rounded-xl px-4 focus-within:border-accent transition-colors">
                      <input id="registerpage-fld2"
                        type="text"
                        value={batchRules}
                        onChange={(e) => setBatchRules(e.target.value)}
                        placeholder="例如: {字母}{字母}{字母} 或 my{字母}{数字}，也可直接填 myapp, test123"
                        className="w-full bg-transparent py-3 text-content-primary text-sm focus:outline-none"
                      />
                      <span className="text-xs text-accent font-bold whitespace-nowrap px-2">
                        {rulePreview.parsed.unknownTokens.length > 0
                          ? "⚠ 标签无法识别"
                          : rulePreview.emptiedByExclude
                            ? "⚠ 已被排除字符清空"
                            : rulePreview.total > 0
                              ? "ⓘ 规则就绪"
                              : "ⓘ 待输入规则"}
                      </span>
                    </div>

                    {/* 超限与耗时警告：偶发且文字较长，留在输入框下方，不挤占标题行 */}
                    {rulePreview.total > 0 &&
                      (rulePreview.total > MAX_PREFIXES ||
                        (selectedRoots.length > 0 && rulePreview.total > 5000)) && (
                        <p className="text-xs text-amber-400 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          {rulePreview.total > MAX_PREFIXES && (
                            <span>超出上限，仅处理前 {MAX_PREFIXES.toLocaleString()} 条。</span>
                          )}
                          {selectedRoots.length > 0 && rulePreview.total > 5000 && (
                            <span>
                              按当前 {dnsheAccounts.length || 1} 个账号 × {selectedRoots.length} 个后缀估算，
                              约需 {formatDuration(rulePreview.estSeconds)}，建议改用顺序模式配合断点续查
                            </span>
                          )}
                        </p>
                      )}
                  </div>

                  {/* 2. 排除字符与长度 */}
                  <div className="flex flex-col md:flex-row md:items-start gap-4">
                    <div className="flex-1 min-w-0 space-y-2">
                      <label htmlFor="registerpage-fld3" className="block text-xs font-semibold text-content-muted h-4 leading-4">
                        排除字符 (可选，若域名中出现定义的字符，则忽略):
                      </label>
                      <input id="registerpage-fld3"
                        type="text"
                        value={excludeChars}
                        onChange={(e) => setExcludeChars(e.target.value)}
                        placeholder="例如 01ol 避免字符易混淆 (可选)"
                        className="w-full bg-elevated border border-border-base rounded-xl px-4 py-2.5 text-content-primary text-xs focus:border-accent focus:outline-none"
                      />
                    </div>
                    <div className="w-full md:w-[19rem] shrink-0 space-y-2">
                      {/* 提示放在标题行：与左列标题同高，不撑高行、不影响两列输入框对齐 */}
                      <div className="flex items-baseline gap-2 h-4 leading-4">
                        <span className="block text-xs font-semibold text-content-muted shrink-0">
                          生成组合长度:
                        </span>
                        {rulePreview.isBraceSyntax && (
                          <span className="text-[11px] text-content-muted/70 truncate">
                            花括号规则由标签数量决定长度，此项不生效
                          </span>
                        )}
                      </div>
                      <CustomSelect
                        value={String(batchLength)}
                        onChange={(v) => setBatchLength(Number(v))}
                        disabled={rulePreview.isBraceSyntax}
                        bare
                        ariaLabel="生成组合长度"
                        title={
                          rulePreview.isBraceSyntax
                            ? "花括号规则由标签数量决定长度，此项不生效"
                            : undefined
                        }
                        options={[
                          { value: "2", label: "2位长度 (如 aa / ba / 88)" },
                          { value: "3", label: "3位长度 (如 aaa / 123 / abc)" },
                          { value: "4", label: "4位长度 (如 8888 / baba)" },
                        ]}
                        className="bg-elevated border border-border-base rounded-xl px-4 py-2.5 text-content-primary text-xs focus:border-accent focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* 3. 快捷标签按钮组 —— 点击插入 {标签} 占位符，可与字面量混排 */}
                  <div className="space-y-2">
                    <span className="block text-xs font-semibold text-content-muted">
                      支持标签 (点击追加到规则框，可任意组合，也可与固定字符混排如 my
                      <span className="text-accent">{"{字母}"}</span>):
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {BUILTIN_TOKENS.map((tag) => (
                        <button
                          key={tag}
                          onClick={() => setBatchRules(prev => `${prev}{${tag}}`)}
                          className="bg-elevated hover:bg-accent-soft text-content-secondary hover:text-accent border border-border-base hover:border-accent/40 text-xs px-3 py-1.5 rounded-lg transition-all"
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 3.5 词库分类（点击追加到规则框；支持增删改） */}
                  <div className="space-y-3 border-t border-border-base pt-5">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <span className="block text-xs font-semibold text-content-muted">
                        词库 (点击插入 <span className="text-accent">{"{词库名}"}</span> 标签，可与其它标签组合；中文将自动转 Punycode 提交):
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={openCreateBank}
                          className="text-xs font-semibold text-accent border border-accent/30 bg-accent-soft px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 hover:opacity-90"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          新建词库
                        </button>
                        <button
                          onClick={handleResetBanks}
                          className="text-xs font-semibold text-content-muted hover:text-content-primary border border-border-base hover:border-content-muted bg-elevated hover:bg-hovered px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          恢复默认
                        </button>
                      </div>
                    </div>

                    {/* 按分组类型分栏渲染 */}
                    {(Object.keys(BANK_KIND_META) as BankKind[]).map((kind) => {
                      const banks = wordBanks.filter((b) => b.kind === kind);
                      const meta = BANK_KIND_META[kind];
                      return (
                        <div key={kind} className="space-y-1.5">
                          <span className={`text-[11px] font-semibold ${meta.titleClass}`}>
                            {meta.label}
                            <span className="text-content-muted font-normal ml-1">({banks.length})</span>
                          </span>
                          {banks.length === 0 ? (
                            <div className="text-[11px] text-content-muted italic">
                              该分类下暂无词库，可点击右上「新建词库」添加
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {banks.map((bank) => (
                                <div
                                  key={bank.id}
                                  className={`group flex items-center bg-elevated border border-border-base ${meta.hoverBorderClass} rounded-lg overflow-hidden transition-all`}
                                >
                                  {/* 主体：点击追加到规则框 */}
                                  <button
                                    onClick={() => appendWordbank(bank.words, bank.name)}
                                    className={`text-content-secondary ${meta.hoverTextClass} text-xs px-3 py-2.5 md:py-1.5 transition-all`}
                                    title={`点击追加 ${bank.words.length} 个词到规则框`}
                                  >
                                    {bank.name}
                                    <span className="ml-1 text-[10px] text-content-muted">
                                      {bank.words.length}
                                    </span>
                                  </button>
                                  {/* 编辑 / 删除 */}
                                  <button
                                    onClick={() => openEditBank(bank)}
                                    className="px-2.5 py-2.5 md:px-1.5 md:py-1.5 text-content-muted hover:text-accent hover:bg-hovered transition-all border-l border-border-base"
                                    title="编辑该词库"
                                  >
                                    <Pencil className="w-3.5 h-3.5 md:w-3 md:h-3" />
                                  </button>
                                  <button
                                    onClick={() => handleDeleteBank(bank)}
                                    className="px-2.5 py-2.5 md:px-1.5 md:py-1.5 text-content-muted hover:text-red-400 hover:bg-hovered transition-all border-l border-border-base"
                                    title="删除该词库"
                                  >
                                    <Trash2 className="w-3.5 h-3.5 md:w-3 md:h-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* 3.55 官方保留前缀排除名单 */}
                  <div className="space-y-3 border-t border-border-base pt-5">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <label htmlFor="registerpage-fld4" className="flex items-center gap-2 cursor-pointer">
                        <input id="registerpage-fld4"
                          type="checkbox"
                          checked={enableReservedFilter}
                          onChange={(e) => toggleReservedFilter(e.target.checked)}
                          className="w-4 h-4 accent-red-500"
                        />
                        <span className="text-xs font-semibold text-content-secondary">
                          启用官方保留前缀排除
                          <span className="text-content-muted font-normal ml-1">
                            (整词匹配，如 ai 被排除但 ailu 仍会查询)
                          </span>
                        </span>
                      </label>
                      <button
                        onClick={handleResetReserved}
                        className="text-xs font-semibold text-content-muted hover:text-content-primary border border-border-base hover:border-content-muted bg-elevated hover:bg-hovered px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 shrink-0"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        恢复默认
                      </button>
                    </div>

                    {enableReservedFilter && (
                      <div className="space-y-2.5 pl-6">
                        {/* 已有名单标签 */}
                        <div className="flex flex-wrap gap-2">
                          {reservedPrefixes.length === 0 ? (
                            <span className="text-[11px] text-content-muted italic">
                              名单为空，当前不会排除任何前缀
                            </span>
                          ) : (
                            reservedPrefixes.map((p) => (
                              <span
                                key={p}
                                className="group flex items-center bg-red-50 border border-red-200 text-red-700 dark:bg-red-950/30 dark:border-red-500/30 dark:text-red-300 text-xs rounded-lg overflow-hidden"
                              >
                                <span className="px-2.5 py-1 font-mono">{p}</span>
                                <button
                                  onClick={() => handleRemoveReserved(p)}
                                  className="px-1.5 py-1 text-red-500/70 hover:text-red-800 hover:bg-red-100 border-l border-red-200 dark:text-red-400/60 dark:hover:text-red-300 dark:hover:bg-red-900/40 dark:border-red-500/30 transition-all"
                                  title={`从名单移除 ${p}`}
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </span>
                            ))
                          )}
                        </div>

                        {/* 添加输入框 */}
                        <form onSubmit={handleAddReserved} className="flex items-center gap-2">
                          <input
                            type="text"
                            value={newReservedInput}
                            onChange={(e) => setNewReservedInput(e.target.value)}
                            placeholder="添加保留前缀，可一次粘贴多个（逗号/空格分隔）"
                            className="flex-1 bg-elevated border border-border-base rounded-xl px-3 py-2 text-content-primary text-xs focus:border-red-500/60 focus:outline-none"
                          />
                          <button
                            type="submit"
                            disabled={!newReservedInput.trim()}
                            className="bg-elevated hover:bg-hovered text-content-secondary hover:text-content-primary border border-border-base text-xs font-semibold px-3 py-2 rounded-xl transition-all flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            添加
                          </button>
                        </form>
                      </div>
                    )}
                  </div>

                  {/* 3.6 顺序检测模式（进位递增 + 断点续查） */}
                  <div className="space-y-3 border-t border-border-base pt-5">
                    <label htmlFor="registerpage-fld5" className="flex items-center gap-2 cursor-pointer">
                      <input id="registerpage-fld5"
                        type="checkbox"
                        checked={seqMode}
                        onChange={(e) => setSeqMode(e.target.checked)}
                        className="w-4 h-4 accent-[var(--accent)]"
                      />
                      <span className="text-xs font-semibold text-content-secondary">
                        启用顺序检测模式（按字符集进位递增，如 aaa → aab → aac…，开启后忽略上方规则框）
                      </span>
                    </label>

                    {seqMode && (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pl-6">
                        <div className="space-y-1.5">
                          <span className="block text-[11px] font-semibold text-content-muted">字符集:</span>
                          <CustomSelect
                            value={seqCharset}
                            onChange={(v) => setSeqCharset(v as typeof seqCharset)}
                            bare
                            ariaLabel="字符集"
                            options={[
                              { value: "字母", label: "纯字母 (a-z)" },
                              { value: "数字", label: "纯数字 (0-9)" },
                              { value: "字母数字", label: "字母+数字 (a-z0-9)" },
                            ]}
                            className="bg-elevated border border-border-base rounded-xl px-3 py-2 text-content-primary text-xs focus:border-accent focus:outline-none"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <span className="block text-[11px] font-semibold text-content-muted">长度:</span>
                          <CustomSelect
                            value={String(seqLength)}
                            onChange={(v) => setSeqLength(Number(v))}
                            bare
                            ariaLabel="长度"
                            options={[
                              { value: "2", label: "2 位" },
                              { value: "3", label: "3 位" },
                              { value: "4", label: "4 位" },
                            ]}
                            className="bg-elevated border border-border-base rounded-xl px-3 py-2 text-content-primary text-xs focus:border-accent focus:outline-none"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label htmlFor="registerpage-fld6" className="block text-[11px] font-semibold text-content-muted">起始串 (可选):</label>
                          <input id="registerpage-fld6"
                            type="text"
                            value={seqStart}
                            onChange={(e) => setSeqStart(e.target.value)}
                            placeholder="如 qwe，留空从头开始"
                            className="w-full bg-elevated border border-border-base rounded-xl px-3 py-2 text-content-primary text-xs focus:border-accent focus:outline-none"
                          />
                        </div>
                      </div>
                    )}

                    {/* 查重池开关 */}
                    <label htmlFor="registerpage-fld7" className="flex items-center gap-2 cursor-pointer">
                      <input id="registerpage-fld7"
                        type="checkbox"
                        checked={ignorePool}
                        onChange={(e) => setIgnorePool(e.target.checked)}
                        className="w-4 h-4 accent-amber-500"
                      />
                      <span className="text-xs font-semibold text-content-secondary">
                        忽略查重池，强制全部重查
                        <span className="text-content-muted font-normal ml-1">
                          （默认会跳过池中 7 天内已确认「已注册」的域名以节省 API 配额；勾选此项可刷新过期结论）
                        </span>
                      </span>
                    </label>

                    {/* 断点续查提示条 */}
                    {scanCursor && scanStatus !== "running" && (
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-amber-50 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-500/30 rounded-xl px-4 py-3">
                        <div className="text-xs text-amber-800 dark:text-amber-300">
                          🔖 检测到上次未完成的扫描断点：
                          <span className="font-mono font-bold mx-1">{scanCursor.lastCandidate || "起点"}</span>
                          （已查 {scanCursor.checked} 个 · 保存于 {scanCursor.savedAt}）
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => handleStartBatchScan(scanCursor.lastCandidate)}
                            className="bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-all"
                          >
                            从断点继续
                          </button>
                          <button
                            onClick={clearScanCursor}
                            className="text-xs text-content-muted hover:text-content-primary px-2 py-1.5"
                          >
                            清除断点
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 4. 根域名后缀多选组 (支持添加自定义根域名) */}
                  <div className="space-y-3 border-t border-border-base pt-5">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-content-secondary">
                        选择欲检测的 DNSHE 官方及自定义根域名后缀:
                      </span>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setSelectedRoots([...allRootDomains])}
                          className="text-xs text-accent hover:underline"
                        >
                          全选 ({allRootDomains.length})
                        </button>
                        <span className="text-content-muted">|</span>
                        <button
                          onClick={() => setSelectedRoots([])}
                          className="text-xs text-content-muted hover:underline"
                        >
                          反选
                        </button>
                      </div>
                    </div>

                    {/* 根域名复选框网格 */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2">
                      {allRootDomains.map((root) => {
                        const isChecked = selectedRoots.includes(root);
                        const isDefault = DEFAULT_ROOT_DOMAINS.includes(root);
                        return (
                          <div
                            key={root}
                            className={`group relative flex items-center justify-between p-2.5 md:p-2 rounded-lg border text-xs font-mono transition-all ${
                              isChecked
                                ? "bg-accent-soft border-accent/40 text-accent"
                                : "bg-elevated border-border-base text-content-muted hover:text-content-primary"
                            }`}
                          >
                            <label className="flex items-center gap-2 cursor-pointer w-full overflow-hidden">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSelectedRoots(prev => Array.from(new Set([...prev, root])));
                                  } else {
                                    setSelectedRoots(prev => prev.filter(r => r !== root));
                                  }
                                }}
                                className="rounded border-border-base text-accent accent-[var(--accent)] focus:ring-0"
                              />
                              <span className="truncate">.{root}</span>
                            </label>

                            {!isDefault && (
                              <button
                                type="button"
                                title="删除该自定义根域名"
                                onClick={() => handleRemoveCustomRootDomain(root)}
                                /*
                                  NOTE: 原本是 opacity-0 group-hover:opacity-100 —— 触屏没有
                                  hover，这个按钮在手机上永远显不出来也点不到。窄屏改为常显，
                                  ≥md 才保留"悬停才出现"的桌面观感。
                                */
                                className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-content-muted hover:text-red-400 p-1.5 md:p-0.5 ml-1 transition-opacity"
                              >
                                <X className="w-3.5 h-3.5 md:w-3 md:h-3" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* 添加自定义根域名输入栏 */}
                    <form onSubmit={handleAddCustomRootDomain} className="flex items-center gap-2 pt-1 max-w-sm">
                      <input
                        type="text"
                        placeholder="添加新根域名(如 sample.cd)"
                        value={newRootInput}
                        onChange={(e) => setNewRootInput(e.target.value)}
                        className="bg-elevated border border-border-base focus:border-accent rounded-lg px-3 py-1.5 text-xs text-content-primary focus:outline-none flex-1 font-mono"
                      />
                      <button
                        type="submit"
                        disabled={!newRootInput.trim()}
                        className="bg-elevated hover:bg-hovered text-accent hover:opacity-80 border border-border-base text-xs px-3 py-1.5 rounded-lg transition-all flex items-center gap-1 disabled:opacity-40"
                      >
                        <Plus className="w-3.5 h-3.5" /> 添加根域
                      </button>
                    </form>
                  </div>

                  {/* 5. 主控制按钮条 */}
                  <div className="flex flex-wrap items-center gap-3 border-t border-border-base pt-5">
                    <button
                      onClick={() => handleStartBatchScan()}
                      disabled={scanStatus === "running"}
                      className="bg-accent-gradient hover:opacity-95 text-accent-contrast font-bold text-sm px-6 py-3 rounded-xl transition-all shadow-lg shadow-accent flex items-center gap-2 disabled:opacity-50"
                    >
                      <Play className={`w-4 h-4 ${scanStatus === "running" ? "animate-spin" : ""}`} />
                      {scanStatus === "running" ? "正在查重中..." : scanStatus === "paused" ? "恢复查询" : "开始生成查询"}
                    </button>

                    <button
                      onClick={pauseScan}
                      disabled={scanStatus !== "running"}
                      className="bg-elevated hover:bg-hovered text-content-secondary font-semibold text-sm px-5 py-3 rounded-xl transition-all disabled:opacity-50"
                    >
                      暂停查询
                    </button>

                    <button
                      onClick={resetScan}
                      className="bg-elevated hover:bg-hovered text-content-secondary font-semibold text-sm px-5 py-3 rounded-xl transition-all"
                    >
                      重新开始
                    </button>

                    <button
                      onClick={handleExportAvailableTxt}
                      disabled={availableDomainsList.length === 0}
                      className="bg-emerald-700 hover:bg-emerald-600 text-white font-semibold text-sm px-5 py-3 rounded-xl transition-all flex items-center gap-2 ml-auto disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Download className="w-4 h-4" />
                      导出 txt 字典文件 ({availableDomainsList.length})
                    </button>
                  </div>
                </div>

                {/* 扫描进度与发现结果列表 */}
                {scanProgress.total > 0 && (
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
                )}

              </div>
            )}
          </div>
  );
}
