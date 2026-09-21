import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { BANK_KIND_META, type BankKind } from "../../../wordbanks";
import type { WordBankModel } from "../utils/scanner-view-model";

interface WordBankPanelProps {
  scanner: WordBankModel;
}

export function WordBankPanel({ scanner }: WordBankPanelProps) {
  const {
    wordBanks,
    openCreateBank,
    openEditBank,
    handleDeleteBank,
    handleResetBanks,
    appendWordbank,
  } = scanner;

  return (
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
  );
}
