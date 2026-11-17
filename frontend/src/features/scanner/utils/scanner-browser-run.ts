import type { ApiFetch } from "../../../api/client";
import type { Account } from "../../../types/account";
import type { ScannerTask } from "./scanner-batch-planner";
import type { AvailableDomain, ScanCursorV2, ScanLog, ScanStatus, ScannerExecutorCheckpoint, ScannerPlanSnapshot, ScannerParams } from "./scanner-types";
import { primeScannerSkipPool } from "./scanner-batch-pool";
import { runScannerWorkers, scannerSleep, type ScannerTaskOutcome } from "./scanner-batch-executor";
import { classifyScannerResponse } from "./scanner-response";
import { scannerJsonRequest } from "./scanner-request";

type Options = {
  apiFetch: ApiFetch;
  accounts: Account[];
  tasks: ScannerTask[];
  plan: ScannerPlanSnapshot;
  backend: string;
  restored?: ScanCursorV2;
  available: AvailableDomain[];
  getStatus: () => ScanStatus;
  isCurrent: () => boolean;
  onAvailable: (item: AvailableDomain) => void;
  onProgress: (progress: ScannerParams) => void;
  onLog: (log: ScanLog) => void;
  onPause: (message: string) => void;
  onCheckpoint: (cursor: ScanCursorV2, force: boolean) => void;
  rateLimitMs?: number;
};

/** Browser-owned runner: cancellation and supersession fence every result and callback. */
export class BrowserScannerRun {
  running = false;
  readonly controller = new AbortController();
  readonly available = new Map<string, AvailableDomain>();
  readonly failed = new Set<number>();
  private checkpoint: ScannerExecutorCheckpoint;
  private retryUntil = 0;
  private lastPublishedAt = 0;
  private lastPublishedCount = 0;
  constructor(private readonly options: Options) {
    const restored = options.restored;
    this.checkpoint = { nextIndex: restored?.taskIndex || 0, completedAhead: restored?.completedAhead || [], completedCount: restored?.checked || 0 };
    this.retryUntil = restored?.failedIndices.length ? restored.retryUntil || 0 : 0;
    for (const item of restored?.availableDomains || options.available) this.available.set(item.fullDomain, item);
    for (const index of restored?.failedIndices || []) this.failed.add(index);
  }
  private current = () => !this.controller.signal.aborted && this.options.isCurrent();
  abort() { this.controller.abort(); }

  snapshot(): ScanCursorV2 {
    const { plan, tasks } = this.options;
    return {
      version: 2, backend: this.options.backend, plan, total: tasks.length,
      seqMode: plan.seqMode, charset: plan.seqCharset, length: plan.seqLength,
      lastCandidate: tasks[this.checkpoint.nextIndex]?.sub || "",
      taskIndex: this.checkpoint.nextIndex, checked: this.checkpoint.completedCount,
      completedAhead: this.checkpoint.completedAhead, failedIndices: [...this.failed],
      retryUntil: this.retryUntil,
      availableDomains: [...this.available.values()], savedAt: new Date().toLocaleString(),
    };
  }
  publish(force = false) {
    if (!this.current()) return;
    this.options.onProgress({ total: this.options.tasks.length, checked: this.checkpoint.completedCount, available: this.available.size, failed: this.failed.size });
    if (force || Date.now() - this.lastPublishedAt >= 1000 || this.checkpoint.completedCount - this.lastPublishedCount >= 20) {
      this.lastPublishedAt = Date.now();
      this.lastPublishedCount = this.checkpoint.completedCount;
      this.options.onCheckpoint(this.snapshot(), force);
    }
  }
  private log(text: string, status: ScanLog["status"]) {
    if (this.current()) this.options.onLog({ id: Date.now() + Math.random(), time: new Date().toLocaleTimeString(), text, status });
  }

  async start() {
    this.running = true;
    try { return await this.execute(); }
    finally { this.running = false; }
  }
  private async execute() {
    const { options } = this;
    let skip = new Set<string>();
    if (!options.plan.ignorePool) skip = await primeScannerSkipPool({
      apiFetch: options.apiFetch, tasks: options.tasks, batchSize: 400, signal: this.controller.signal,
      onFailure: () => this.log("查重池加载失败，本轮继续实际查询，不会把失败视为已注册", "error"),
      onBackgroundComplete: count => this.log(`查重池加载完毕，命中 ${count} 个已注册域名`, "info"),
    });
    if (!this.current()) return null;
    if (this.retryUntil > Date.now()) await scannerSleep(Math.min(86400000, this.retryUntil - Date.now()), this.controller.signal);
    if (!this.current()) return null;
    return runScannerWorkers({
      tasks: options.tasks, accounts: options.accounts.slice(0, 16), rateLimitMs: options.rateLimitMs ?? 1200,
      signal: this.controller.signal, resume: this.checkpoint,
      getStatus: () => this.current() ? options.getStatus() : "idle",
      shouldSkip: task => !options.plan.ignorePool && skip.has(task.queryFull),
      onTaskClaimed: () => {},
      onSkipped: (_task, index) => { this.failed.delete(index); if (!this.failed.size) this.retryUntil = 0; },
      onCheckpoint: checkpoint => { this.checkpoint = checkpoint; this.publish(options.getStatus() === "paused"); },
      processTask: (task, account, index) => this.processTask(task, account, index),
    });
  }

  private async processTask(task: ScannerTask, account: Account | null, index: number): Promise<ScannerTaskOutcome> {
    const label = account?.alias || "公共查询";
    try {
      const { response, payload } = await scannerJsonRequest(this.options.apiFetch,
        `/api/whois?domain=${encodeURIComponent(task.queryFull)}${account ? `&account_id=${account.id}` : ""}&batch=1`,
        {}, this.controller.signal);
      if (!this.current()) return { kind: "aborted" };
      const result = classifyScannerResponse(response.status, payload, response.headers.get("Retry-After"));
      if (result.kind === "retry") {
        this.failed.add(index);
        this.retryUntil = Math.max(this.retryUntil, Date.now() + result.retryAfterMs);
        this.log(`[${label}] ${task.full} ➔ 未确定：${result.reason}；已保留待重试`, "error");
        this.options.onPause(`查询未确定，已暂停并保留断点：${result.reason}`);
        return { kind: "retry", retryAfterMs: result.retryAfterMs };
      }
      this.failed.delete(index);
      if (!this.failed.size) this.retryUntil = 0;
      if (result.kind === "available" && !this.available.has(task.full)) {
        const item = { fullDomain: task.full, subdomain: task.sub, rootdomain: task.root, time: new Date().toLocaleTimeString() };
        this.available.set(task.full, item);
        this.options.onAvailable(item);
      }
      this.log(`[${label}] ${task.full} ➔ ${result.kind === "available" ? "尚未注册" : "已注册"}`, result.kind);
      return { kind: "completed" };
    } catch (error) {
      if (!this.current()) return { kind: "aborted" };
      this.failed.add(index);
      this.log(`[${label}] ${task.full} ➔ 请求失败，结果未知，已保留待重试`, "error");
      this.options.onPause(error instanceof Error ? `查询失败，已暂停：${error.message}` : "查询失败，已暂停");
      return { kind: "retry", retryAfterMs: 1200 };
    }
  }
}
