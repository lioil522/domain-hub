import type { BatchBasicOptionsModel } from "../utils/scanner-view-model";

interface BatchBasicOptionsProps {
  scanner: BatchBasicOptionsModel;
}

export function BatchBasicOptions({ scanner }: BatchBasicOptionsProps) {
  const {
    ignorePool, setIgnorePool,
    scanCursor, scanStatus,
    handleStartBatchScan, clearScanCursor,
  } = scanner;

  return (
    <>
      {/* 查重池开关 */}
      <label htmlFor="registerpage-fld7" className="flex items-center gap-2 cursor-pointer">
        <input id="registerpage-fld7"
          type="checkbox"
          checked={ignorePool}
          onChange={(e) => setIgnorePool(e.target.checked)}
          className="w-4 h-4 accent-amber-500"
        />
        <span className="text-xs font-semibold text-content-secondary">
          忽略查重池，强制全部重查
          <span className="text-content-muted font-normal ml-1">
            （默认会跳过池中 7 天内已确认「已注册」的域名以节省 API 配额；勾选此项可刷新过期结论）
          </span>
        </span>
      </label>

      {/* 断点续查提示条 */}
      {scanCursor && scanStatus !== "running" && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-amber-50 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-500/30 rounded-xl px-4 py-3">
          <div className="text-xs text-amber-800 dark:text-amber-300">
            🔖 检测到上次未完成的扫描断点：
            <span className="font-mono font-bold mx-1">{scanCursor.lastCandidate || "起点"}</span>
            （已查 {scanCursor.checked} 个 · 保存于 {scanCursor.savedAt}）
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => handleStartBatchScan(scanCursor.lastCandidate)}
              className="bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-all"
            >
              从断点继续
            </button>
            <button
              onClick={clearScanCursor}
              className="text-xs text-content-muted hover:text-content-primary px-2 py-1.5"
            >
              清除断点
            </button>
          </div>
        </div>
      )}
    </>
  );
}
