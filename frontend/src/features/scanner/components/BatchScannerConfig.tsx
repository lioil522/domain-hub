import type { Account } from "../../../types/account";
import type { ScannerBatchViewModel } from "../utils/scanner-view-model";
import { BatchRuleEditor } from "./BatchRuleEditor";
import { WordBankPanel } from "./WordBankPanel";
import { ReservedPrefixPanel } from "./ReservedPrefixPanel";
import { SequentialScannerPanel } from "./SequentialScannerPanel";
import { BatchBasicOptions } from "./BatchBasicOptions";
import { RootDomainSelector } from "./RootDomainSelector";
import { ScannerControlBar } from "./ScannerControlBar";

interface BatchScannerConfigProps {
  scanner: ScannerBatchViewModel;
  dnsheAccounts: Account[];
}

export function BatchScannerConfig({ scanner, dnsheAccounts }: BatchScannerConfigProps) {
  const view = scanner;

  return (
    <div className="bg-surface border border-border-base rounded-2xl p-6 shadow-xl space-y-6">
      <BatchRuleEditor scanner={view.ruleEditor} dnsheAccounts={dnsheAccounts} />
      <WordBankPanel scanner={view.wordBanks} />
      <ReservedPrefixPanel scanner={view.reservedPrefixes} />
      <div className="space-y-3 border-t border-border-base pt-5">
        <SequentialScannerPanel scanner={view.sequential} />
        <BatchBasicOptions scanner={view.basicOptions} />
      </div>
      <RootDomainSelector scanner={view.rootDomains} />
      <ScannerControlBar scanner={view.controls} />
    </div>
  );
}
