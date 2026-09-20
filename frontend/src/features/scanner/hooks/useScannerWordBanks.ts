import { useCallback, type Dispatch, type SetStateAction } from "react";
import {
  BANK_KIND_META,
  buildDefaultBanks,
  makeBankId,
  parseWords,
  saveWordBanks,
  type BankKind,
  type WordBank
} from "../../../wordbanks";
import { BUILTIN_TOKENS } from "../../../rulegen";

type Toast = (kind: "success" | "error" | "info" | "warning", message: string) => void;

type Options = {
  wordBanks: WordBank[];
  setWordBanks: Dispatch<SetStateAction<WordBank[]>>;
  bankFormName: string;
  bankFormKind: BankKind;
  bankFormWords: string;
  editingBank: WordBank | null;
  setBankModalOpen: Dispatch<SetStateAction<boolean>>;
  setEditingBank: Dispatch<SetStateAction<WordBank | null>>;
  setBankFormName: Dispatch<SetStateAction<string>>;
  setBankFormKind: Dispatch<SetStateAction<BankKind>>;
  setBankFormWords: Dispatch<SetStateAction<string>>;
  setBatchRules: Dispatch<SetStateAction<string>>;
  showToast: Toast;
};

export function useScannerWordBanks({
  wordBanks, setWordBanks, bankFormName, bankFormKind, bankFormWords, editingBank,
  setBankModalOpen, setEditingBank, setBankFormName, setBankFormKind, setBankFormWords,
  setBatchRules, showToast
}: Options) {
  const persistBanks = useCallback((next: WordBank[]) => {
    setWordBanks(next);
    saveWordBanks(next);
  }, [setWordBanks]);

  const openCreateBank = useCallback(() => {
    setEditingBank(null);
    setBankFormName("");
    setBankFormKind("cn");
    setBankFormWords("");
    setBankModalOpen(true);
  }, [setEditingBank, setBankFormName, setBankFormKind, setBankFormWords, setBankModalOpen]);

  const openEditBank = useCallback((bank: WordBank) => {
    setEditingBank(bank);
    setBankFormName(bank.name);
    setBankFormKind(bank.kind);
    setBankFormWords(bank.words.join(", "));
    setBankModalOpen(true);
  }, [setEditingBank, setBankFormName, setBankFormKind, setBankFormWords, setBankModalOpen]);

  const handleSaveBank = useCallback(() => {
    const name = bankFormName.trim();
    if (!name) return showToast("error", "请填写词库名称！");
    if (/[{},]/.test(name)) return showToast("error", "词库名称不能包含 { } 或逗号，否则无法作为规则标签使用！");
    if ((BUILTIN_TOKENS as readonly string[]).includes(name)) return showToast("error", `[${name}] 与内置标签同名，请换一个词库名称！`);
    const words = parseWords(bankFormWords);
    if (words.length === 0) return showToast("error", "请至少填写一个词条！");

    const dup = wordBanks.some(b => b.kind === bankFormKind && b.name === name && b.id !== editingBank?.id);
    if (dup) return showToast("error", `「${BANK_KIND_META[bankFormKind].label}」下已存在同名词库 [${name}]！`);

    if (editingBank) {
      persistBanks(wordBanks.map(b => b.id === editingBank.id ? { ...b, name, kind: bankFormKind, words } : b));
      showToast("success", `词库 [${name}] 已更新（${words.length} 个词）`);
    } else {
      persistBanks([...wordBanks, { id: makeBankId(), kind: bankFormKind, name, words }]);
      showToast("success", `已新建词库 [${name}]（${words.length} 个词）`);
    }
    setBankModalOpen(false);
  }, [bankFormName, bankFormKind, bankFormWords, editingBank, wordBanks, persistBanks, setBankModalOpen, showToast]);

  const handleDeleteBank = useCallback((bank: WordBank) => {
    if (!confirm(`确定要删除词库 [${bank.name}] 吗？该分组下 ${bank.words.length} 个词条将一并移除。`)) return;
    persistBanks(wordBanks.filter(b => b.id !== bank.id));
    showToast("info", `已删除词库 [${bank.name}]`);
  }, [persistBanks, wordBanks, showToast]);

  const handleResetBanks = useCallback(() => {
    if (!confirm("确定要恢复内置默认词库吗？您当前所有的自定义词库分组与修改都将被覆盖！")) return;
    const defaults = buildDefaultBanks();
    persistBanks(defaults);
    showToast("success", `已恢复内置默认词库（${defaults.length} 个分组）`);
  }, [persistBanks, showToast]);

  const appendWordbank = useCallback((words: string[], label: string) => {
    setBatchRules(prev => `${prev}{${label}}`);
    showToast("success", `已插入「${label}」词库标签（${words.length} 个词）`);
  }, [setBatchRules, showToast]);

  return { openCreateBank, openEditBank, handleSaveBank, handleDeleteBank, handleResetBanks, appendWordbank };
}
