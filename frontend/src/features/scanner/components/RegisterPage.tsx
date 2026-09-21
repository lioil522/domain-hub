import type { UseScannerReturn } from "../hooks/useScanner";
import { createScannerBatchViewModel, createScannerPageViewModel } from "../utils/scanner-view-model";
import type { Account } from "../../../types/account";
import { ScannerModeTabs } from "./ScannerModeTabs";
import { SingleDomainPanel } from "./SingleDomainPanel";
import { BatchScannerConfig } from "./BatchScannerConfig";
import { ScannerResultsPanel } from "./ScannerResultsPanel";

interface RegisterPageProps {
  scanner: UseScannerReturn;
  dnsheAccounts: Account[];
  actionLoading: string | null;
}

export function RegisterPage({ scanner, dnsheAccounts, actionLoading }: RegisterPageProps) {
  const page = createScannerPageViewModel(scanner);
  const batch = createScannerBatchViewModel(scanner);

  return (
    <div className="space-y-6 max-w-5xl mx-auto pt-5 md:pt-6">
      <ScannerModeTabs scanner={page.mode} />

      {page.mode.regMode === "single" && (
        <SingleDomainPanel scanner={page.single} dnsheAccounts={dnsheAccounts} actionLoading={actionLoading} />
      )}

      {page.mode.regMode === "batch" && (
        <div className="space-y-6">
          <BatchScannerConfig scanner={batch} dnsheAccounts={dnsheAccounts} />
          <ScannerResultsPanel scanner={page.results} />
        </div>
      )}
    </div>
  );
}
