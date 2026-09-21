import { toASCII } from "../../../punycode";
import { countCombos, generateCombos, parseRule } from "../../../rulegen";
import { MAX_PREFIXES } from "./scanner-constants";
import { generateSeqPrefixes } from "./scanner-sequence";

export type ScannerRuleResolver = (name: string) => string[] | null;
export type ScannerTask = { sub: string; root: string; full: string; queryFull: string };
export type BatchPlan = {
  prefixes: string[];
  tasks: ScannerTask[];
  totalCombos: number;
  truncated: boolean;
};

export type BatchPlanOptions = {
  seqMode: boolean;
  seqCharset: "字母" | "数字" | "字母数字";
  seqLength: number;
  seqStart: string;
  batchRules: string;
  excludeChars: string;
  batchLength: number;
  resolveBank: ScannerRuleResolver;
  selectedRoots: string[];
  enableReservedFilter: boolean;
  reservedPrefixes: string[];
};

export type BatchPlanIssue =
  | { kind: "empty-roots" }
  | { kind: "invalid-sequence" }
  | { kind: "unknown-tokens"; tokens: string[] }
  | { kind: "empty-rules" }
  | { kind: "all-reserved" };

export type BatchPlanResult =
  | { ok: true; plan: BatchPlan; warnings: string[] }
  | { ok: false; issue: BatchPlanIssue };

export function createBatchPlan(options: BatchPlanOptions): BatchPlanResult {
  if (options.selectedRoots.length === 0) {
    return { ok: false, issue: { kind: "empty-roots" } };
  }

  let prefixes: string[];
  let totalCombos = 0;
  const warnings: string[] = [];

  if (options.seqMode) {
    prefixes = generateSeqPrefixes(
      options.seqCharset,
      options.seqLength,
      options.seqStart,
      20000,
    );
    if (prefixes.length === 0) {
      return { ok: false, issue: { kind: "invalid-sequence" } };
    }
  } else {
    const parsed = parseRule(
      options.batchRules,
      options.excludeChars,
      options.batchLength,
      options.resolveBank,
    );
    if (parsed.unknownTokens.length > 0) {
      return { ok: false, issue: { kind: "unknown-tokens", tokens: parsed.unknownTokens } };
    }

    prefixes = generateCombos(parsed, MAX_PREFIXES);
    if (prefixes.length === 0) {
      return { ok: false, issue: { kind: "empty-rules" } };
    }

    totalCombos = countCombos(parsed);
    if (totalCombos > MAX_PREFIXES) {
      warnings.push(
        `⚠️ 该规则共 ${totalCombos.toLocaleString()} 条组合，已截断为前 ${MAX_PREFIXES.toLocaleString()} 条。超大规则建议改用顺序模式配合断点续查。`,
      );
    }
  }

  if (options.enableReservedFilter && options.reservedPrefixes.length > 0) {
    const reservedSet = new Set(options.reservedPrefixes.map(prefix => prefix.toLowerCase()));
    const before = prefixes.length;
    prefixes = prefixes.filter(prefix => !reservedSet.has(prefix.toLowerCase()));
    const removed = before - prefixes.length;
    if (removed > 0) {
      warnings.push(`🚫 已排除 ${removed} 个官方保留前缀（不可注册）`);
    }
    if (prefixes.length === 0) {
      return { ok: false, issue: { kind: "all-reserved" } };
    }
  }

  const tasks: ScannerTask[] = [];
  for (const sub of prefixes) {
    for (const root of options.selectedRoots) {
      const full = `${sub}.${root}`;
      tasks.push({ sub, root, full, queryFull: toASCII(full) });
    }
  }

  if (options.seqMode) {
    warnings.unshift(`🔢 顺序模式：从 [${prefixes[0]}] 开始，本轮生成 ${prefixes.length} 个候选前缀`);
  }

  return {
    ok: true,
    plan: { prefixes, tasks, totalCombos, truncated: totalCombos > MAX_PREFIXES },
    warnings,
  };
}

export function chunkScannerTasks(tasks: ScannerTask[], batchSize: number): ScannerTask[][] {
  if (batchSize <= 0) throw new Error("batchSize must be greater than zero");
  const chunks: ScannerTask[][] = [];
  for (let index = 0; index < tasks.length; index += batchSize) {
    chunks.push(tasks.slice(index, index + batchSize));
  }
  return chunks;
}
