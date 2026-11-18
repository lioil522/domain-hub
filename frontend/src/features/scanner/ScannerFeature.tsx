import { useEffect } from "react";
import { useScanner, type UseScannerOptions } from "./hooks/useScanner";
import { RegisterPage } from "./components/RegisterPage";
import { lazyModal } from "../../lib/lazy-modal";

export interface ScannerFeatureProps extends UseScannerOptions {
  active: boolean;
  onRootDomainsChange: (roots: string[]) => void;
}

const WordBankModal = lazyModal(() => import("./components/WordBankModal"), "WordBankModal",
  "词库", p => p.open, p => p.onClose);

/** Hook and word lists enter the graph together, only on the first Scanner visit. */
export function ScannerFeature(props: ScannerFeatureProps) {
  const scanner = useScanner(props);
  useEffect(() => {
    props.onRootDomainsChange(scanner.allRootDomains);
  }, [scanner.allRootDomains, props.onRootDomainsChange]);

  // Keep the hook/task alive while navigating, but don't render hidden lists or portals.
  if (!props.active) return null;
  return (
    <>
      <RegisterPage scanner={scanner} dnsheAccounts={props.dnsheAccounts} actionLoading={props.actionLoading} />
      <WordBankModal
        open={scanner.bankModalOpen}
        editingBank={scanner.editingBank}
        formKind={scanner.bankFormKind}
        formName={scanner.bankFormName}
        formWords={scanner.bankFormWords}
        onClose={() => scanner.setBankModalOpen(false)}
        onKindChange={scanner.setBankFormKind}
        onNameChange={scanner.setBankFormName}
        onWordsChange={scanner.setBankFormWords}
        onSave={scanner.handleSaveBank}
      />
    </>
  );
}
