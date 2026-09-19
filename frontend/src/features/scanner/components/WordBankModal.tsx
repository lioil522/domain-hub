/**
 * WordBankModal —— 「词库」新建 / 编辑弹窗。
 *
 * 由 App.tsx 纯搬运抽出（Phase 9）。DOM / className / 文案逐字未改。
 */
import { ModalOverlay } from "../../../components/ModalOverlay";
import { Textarea } from "../../../components/form/Textarea";
import { Input } from "../../../components/form/Input";
import { Plus, X, Save, Pencil } from "lucide-react";
import { parseWords, BANK_KIND_META, type BankKind, type WordBank } from "../../../wordbanks";
import { CustomSelect } from "../../../components/form/CustomSelect";

interface WordBankModalProps {
  open: boolean;
  editingBank: WordBank | null;
  formKind: BankKind;
  formName: string;
  formWords: string;
  onClose: () => void;
  onKindChange: (kind: BankKind) => void;
  onNameChange: (name: string) => void;
  onWordsChange: (words: string) => void;
  onSave: () => void;
}

export function WordBankModal({
  open,
  editingBank,
  formKind,
  formName,
  formWords,
  onClose,
  onKindChange,
  onNameChange,
  onWordsChange,
  onSave,
}: WordBankModalProps) {
  if (!open) return null;

  return (
    <ModalOverlay>
      <div role="dialog" aria-labelledby="word-bank-modal-title" className="bg-surface border border-border-base w-full max-w-lg max-h-[90dvh] rounded-xl overflow-hidden flex flex-col shadow-2xl">
        <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between border-b border-border-base flex-shrink-0">
          <h3 id="word-bank-modal-title" className="text-lg font-bold text-content-primary flex items-center gap-1.5">
            {editingBank ? (
              <>
                <Pencil className="w-5 h-5 text-accent" /> 编辑词库
              </>
            ) : (
              <>
                <Plus className="w-5 h-5 text-accent" /> 新建词库
              </>
            )}
          </h3>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
          <div>
            <span className="block text-xs font-semibold text-content-muted mb-1.5">
              词库类型
            </span>
            <CustomSelect
              value={formKind}
              onChange={(v) => onKindChange(v as BankKind)}
              ariaLabel="词库类型"
              options={(Object.keys(BANK_KIND_META) as BankKind[]).map((k) => ({
                value: k,
                label: BANK_KIND_META[k].label,
              }))}
              className="px-3 py-2.5 rounded-lg text-sm text-content-secondary"
            />
          </div>

          <div>
            <label htmlFor="wordbankmodal-fld1" className="block text-xs font-semibold text-content-muted mb-1.5">
              词库名称
            </label>
            <Input id="wordbankmodal-fld1"
              type="text"
              placeholder="如：热门城市 / 5字母单词 / 我的收藏"
              value={formName}
              onChange={(e) => onNameChange(e.target.value)}
              className="w-full text-content-secondary"
            />
          </div>

          <div>
            <label htmlFor="wordbankmodal-fld2" className="block text-xs font-semibold text-content-muted mb-1.5">
              词条内容
              <span className="font-normal ml-1">
                (用逗号、空格或换行分隔，保存时自动去重)
              </span>
            </label>
            <Textarea id="wordbankmodal-fld2" mono resizable
              rows={8}
              placeholder={"如：\n北京, 上海, 广州\n或每行一个词"}
              value={formWords}
              onChange={(e) => onWordsChange(e.target.value)}
              className="w-full text-content-secondary"
            />
            <p className="text-[11px] text-content-muted mt-1.5">
              当前解析出 <span className="text-accent font-bold">{parseWords(formWords).length}</span> 个词条
            </p>
          </div>
        </div>

        <div className="bg-elevated px-6 py-4 flex items-center justify-end gap-3 border-t border-border-base">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-semibold text-content-secondary hover:text-content-primary bg-surface hover:bg-hovered border border-border-base rounded-lg transition-all"
          >
            取消
          </button>
          <button
            onClick={onSave}
            className="px-5 py-2 text-sm font-bold bg-accent-gradient hover:opacity-95 text-accent-contrast rounded-lg transition-all shadow-lg shadow-accent flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            {editingBank ? "保存修改" : "创建词库"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
