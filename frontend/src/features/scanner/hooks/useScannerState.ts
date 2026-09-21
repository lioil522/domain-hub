import { useRef, useState } from "react";
import type { WordBank, BankKind } from "../../../wordbanks";
import { BUILTIN_TOKENS } from "../../../rulegen";
import { DEFAULT_ROOT_DOMAINS, DEFAULT_RESERVED_PREFIXES } from "../utils/scanner-constants";
import { loadWordBanks } from "../../../wordbanks";
import type { AvailableDomain, ScanLog, ScanStatus, ScannerParams, WhoisResult } from "../utils/scanner-types";
import { loadCustomRootDomains, loadReservedFilterEnabled, loadReservedPrefixes, loadScanCursor } from "../utils/scanner-storage";

export function useScannerState() {
  const [allRootDomains, setAllRootDomains] = useState<string[]>(() => loadCustomRootDomains(DEFAULT_ROOT_DOMAINS));
  const [newRootInput, setNewRootInput] = useState("");
  const [searchSubdomain, setSearchSubdomain] = useState("");
  const [searchRootdomain, setSearchRootdomain] = useState("us.ci");
  const [whoisLoading, setWhoisLoading] = useState(false);
  const [whoisResult, setWhoisResult] = useState<WhoisResult | null>(null);
  const [registerAccountId, setRegisterAccountId] = useState<number | "">("");
  const [regMode, setRegMode] = useState<"single" | "batch">("single");
  const [batchRules, setBatchRules] = useState("");
  const [excludeChars, setExcludeChars] = useState("");
  const [selectedRoots, setSelectedRoots] = useState<string[]>([]);
  const [batchLength, setBatchLength] = useState(2);
  const [scanStatus, setScanStatus] = useState<ScanStatus>("idle");
  const scanControlRef = useRef<ScanStatus>("idle");
  const [scanProgress, setScanProgress] = useState<ScannerParams>({ total: 0, checked: 0, available: 0 });
  const [availableDomainsList, setAvailableDomainsList] = useState<AvailableDomain[]>([]);
  const [scanLogs, setScanLogs] = useState<ScanLog[]>([]);
  const [seqMode, setSeqMode] = useState(false);
  const [seqCharset, setSeqCharset] = useState<"字母" | "数字" | "字母数字">("字母");
  const [seqLength, setSeqLength] = useState(3);
  const [seqStart, setSeqStart] = useState("");
  const [scanCursor, setScanCursor] = useState(() => loadScanCursor());
  const scanCursorRef = useRef({ lastCandidate: "", taskIndex: 0, checked: 0 });
  const [ignorePool, setIgnorePool] = useState(false);
  const [reservedPrefixes, setReservedPrefixes] = useState<string[]>(() => loadReservedPrefixes(DEFAULT_RESERVED_PREFIXES));
  const [enableReservedFilter, setEnableReservedFilter] = useState(loadReservedFilterEnabled);
  const [newReservedInput, setNewReservedInput] = useState("");
  const [wordBanks, setWordBanks] = useState<WordBank[]>(() => loadWordBanks(new Set(BUILTIN_TOKENS)));
  const [bankModalOpen, setBankModalOpen] = useState(false);
  const [editingBank, setEditingBank] = useState<WordBank | null>(null);
  const [bankFormName, setBankFormName] = useState("");
  const [bankFormKind, setBankFormKind] = useState<BankKind>("cn");
  const [bankFormWords, setBankFormWords] = useState("");

  return {
    DEFAULT_ROOT_DOMAINS,
    DEFAULT_RESERVED_PREFIXES,
    allRootDomains, setAllRootDomains, newRootInput, setNewRootInput,
    searchSubdomain, setSearchSubdomain, searchRootdomain, setSearchRootdomain,
    whoisLoading, setWhoisLoading, whoisResult, setWhoisResult,
    registerAccountId, setRegisterAccountId, regMode, setRegMode,
    batchRules, setBatchRules, excludeChars, setExcludeChars,
    selectedRoots, setSelectedRoots, batchLength, setBatchLength,
    scanStatus, setScanStatus, scanControlRef, scanProgress, setScanProgress,
    availableDomainsList, setAvailableDomainsList, scanLogs, setScanLogs,
    seqMode, setSeqMode, seqCharset, setSeqCharset, seqLength, setSeqLength,
    seqStart, setSeqStart, scanCursor, setScanCursor, scanCursorRef,
    ignorePool, setIgnorePool, reservedPrefixes, setReservedPrefixes,
    enableReservedFilter, setEnableReservedFilter, newReservedInput, setNewReservedInput,
    wordBanks, setWordBanks, bankModalOpen, setBankModalOpen, editingBank, setEditingBank,
    bankFormName, setBankFormName, bankFormKind, setBankFormKind, bankFormWords, setBankFormWords
  };
}

export { DEFAULT_ROOT_DOMAINS, DEFAULT_RESERVED_PREFIXES };
