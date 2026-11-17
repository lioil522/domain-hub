import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ApiFetch } from "../../../api/client";
import type { Account } from "../../../types/account";
import type { AvailableDomain, ScanCursor, ScanCursorV2, ScanLog, ScanStatus, ScannerParams, ScannerPlanSnapshot } from "../utils/scanner-types";
import type { ScannerTask } from "../utils/scanner-batch-planner";
import { captureScannerPlan, isScanCursorV2, restoreScannerPlan } from "../utils/scanner-checkpoint";
import { BrowserScannerRun } from "../utils/scanner-browser-run";
import { clearScanCursor as clearPersistedCursor, loadScanCursor, saveScanCursor as persistCursor, scannerBackendKey } from "../utils/scanner-storage";

type Toast = (kind: "success" | "error" | "info" | "warning", message: string) => void;
type Options = {
  apiFetch: ApiFetch;
  backendUrl: string;
  sessionToken: string | null;
  showToast: Toast;
  dnsheAccounts: Account[];
  batchRules: string; excludeChars: string; batchLength: number;
  resolveBank: (name: string) => string[] | null;
  selectedRoots: string[];
  seqMode: boolean; seqCharset: "字母" | "数字" | "字母数字"; seqLength: number; seqStart: string;
  enableReservedFilter: boolean; reservedPrefixes: string[]; ignorePool: boolean;
  scanControlRef: MutableRefObject<ScanStatus>;
  setScanStatus: Dispatch<SetStateAction<ScanStatus>>;
  setScanProgress: Dispatch<SetStateAction<ScannerParams>>;
  availableDomainsList: AvailableDomain[];
  setAvailableDomainsList: Dispatch<SetStateAction<AvailableDomain[]>>;
  setScanLogs: Dispatch<SetStateAction<ScanLog[]>>;
  setScanCursor: Dispatch<SetStateAction<ScanCursor | ScanCursorV2 | null>>;
  scanCursorRef: MutableRefObject<{ lastCandidate: string; taskIndex: number; checked: number }>;
};

export function useScannerBatchScan(options: Options) {
  const { backendUrl, sessionToken, showToast, scanControlRef, setScanStatus, setScanProgress,
    setAvailableDomainsList, setScanLogs, setScanCursor, scanCursorRef } = options;
  const active = useRef<BrowserScannerRun | null>(null);
  const cleared = useRef(false);
  const storageWarning = useRef(false);
  const updateScanStatus = (status: ScanStatus) => { scanControlRef.current = status; setScanStatus(status); };

  const save = (cursor: ScanCursorV2) => {
    scanCursorRef.current = { lastCandidate: cursor.lastCandidate, taskIndex: cursor.taskIndex, checked: cursor.checked };
    try {
      persistCursor(cursor);
      setScanCursor(cursor);
      storageWarning.current = false;
    } catch {
      updateScanStatus("paused");
      if (!storageWarning.current) showToast("warning", "断点保存失败，已暂停。请导出已有结果并清理浏览器存储后继续；刷新只能恢复最后成功保存的断点。");
      storageWarning.current = true;
    }
  };
  const clearScanCursor = () => {
    try { clearPersistedCursor(backendUrl); setScanCursor(null); return true; }
    catch { showToast("warning", "无法清除本地断点，刷新仍可能恢复旧扫描，请检查浏览器存储权限"); return false; }
  };
  const saveScanCursor = (_candidate: string, _index: number, _checked: number) => {
    const run = active.current;
    if (run) save(run.snapshot());
  };
  useEffect(() => () => {
    const run = active.current;
    if (!run) return;
    run.publish(true);
    run.abort();
    active.current = null;
    scanControlRef.current = "paused";
    setScanStatus("paused");
  }, [backendUrl, sessionToken]);

  const handleStartBatchScan = async (resumeFrom?: string) => {
    if (!sessionToken) return;
    if (active.current && scanControlRef.current === "running") return;
    if (active.current?.running && scanControlRef.current === "paused") {
      storageWarning.current = false;
      updateScanStatus("running");
      showToast("info", "已恢复查询；限流等待时间仍会被遵守");
      return;
    }
    const stored = resumeFrom !== undefined || scanControlRef.current === "paused" ? loadScanCursor(backendUrl) : null;
    if (stored && !isScanCursorV2(stored)) {
      showToast("warning", "旧版断点未保存完整规则，无法安全恢复，请选择重新开始");
      return;
    }
    const restored = isScanCursorV2(stored) ? stored : undefined;
    let tasks: ScannerTask[];
    let plan: ScannerPlanSnapshot;
    try {
      if (restored) {
        tasks = restoreScannerPlan(restored).tasks;
        plan = restored.plan;
      } else {
        const captured = captureScannerPlan({
          seqMode: options.seqMode, seqCharset: options.seqCharset, seqLength: options.seqLength, seqStart: options.seqStart,
          batchRules: options.batchRules, excludeChars: options.excludeChars, batchLength: options.batchLength,
          resolveBank: options.resolveBank, selectedRoots: options.selectedRoots,
          enableReservedFilter: options.enableReservedFilter, reservedPrefixes: options.reservedPrefixes, ignorePool: options.ignorePool,
        });
        if (!captured.result.ok) {
          showToast("error", captured.result.issue.kind === "too-many-tasks" ? "任务超过 30 万上限，请减少规则或根域名数量后分批扫描" : "无法生成扫描任务，请检查根域名、规则、字符集及保留名单");
          return;
        }
        tasks = captured.result.plan.tasks;
        plan = captured.plan;
      }
    }
    catch (error) { showToast("error", error instanceof Error ? error.message : "断点恢复失败"); return; }
    if (restored) setAvailableDomainsList(restored.availableDomains);
    active.current?.abort();
    storageWarning.current = false;
    const run: BrowserScannerRun = new BrowserScannerRun({
      apiFetch: options.apiFetch, accounts: options.dnsheAccounts, tasks,
      plan, backend: scannerBackendKey(backendUrl), restored,
      available: cleared.current ? [] : options.availableDomainsList,
      getStatus: () => scanControlRef.current, isCurrent: (): boolean => active.current === run,
      onAvailable: item => setAvailableDomainsList(prev => prev.some(value => value.fullDomain === item.fullDomain) ? prev : [item, ...prev]),
      onProgress: setScanProgress,
      onLog: log => setScanLogs(prev => [log, ...prev.slice(0, 49)]),
      onPause: message => { updateScanStatus("paused"); showToast("warning", message); },
      onCheckpoint: cursor => save(cursor),
    });
    active.current = run;
    cleared.current = false;
    updateScanStatus("running");
    run.publish(true);
    if (storageWarning.current) { run.abort(); active.current = null; return; }
    showToast("info", restored ? "按保存的规则、词库与连续完成检查点恢复；未完成项会重新查询" : "开始查询，最多使用 16 条账号流水线；未知结果会暂停并保留待重试");
    try {
      const result = await run.start();
      if (active.current !== run || run.controller.signal.aborted) return;
      if (result && result.nextIndex === tasks.length) {
        updateScanStatus("completed");
        clearScanCursor();
        active.current = null;
        showToast("success", `本轮查询完成，${result.skippedCount} 个已注册域名命中查重池`);
      }
    } catch (error) {
      if (active.current !== run || run.controller.signal.aborted) return;
      updateScanStatus("paused");
      run.publish(true);
      showToast("error", error instanceof Error ? error.message : "扫描失败，已保存断点");
    }
  };
  const resetScan = () => {
    active.current?.abort();
    active.current = null;
    cleared.current = true;
    updateScanStatus("idle");
    setAvailableDomainsList([]); setScanLogs([]); setScanProgress({ total: 0, checked: 0, available: 0, failed: 0 });
    if (clearScanCursor()) showToast("info", "已取消旧扫描并清除本轮断点");
  };
  const pauseScan = () => {
    updateScanStatus("paused");
    active.current?.publish(true);
    showToast("info", "已暂停；保存的是连续完成位置，进行中的请求不会造成跳项");
  };
  const handleExportAvailableTxt = () => {
    if (!options.availableDomainsList.length) { showToast("info", "暂无可用域名"); return; }
    const url = URL.createObjectURL(new Blob([options.availableDomainsList.map(item => item.fullDomain).join("\n")], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = `available_domains_${Date.now()}.txt`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  return { updateScanStatus, handleStartBatchScan, handleExportAvailableTxt, saveScanCursor, clearScanCursor, resetScan, pauseScan };
}
