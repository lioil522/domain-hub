/**
 * useScanner —— Scanner 页面总编排层。
 *
 * Phase 3-E：把扫描执行、WHOIS/注册、根域名与保留前缀动作继续下沉到职责明确的 hooks。
 * 本文件只负责组合状态、派生数据和各能力模块，并保持原有返回 API 不变。
 */
import { useMemo } from "react";
import { useAppData } from "../../../state/AppDataContext";
import type { Account } from "../../../types/account";
import { useScannerState } from "./useScannerState";
import { useScannerWordBanks } from "./useScannerWordBanks";
import { useScannerRootDomains } from "./useScannerRootDomains";
import { useScannerWhois } from "./useScannerWhois";
import { useScannerReservedPrefixes } from "./useScannerReservedPrefixes";
import { useScannerBatchScan } from "./useScannerBatchScan";
import { MAX_PREFIXES } from "../utils/scanner-constants";
import { parseRule, countCombos } from "../../../rulegen";

export interface UseScannerOptions {
  fetchDomains: () => void;
  setActiveTab: (tab: "domains") => void;
  dnsheAccounts: Account[];
  actionLoading: string | null;
  setActionLoading: (v: string | null) => void;
}

export function useScanner({
  fetchDomains, setActiveTab, dnsheAccounts, actionLoading, setActionLoading
}: UseScannerOptions) {
  const { apiFetch, showToast } = useAppData();
  const state = useScannerState();

  const {
    DEFAULT_ROOT_DOMAINS, DEFAULT_RESERVED_PREFIXES,
    allRootDomains, setAllRootDomains, newRootInput, setNewRootInput,
    searchSubdomain, setSearchSubdomain, searchRootdomain, setSearchRootdomain,
    whoisLoading, setWhoisLoading, whoisResult, setWhoisResult, registerAccountId, setRegisterAccountId,
    regMode, setRegMode, batchRules, setBatchRules, excludeChars, setExcludeChars,
    selectedRoots, setSelectedRoots, batchLength, setBatchLength,
    scanStatus, setScanStatus, scanControlRef, scanProgress, setScanProgress,
    availableDomainsList, setAvailableDomainsList, scanLogs, setScanLogs,
    seqMode, setSeqMode, seqCharset, setSeqCharset, seqLength, setSeqLength, seqStart, setSeqStart,
    scanCursor, setScanCursor, scanCursorRef, ignorePool, setIgnorePool,
    reservedPrefixes, setReservedPrefixes, enableReservedFilter, setEnableReservedFilter, newReservedInput, setNewReservedInput,
    wordBanks, setWordBanks, bankModalOpen, setBankModalOpen, editingBank,
    setEditingBank, bankFormName, setBankFormName, bankFormKind, setBankFormKind, bankFormWords, setBankFormWords
  } = state;

  const { handleAddCustomRootDomain, handleRemoveCustomRootDomain } = useScannerRootDomains({
    allRootDomains,
    setAllRootDomains,
    newRootInput,
    setNewRootInput,
    setSelectedRoots,
    showToast
  });

  const {
    handleAddReserved,
    handleRemoveReserved,
    handleResetReserved,
    toggleReservedFilter
  } = useScannerReservedPrefixes({
    reservedPrefixes,
    setReservedPrefixes,
    setEnableReservedFilter,
    newReservedInput,
    setNewReservedInput,
    showToast
  });

  const {
    openCreateBank,
    openEditBank,
    handleSaveBank,
    handleDeleteBank,
    handleResetBanks,
    appendWordbank
  } = useScannerWordBanks({
    wordBanks,
    setWordBanks,
    bankFormName,
    bankFormKind,
    bankFormWords,
    editingBank,
    setBankModalOpen,
    setEditingBank,
    setBankFormName,
    setBankFormKind,
    setBankFormWords,
    setBatchRules,
    showToast
  });

  const resolveBank = useMemo(
    () => (name: string): string[] | null => {
      const bank = wordBanks.find(b => b.name === name);
      return bank ? bank.words : null;
    },
    [wordBanks]
  );

  const rulePreview = useMemo(() => {
    const parsed = parseRule(batchRules, excludeChars, batchLength, resolveBank);
    const total = countCombos(parsed);
    const rootCount = Math.max(selectedRoots.length, 1);
    const workerCount = Math.max(dnsheAccounts.length, 1);
    const scanned = Math.min(total, MAX_PREFIXES) * rootCount;
    const emptiedByExclude =
      total === 0 &&
      parsed.unknownTokens.length === 0 &&
      (parsed.slots.length > 0 || parsed.literalList !== null) &&
      excludeChars.trim().length > 0;
    return {
      parsed,
      total,
      emptiedByExclude,
      isBraceSyntax: batchRules.includes("{"),
      estSeconds: (scanned * 1.2) / workerCount
    };
  }, [batchRules, excludeChars, batchLength, resolveBank, selectedRoots.length, dnsheAccounts.length]);

  const formatDuration = (sec: number): string => {
    if (sec < 60) return `${Math.ceil(sec)} 秒`;
    if (sec < 3600) return `${(sec / 60).toFixed(1)} 分钟`;
    if (sec < 86400) return `${(sec / 3600).toFixed(1)} 小时`;
    return `${(sec / 86400).toFixed(1)} 天`;
  };

  const {
    handleCheckWhois,
    handleRegisterSubdomain,
    handleRegisterFromResult,
    registerLoading
  } = useScannerWhois({
    apiFetch,
    showToast,
    dnsheAccounts,
    fetchDomains,
    setActiveTab,
    actionLoading,
    setActionLoading,
    searchSubdomain,
    setSearchSubdomain,
    searchRootdomain,
    setSearchRootdomain,
    whoisLoading,
    setWhoisLoading,
    whoisResult,
    setWhoisResult,
    registerAccountId,
    setRegisterAccountId,
    setRegMode,
    reservedPrefixes,
    enableReservedFilter
  });

  const {
    updateScanStatus,
    handleStartBatchScan,
    handleExportAvailableTxt,
    saveScanCursor,
    clearScanCursor,
    resetScan,
    pauseScan
  } = useScannerBatchScan({
    apiFetch,
    showToast,
    dnsheAccounts,
    batchRules,
    excludeChars,
    batchLength,
    resolveBank,
    selectedRoots,
    seqMode,
    seqCharset,
    seqLength,
    seqStart,
    enableReservedFilter,
    reservedPrefixes,
    ignorePool,
    scanControlRef,
    setScanStatus,
    setScanProgress,
    availableDomainsList,
    setAvailableDomainsList,
    setScanLogs,
    setScanCursor,
    scanCursorRef
  });

  return {
    DEFAULT_ROOT_DOMAINS,
    DEFAULT_RESERVED_PREFIXES,
    MAX_PREFIXES,
    showToast,
    allRootDomains,
    newRootInput,
    setNewRootInput,
    handleAddCustomRootDomain,
    handleRemoveCustomRootDomain,
    searchSubdomain,
    setSearchSubdomain,
    searchRootdomain,
    setSearchRootdomain,
    whoisLoading,
    whoisResult,
    setWhoisResult,
    registerAccountId,
    setRegisterAccountId,
    handleCheckWhois,
    handleRegisterSubdomain,
    regMode,
    setRegMode,
    batchRules,
    setBatchRules,
    excludeChars,
    setExcludeChars,
    selectedRoots,
    setSelectedRoots,
    batchLength,
    setBatchLength,
    resolveBank,
    rulePreview,
    formatDuration,
    seqMode,
    setSeqMode,
    seqCharset,
    setSeqCharset,
    seqLength,
    setSeqLength,
    seqStart,
    setSeqStart,
    scanStatus,
    scanProgress,
    availableDomainsList,
    scanLogs,
    scanCursor,
    scanCursorRef,
    updateScanStatus,
    handleStartBatchScan,
    handleExportAvailableTxt,
    saveScanCursor,
    clearScanCursor,
    handleRegisterFromResult,
    ignorePool,
    setIgnorePool,
    reservedPrefixes,
    enableReservedFilter,
    newReservedInput,
    setNewReservedInput,
    handleAddReserved,
    handleRemoveReserved,
    handleResetReserved,
    toggleReservedFilter,
    wordBanks,
    bankModalOpen,
    setBankModalOpen,
    editingBank,
    bankFormName,
    setBankFormName,
    bankFormKind,
    setBankFormKind,
    bankFormWords,
    setBankFormWords,
    openCreateBank,
    openEditBank,
    handleSaveBank,
    handleDeleteBank,
    handleResetBanks,
    appendWordbank,
    resetScan,
    pauseScan,
    registerLoading
  };
}

export type UseScannerReturn = ReturnType<typeof useScanner>;
