import type { UseScannerReturn } from "../hooks/useScanner";

type ScannerKeys<T extends keyof UseScannerReturn> = Pick<UseScannerReturn, T>;

export type BatchRuleEditorModel = ScannerKeys<
  | "MAX_PREFIXES"
  | "batchRules"
  | "setBatchRules"
  | "excludeChars"
  | "setExcludeChars"
  | "selectedRoots"
  | "batchLength"
  | "setBatchLength"
  | "rulePreview"
  | "formatDuration"
  | "showToast"
>;

export type WordBankModel = ScannerKeys<
  | "wordBanks"
  | "openCreateBank"
  | "openEditBank"
  | "handleDeleteBank"
  | "handleResetBanks"
  | "appendWordbank"
>;

export type ReservedPrefixModel = ScannerKeys<
  | "reservedPrefixes"
  | "enableReservedFilter"
  | "newReservedInput"
  | "setNewReservedInput"
  | "handleAddReserved"
  | "handleRemoveReserved"
  | "handleResetReserved"
  | "toggleReservedFilter"
>;

export type SequentialScannerModel = ScannerKeys<
  | "seqMode"
  | "setSeqMode"
  | "seqCharset"
  | "setSeqCharset"
  | "seqLength"
  | "setSeqLength"
  | "seqStart"
  | "setSeqStart"
>;

export type BatchBasicOptionsModel = ScannerKeys<
  | "ignorePool"
  | "setIgnorePool"
  | "scanCursor"
  | "scanStatus"
  | "handleStartBatchScan"
  | "clearScanCursor"
>;

export type RootDomainSelectorModel = ScannerKeys<
  | "DEFAULT_ROOT_DOMAINS"
  | "allRootDomains"
  | "newRootInput"
  | "setNewRootInput"
  | "handleAddCustomRootDomain"
  | "handleRemoveCustomRootDomain"
  | "selectedRoots"
  | "setSelectedRoots"
>;

export type ScannerControlBarModel = ScannerKeys<
  | "scanStatus"
  | "availableDomainsList"
  | "handleStartBatchScan"
  | "pauseScan"
  | "resetScan"
  | "handleExportAvailableTxt"
>;

export interface ScannerBatchViewModel {
  ruleEditor: BatchRuleEditorModel;
  wordBanks: WordBankModel;
  reservedPrefixes: ReservedPrefixModel;
  sequential: SequentialScannerModel;
  basicOptions: BatchBasicOptionsModel;
  rootDomains: RootDomainSelectorModel;
  controls: ScannerControlBarModel;
}

export function createScannerBatchViewModel(scanner: UseScannerReturn): ScannerBatchViewModel {
  return {
    ruleEditor: {
      MAX_PREFIXES: scanner.MAX_PREFIXES,
      batchRules: scanner.batchRules,
      setBatchRules: scanner.setBatchRules,
      excludeChars: scanner.excludeChars,
      setExcludeChars: scanner.setExcludeChars,
      selectedRoots: scanner.selectedRoots,
      batchLength: scanner.batchLength,
      setBatchLength: scanner.setBatchLength,
      rulePreview: scanner.rulePreview,
      formatDuration: scanner.formatDuration,
      showToast: scanner.showToast,
    },
    wordBanks: {
      wordBanks: scanner.wordBanks,
      openCreateBank: scanner.openCreateBank,
      openEditBank: scanner.openEditBank,
      handleDeleteBank: scanner.handleDeleteBank,
      handleResetBanks: scanner.handleResetBanks,
      appendWordbank: scanner.appendWordbank,
    },
    reservedPrefixes: {
      reservedPrefixes: scanner.reservedPrefixes,
      enableReservedFilter: scanner.enableReservedFilter,
      newReservedInput: scanner.newReservedInput,
      setNewReservedInput: scanner.setNewReservedInput,
      handleAddReserved: scanner.handleAddReserved,
      handleRemoveReserved: scanner.handleRemoveReserved,
      handleResetReserved: scanner.handleResetReserved,
      toggleReservedFilter: scanner.toggleReservedFilter,
    },
    sequential: {
      seqMode: scanner.seqMode,
      setSeqMode: scanner.setSeqMode,
      seqCharset: scanner.seqCharset,
      setSeqCharset: scanner.setSeqCharset,
      seqLength: scanner.seqLength,
      setSeqLength: scanner.setSeqLength,
      seqStart: scanner.seqStart,
      setSeqStart: scanner.setSeqStart,
    },
    basicOptions: {
      ignorePool: scanner.ignorePool,
      setIgnorePool: scanner.setIgnorePool,
      scanCursor: scanner.scanCursor,
      scanStatus: scanner.scanStatus,
      handleStartBatchScan: scanner.handleStartBatchScan,
      clearScanCursor: scanner.clearScanCursor,
    },
    rootDomains: {
      DEFAULT_ROOT_DOMAINS: scanner.DEFAULT_ROOT_DOMAINS,
      allRootDomains: scanner.allRootDomains,
      newRootInput: scanner.newRootInput,
      setNewRootInput: scanner.setNewRootInput,
      handleAddCustomRootDomain: scanner.handleAddCustomRootDomain,
      handleRemoveCustomRootDomain: scanner.handleRemoveCustomRootDomain,
      selectedRoots: scanner.selectedRoots,
      setSelectedRoots: scanner.setSelectedRoots,
    },
    controls: {
      scanStatus: scanner.scanStatus,
      availableDomainsList: scanner.availableDomainsList,
      handleStartBatchScan: scanner.handleStartBatchScan,
      pauseScan: scanner.pauseScan,
      resetScan: scanner.resetScan,
      handleExportAvailableTxt: scanner.handleExportAvailableTxt,
    },
  };
}


export type ScannerMode = "single" | "batch";

export interface ScannerModeModel {
  regMode: ScannerMode;
  setRegMode: (mode: ScannerMode) => void;
}

export type SingleDomainModel = ScannerKeys<
  | "allRootDomains"
  | "searchSubdomain"
  | "setSearchSubdomain"
  | "searchRootdomain"
  | "setSearchRootdomain"
  | "whoisLoading"
  | "whoisResult"
  | "registerAccountId"
  | "setRegisterAccountId"
  | "handleCheckWhois"
  | "handleRegisterSubdomain"
>;

export type ScannerResultsModel = ScannerKeys<
  | "scanProgress"
  | "availableDomainsList"
  | "scanStatus"
  | "scanLogs"
  | "handleRegisterFromResult"
>;

export interface ScannerPageViewModel {
  mode: ScannerModeModel;
  single: SingleDomainModel;
  results: ScannerResultsModel;
}

export function createScannerPageViewModel(scanner: UseScannerReturn): ScannerPageViewModel {
  return {
    mode: {
      regMode: scanner.regMode,
      setRegMode: scanner.setRegMode,
    },
    single: {
      allRootDomains: scanner.allRootDomains,
      searchSubdomain: scanner.searchSubdomain,
      setSearchSubdomain: scanner.setSearchSubdomain,
      searchRootdomain: scanner.searchRootdomain,
      setSearchRootdomain: scanner.setSearchRootdomain,
      whoisLoading: scanner.whoisLoading,
      whoisResult: scanner.whoisResult,
      registerAccountId: scanner.registerAccountId,
      setRegisterAccountId: scanner.setRegisterAccountId,
      handleCheckWhois: scanner.handleCheckWhois,
      handleRegisterSubdomain: scanner.handleRegisterSubdomain,
    },
    results: {
      scanProgress: scanner.scanProgress,
      availableDomainsList: scanner.availableDomainsList,
      scanStatus: scanner.scanStatus,
      scanLogs: scanner.scanLogs,
      handleRegisterFromResult: scanner.handleRegisterFromResult,
    },
  };
}
