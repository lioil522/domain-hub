import { createBatchPlan, type BatchPlanOptions } from "./scanner-batch-planner";
import type { ScanCursorV2, ScannerPlanSnapshot } from "./scanner-types";
import { MAX_SCANNER_TASKS } from "./scanner-constants";

export function captureScannerPlan(options: BatchPlanOptions & { ignorePool: boolean }) {
  const wordBanks: Record<string, string[]> = Object.create(null);
  const result = createBatchPlan({
    ...options,
    resolveBank: name => {
      const bank = options.resolveBank(name);
      if (bank) wordBanks[name] = [...bank];
      return bank;
    },
  });
  const { resolveBank: _resolver, ...config } = options;
  const plan: ScannerPlanSnapshot = { ...config, selectedRoots: [...config.selectedRoots], reservedPrefixes: [...config.reservedPrefixes], wordBanks };
  return { result, plan };
}

export function restoreScannerPlan(cursor: ScanCursorV2) {
  const result = createBatchPlan({
    ...cursor.plan,
    resolveBank: name => Object.prototype.hasOwnProperty.call(cursor.plan.wordBanks, name) ? cursor.plan.wordBanks[name] : null,
  });
  if (!result.ok || result.plan.tasks.length !== cursor.total) throw new Error("扫描快照与任务数量不一致，请重新开始");
  return result.plan;
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Storage is untrusted: never silently advance a cursor from an invalid checkpoint. */
export function isScanCursorV2(value: unknown): value is ScanCursorV2 {
  if (!value || typeof value !== "object") return false;
  const cursor = value as Partial<ScanCursorV2>;
  const plan = cursor.plan;
  if (cursor.version !== 2 || typeof cursor.backend !== "string" || typeof cursor.savedAt !== "string" ||
      typeof cursor.lastCandidate !== "string" || !integer(cursor.total) || !integer(cursor.taskIndex) ||
      !integer(cursor.checked) || cursor.total > MAX_SCANNER_TASKS || cursor.taskIndex > cursor.total || cursor.checked > cursor.total ||
      !Array.isArray(cursor.completedAhead) || !Array.isArray(cursor.failedIndices) || !plan) return false;
  if (cursor.retryUntil !== undefined && !integer(cursor.retryUntil)) return false;
  const ahead = cursor.completedAhead;
  if (ahead.length > 1024 || cursor.failedIndices.length > 1024 || new Set(cursor.failedIndices).size !== cursor.failedIndices.length || new Set(ahead).size !== ahead.length ||
      !ahead.every(index => integer(index) && index > cursor.taskIndex! && index < cursor.total!) ||
      cursor.checked !== cursor.taskIndex + ahead.length ||
      !cursor.failedIndices.every(index => integer(index) && index >= cursor.taskIndex! && index < cursor.total! && !ahead.includes(index))) return false;
  if (typeof plan.seqMode !== "boolean" || !["字母", "数字", "字母数字"].includes(plan.seqCharset) ||
      !integer(plan.seqLength) || !integer(plan.batchLength) || typeof plan.seqStart !== "string" ||
      typeof plan.batchRules !== "string" || typeof plan.excludeChars !== "string" ||
      !strings(plan.selectedRoots) || !strings(plan.reservedPrefixes) || typeof plan.enableReservedFilter !== "boolean" ||
      typeof plan.ignorePool !== "boolean" || !plan.wordBanks || typeof plan.wordBanks !== "object" ||
      !Object.values(plan.wordBanks).every(strings)) return false;
  return Array.isArray(cursor.availableDomains) && cursor.availableDomains.every(item =>
    item && typeof item.fullDomain === "string" && typeof item.subdomain === "string" &&
    typeof item.rootdomain === "string" && typeof item.time === "string");
}
