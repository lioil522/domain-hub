import { AlertTriangle, Info, Trash2 } from "lucide-react";
import { BUILTIN_TOKENS } from "../../../rulegen";
import { CustomSelect } from "../../../components/form/CustomSelect";
import type { Account } from "../../../types/account";
import type { BatchRuleEditorModel } from "../utils/scanner-view-model";

interface BatchRuleEditorProps {
  scanner: BatchRuleEditorModel;
  dnsheAccounts: Account[];
}

export function BatchRuleEditor({ scanner, dnsheAccounts }: BatchRuleEditorProps) {
  const {
    MAX_PREFIXES,
    batchRules, setBatchRules,
    excludeChars, setExcludeChars,
    selectedRoots,
    batchLength, setBatchLength,
    rulePreview,
    formatDuration,
    showToast,
  } = scanner;

  return (
    <div className="space-y-6">
    <>
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
    </>
    </div>
  );
}
