import { Download, Play } from "lucide-react";
import type { ScannerControlBarModel } from "../utils/scanner-view-model";

interface ScannerControlBarProps {
  scanner: ScannerControlBarModel;
}

export function ScannerControlBar({ scanner }: ScannerControlBarProps) {
  const {
    scanStatus,
    availableDomainsList,
    handleStartBatchScan,
    pauseScan,
    resetScan,
    handleExportAvailableTxt,
  } = scanner;

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border-base pt-5">
      <button
        onClick={() => handleStartBatchScan()}
        disabled={scanStatus === "running"}
        className="bg-accent-gradient hover:opacity-95 text-accent-contrast font-bold text-sm px-6 py-3 rounded-xl transition-all shadow-lg shadow-accent flex items-center gap-2 disabled:opacity-50"
      >
        <Play className={`w-4 h-4 ${scanStatus === "running" ? "animate-spin" : ""}`} />
        {scanStatus === "running" ? "正在查重中..." : scanStatus === "paused" ? "恢复查询" : "开始生成查询"}
      </button>

      <button
        onClick={pauseScan}
        disabled={scanStatus !== "running"}
        className="bg-elevated hover:bg-hovered text-content-secondary font-semibold text-sm px-5 py-3 rounded-xl transition-all disabled:opacity-50"
      >
        暂停查询
      </button>

      <button
        onClick={resetScan}
        className="bg-elevated hover:bg-hovered text-content-secondary font-semibold text-sm px-5 py-3 rounded-xl transition-all"
      >
        重新开始
      </button>

      <button
        onClick={handleExportAvailableTxt}
        disabled={availableDomainsList.length === 0}
        className="bg-emerald-700 hover:bg-emerald-600 text-white font-semibold text-sm px-5 py-3 rounded-xl transition-all flex items-center gap-2 ml-auto disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Download className="w-4 h-4" />
        导出 txt 字典文件 ({availableDomainsList.length})
      </button>
    </div>
  );
}
