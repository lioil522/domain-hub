import { useCallback, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { toASCII } from "../../../punycode";
import { saveCustomRootDomains } from "../utils/scanner-storage";

type Toast = (kind: "success" | "error" | "info" | "warning", message: string) => void;

type Options = {
  allRootDomains: string[];
  setAllRootDomains: Dispatch<SetStateAction<string[]>>;
  newRootInput: string;
  setNewRootInput: Dispatch<SetStateAction<string>>;
  setSelectedRoots: Dispatch<SetStateAction<string[]>>;
  showToast: Toast;
};

export function useScannerRootDomains({
  allRootDomains, setAllRootDomains, newRootInput, setNewRootInput, setSelectedRoots, showToast
}: Options) {
  const handleAddCustomRootDomain = useCallback((e?: FormEvent) => {
    if (e) e.preventDefault();
    const cleanRoot = toASCII(newRootInput.trim().replace(/^\./, ""));
    if (!cleanRoot) return;
    if (allRootDomains.includes(cleanRoot)) {
      showToast("error", `根域名 [.${cleanRoot}] 已在列表中！`);
      return;
    }
    const updated = [...allRootDomains, cleanRoot];
    setAllRootDomains(updated);
    setSelectedRoots(prev => Array.from(new Set([...prev, cleanRoot])));
    saveCustomRootDomains(updated);
    setNewRootInput("");
    showToast("success", `成功追加根域名 [.${cleanRoot}]！`);
  }, [allRootDomains, newRootInput, setAllRootDomains, setNewRootInput, setSelectedRoots, showToast]);

  const handleRemoveCustomRootDomain = useCallback((rootToRemove: string) => {
    const updated = allRootDomains.filter(r => r !== rootToRemove);
    setAllRootDomains(updated);
    setSelectedRoots(prev => prev.filter(r => r !== rootToRemove));
    saveCustomRootDomains(updated);
    showToast("info", `已移除根域名 [.${rootToRemove}]`);
  }, [allRootDomains, setAllRootDomains, setSelectedRoots, showToast]);

  return { handleAddCustomRootDomain, handleRemoveCustomRootDomain };
}
