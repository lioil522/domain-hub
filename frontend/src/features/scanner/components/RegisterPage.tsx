import type { UseScannerReturn } from "../hooks/useScanner";
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
  const { regMode } = scanner;

  return (
    <div className="space-y-6 max-w-5xl mx-auto pt-5 md:pt-6">
      <ScannerModeTabs scanner={scanner} />

      {regMode === "single" && (
        <SingleDomainPanel scanner={scanner} dnsheAccounts={dnsheAccounts} actionLoading={actionLoading} />
      )}

      {regMode === "batch" && (
        <div className="space-y-6">
          <BatchScannerConfig scanner={scanner} dnsheAccounts={dnsheAccounts} />
          <ScannerResultsPanel scanner={scanner} />
        </div>
      )}
    </div>
  );
}
