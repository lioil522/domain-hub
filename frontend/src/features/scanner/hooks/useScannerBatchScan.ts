import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ApiFetch } from "../../../api/client";
import type { Account } from "../../../types/account";
import type { AvailableDomain, ScanCursor, ScanLog, ScanStatus, ScannerParams } from "../utils/scanner-types";
import { createBatchPlan, type ScannerTask } from "../utils/scanner-batch-planner";
import { primeScannerSkipPool } from "../utils/scanner-batch-pool";
import { runScannerWorkers } from "../utils/scanner-batch-executor";
import { clearScanCursor as clearPersistedScanCursor, saveScanCursor as persistScanCursor } from "../utils/scanner-storage";

type Toast = (kind: "success" | "error" | "info" | "warning", message: string) => void;
type ResolveBank = (name: string) => string[] | null;

type Options = {
  apiFetch: ApiFetch;
  showToast: Toast;
  dnsheAccounts: Account[];
  batchRules: string;
  excludeChars: string;
  batchLength: number;
  resolveBank: ResolveBank;
  selectedRoots: string[];
  seqMode: boolean;
  seqCharset: "字母" | "数字" | "字母数字";
  seqLength: number;
  seqStart: string;
  enableReservedFilter: boolean;
  reservedPrefixes: string[];
  ignorePool: boolean;
  scanControlRef: MutableRefObject<ScanStatus>;
  setScanStatus: Dispatch<SetStateAction<ScanStatus>>;
  setScanProgress: Dispatch<SetStateAction<ScannerParams>>;
  availableDomainsList: AvailableDomain[];
  setAvailableDomainsList: Dispatch<SetStateAction<AvailableDomain[]>>;
  setScanLogs: Dispatch<SetStateAction<ScanLog[]>>;
  setScanCursor: Dispatch<SetStateAction<ScanCursor | null>>;
  scanCursorRef: MutableRefObject<{ lastCandidate: string; taskIndex: number; checked: number }>;
};

export function useScannerBatchScan({
  apiFetch, showToast, dnsheAccounts, batchRules, excludeChars, batchLength, resolveBank,
  selectedRoots, seqMode, seqCharset, seqLength, seqStart, enableReservedFilter, reservedPrefixes,
  ignorePool, scanControlRef, setScanStatus, setScanProgress,
  availableDomainsList, setAvailableDomainsList, setScanLogs,
  setScanCursor, scanCursorRef
}: Options) {
  const updateScanStatus = (status: ScanStatus) => {
    scanControlRef.current = status;
    setScanStatus(status);
  };

  // 保存/清除断点光标
  const saveScanCursor = (lastCandidate: string, taskIndex: number, checked: number) => {
    const cursor: ScanCursor = {
      seqMode,
      charset: seqCharset,
      length: seqLength,
      lastCandidate,
      taskIndex,
      checked,
      savedAt: new Date().toLocaleString()
    };
    persistScanCursor(cursor);
    setScanCursor(cursor);
  };

  const clearScanCursor = () => {
    clearPersistedScanCursor();
    setScanCursor(null);
  };

  // 执行批量扫域名引擎（resumeFrom 非空时表示从断点续查）
  const handleStartBatchScan = async (resumeFrom?: string) => {
    if (scanControlRef.current === "paused") {
      updateScanStatus("running");
      showToast("info", "▶️ 已恢复批量扫描任务！");
      return;
    }

    if (selectedRoots.length === 0) {
      showToast("error", "请至少勾选一个根域名后缀！");
      return;
    }

    const planResult = createBatchPlan({
      seqMode,
      seqCharset,
      seqLength,
      seqStart: resumeFrom || seqStart,
      batchRules,
      excludeChars,
      batchLength,
      resolveBank,
      selectedRoots,
      enableReservedFilter,
      reservedPrefixes,
    });

    if (!planResult.ok) {
      const issue = planResult.issue;
      if (issue.kind === "empty-roots") showToast("error", "请至少勾选一个根域名后缀！");
      else if (issue.kind === "invalid-sequence") showToast("error", "顺序模式未能生成候选，请检查字符集与长度设置！");
      else if (issue.kind === "unknown-tokens") showToast("error", `规则中存在无法识别的标签：${issue.tokens.join("、")}`);
      else if (issue.kind === "empty-rules") showToast("error", "根据当前规则未能生成有效的前缀词库，请修改规则！");
      else showToast("error", "全部候选前缀都属于官方保留名单，无可查询项！");
      return;
    }

    for (const warning of planResult.warnings) showToast(
      warning.startsWith("⚠️") ? "warning" : "info",
      warning,
    );

    const allTasks = planResult.plan.tasks;
    const totalTasks = allTasks;

    const POOL_BATCH = 400;
    let poolFailed = false;
    const skipSet = ignorePool
      ? new Set<string>()
      : await primeScannerSkipPool({
          apiFetch,
          tasks: allTasks,
          batchSize: POOL_BATCH,
          onFailure: error => {
            poolFailed = true;
            console.error("查重池查询失败，将退化为全量扫描:", error);
            setScanLogs(prev => [
              {
                id: Date.now() + Math.random(),
                time: new Date().toLocaleTimeString(),
                text: "⚠️ 查重池查询失败，本轮已退化为全量扫描（不影响结果，仅多消耗 API 配额）",
                status: "error"
              },
              ...prev.slice(0, 49)
            ]);
            showToast("warning", "⚠️ 查重池查询失败，已退化为全量扫描");
          },
          onBackgroundComplete: count => {
            if (!poolFailed && count > 0) {
              setScanLogs(prev => [
                {
                  id: Date.now() + Math.random(),
                  time: new Date().toLocaleTimeString(),
                  text: `🗂️ 查重池加载完毕，共命中 ${count} 个已注册域名（扫描中自动跳过）`,
                  status: "info"
                },
                ...prev.slice(0, 49)
              ]);
            }
          },
        });

    if (!ignorePool && skipSet.size > 0) {
      showToast("info", `🗂️ 查重池已命中 ${skipSet.size} 个已注册域名，将在扫描中自动跳过`);
    }

    if (allTasks.length > 0 && skipSet.size >= allTasks.length) {
      showToast("success", "🎉 本轮全部候选均已在查重池中确认为已注册，无需重复查询！");
      updateScanStatus("completed");
      return;
    }

    // 多账号并发查重：调度器只负责领取任务、暂停/恢复、查重池跳过和账号限频。
    const RATE_LIMIT_MS = 1200;
    const workerAccounts = dnsheAccounts.length > 0 ? dnsheAccounts : [null];
    const workerCount = workerAccounts.length;

    updateScanStatus("running");
    setScanProgress({ total: totalTasks.length, checked: 0, available: availableDomainsList.length });
    showToast(
      "info",
      `🚀 开始多账号并发查重！绑定 ${workerCount} 个 API 账号，${workerCount} 条流水线并行（每个 API 独立保障 1.2s 限频），查重吞吐提升约 ${workerCount} 倍！`
    );

    let checkedCount = 0;

    const processTask = async (
      task: ScannerTask,
      account: (typeof workerAccounts)[number],
      nextTaskIndex: number,
    ) => {
      const accountQuery = account ? `&account_id=${account.id}` : "";
      const accAlias = account ? account.alias : "公共轮询";
      const nowTime = new Date().toLocaleTimeString();
      try {
        const res = await apiFetch(`/api/whois?domain=${encodeURIComponent(task.queryFull)}${accountQuery}&batch=1`);
        const data = await res.json();

        if (res.status === 429 || data.error_code === "rate_limited" || data.error_code === "quota_exceeded") {
          saveScanCursor(task.sub, nextTaskIndex, checkedCount);
          updateScanStatus("paused");
          setScanLogs(prev => [
            { id: Date.now() + Math.random(), time: nowTime, text: `[${accAlias}] ⛔ 触发 API 限流/配额上限，已自动暂停（断点已保存至 ${task.sub}）`, status: "error" },
            ...prev.slice(0, 49)
          ]);
          showToast("warning", "⛔ 触发 API 限流，已自动暂停并保存断点，稍后可点击继续");
          return;
        }

        if (data.success && data.whois && data.whois.registered === false) {
          setAvailableDomainsList(prev => [
            { fullDomain: task.full, subdomain: task.sub, rootdomain: task.root, time: nowTime },
            ...prev
          ]);
          checkedCount++;
          setScanProgress(p => ({ ...p, checked: checkedCount, available: p.available + 1 }));
          setScanLogs(prev => [
            { id: Date.now() + Math.random(), time: nowTime, text: `[${accAlias}] 校验域名 ${task.full} ➔ 🎉 尚未注册（可立即在线注册！）`, status: "available" },
            ...prev.slice(0, 49)
          ]);
        } else {
          checkedCount++;
          setScanProgress(p => ({ ...p, checked: checkedCount }));
          setScanLogs(prev => [
            { id: Date.now() + Math.random(), time: nowTime, text: `[${accAlias}] 校验域名 ${task.full} ➔ 已被他人注册`, status: "registered" },
            ...prev.slice(0, 49)
          ]);
        }
      } catch (err) {
        checkedCount++;
        setScanProgress(p => ({ ...p, checked: checkedCount }));
        setScanLogs(prev => [
          { id: Date.now() + Math.random(), time: nowTime, text: `[${accAlias}] 校验域名 ${task.full} ➔ ⚠️ 查询请求异常，已跳过`, status: "error" },
          ...prev.slice(0, 49)
        ]);
      }
    };

    const { skippedCount } = await runScannerWorkers({
      tasks: totalTasks,
      accounts: workerAccounts,
      rateLimitMs: RATE_LIMIT_MS,
      getStatus: () => scanControlRef.current,
      waitWhilePaused: async () => {
        while (scanControlRef.current === "paused") {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      },
      shouldSkip: task => !ignorePool && skipSet.has(task.queryFull),
      onTaskClaimed: (task, index) => {
        scanCursorRef.current = { lastCandidate: task.sub, taskIndex: index, checked: checkedCount };
      },
      onSkipped: () => {
        checkedCount++;
        setScanProgress(p => ({ ...p, checked: checkedCount }));
      },
      processTask,
    });

    if (scanControlRef.current === "running") {
      updateScanStatus("completed");
      clearScanCursor(); // 正常跑完，断点光标不再需要
      showToast(
        "success",
        skippedCount > 0
          ? `🎉 所有生成的域名字典查询完毕！其中 ${skippedCount} 个命中查重池已跳过，节省了同等数量的 API 配额。`
          : "🎉 所有生成的域名字典查询完毕！"
      );
    }
  };

  // 导出生成的 txt 结果
  const handleExportAvailableTxt = () => {
    if (availableDomainsList.length === 0) {
      showToast("info", "暂无已发现的可用域名供导出！");
      return;
    }

    const content = availableDomainsList.map(item => item.fullDomain).join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `available_domains_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("success", "已成功导出可用域名 txt 文本！");
  };

  const resetScan = () => {
    updateScanStatus("idle");
    setAvailableDomainsList([]);
    setScanLogs([]);
    setScanProgress({ total: 0, checked: 0, available: 0 });
    clearScanCursor();
    showToast("info", "🔄 已重置查重逻辑（断点已清除）");
  };

  const pauseScan = () => {
    const c = scanCursorRef.current;
    saveScanCursor(c.lastCandidate, c.taskIndex, c.checked);
    updateScanStatus("paused");
    showToast("info", `⏸️ 已暂停并保存断点（当前位置：${c.lastCandidate || "起点"}）`);
  };

  return {
    updateScanStatus,
    handleStartBatchScan,
    handleExportAvailableTxt,
    saveScanCursor,
    clearScanCursor,
    resetScan,
    pauseScan,
  };
}
