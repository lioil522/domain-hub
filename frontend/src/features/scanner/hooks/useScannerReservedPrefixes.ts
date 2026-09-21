import { useCallback, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { parseWords } from "../../../wordbanks";
import { DEFAULT_RESERVED_PREFIXES } from "../utils/scanner-constants";
import { saveReservedFilterEnabled, saveReservedPrefixes } from "../utils/scanner-storage";

type Toast = (kind: "success" | "error" | "info" | "warning", message: string) => void;

type Options = {
  reservedPrefixes: string[];
  setReservedPrefixes: Dispatch<SetStateAction<string[]>>;
  setEnableReservedFilter: Dispatch<SetStateAction<boolean>>;
  newReservedInput: string;
  setNewReservedInput: Dispatch<SetStateAction<string>>;
  showToast: Toast;
};


export function useScannerReservedPrefixes({
  reservedPrefixes, setReservedPrefixes, setEnableReservedFilter,
  newReservedInput, setNewReservedInput, showToast
}: Options) {
  const persistReserved = useCallback((next: string[]) => {
    setReservedPrefixes(next);
    saveReservedPrefixes(next);
  }, [setReservedPrefixes]);

  const handleAddReserved = useCallback((e?: FormEvent) => {
    if (e) e.preventDefault();
    const incoming = parseWords(newReservedInput).map(w => w.toLowerCase());
    if (incoming.length === 0) return;
    const merged = Array.from(new Set([...reservedPrefixes, ...incoming]));
    const added = merged.length - reservedPrefixes.length;
    persistReserved(merged);
    setNewReservedInput("");
    if (added > 0) {
      showToast("success", `已添加 ${added} 个保留前缀`);
    } else {
      showToast("info", "输入的前缀均已在名单中");
    }
  }, [newReservedInput, persistReserved, reservedPrefixes, setNewReservedInput, showToast]);

  const handleRemoveReserved = useCallback((prefix: string) => {
    persistReserved(reservedPrefixes.filter(p => p !== prefix));
    showToast("info", `已从名单移除 [${prefix}]`);
  }, [persistReserved, reservedPrefixes, showToast]);

  const handleResetReserved = useCallback(() => {
    persistReserved(DEFAULT_RESERVED_PREFIXES);
    showToast("success", "已恢复官方默认保留前缀名单");
  }, [persistReserved, showToast]);

  const toggleReservedFilter = useCallback((enabled: boolean) => {
    setEnableReservedFilter(enabled);
    saveReservedFilterEnabled(enabled);
  }, [setEnableReservedFilter]);

  return { handleAddReserved, handleRemoveReserved, handleResetReserved, toggleReservedFilter };
}

export { DEFAULT_RESERVED_PREFIXES };
