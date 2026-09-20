import { Search, Sparkles } from "lucide-react";
import type { UseScannerReturn } from "../hooks/useScanner";

interface ScannerModeTabsProps {
  scanner: UseScannerReturn;
}

export function ScannerModeTabs({ scanner }: ScannerModeTabsProps) {
  const {
    regMode,
    setRegMode,
  } = scanner;

  return (
            <div className="flex flex-col sm:flex-row bg-surface p-1.5 rounded-2xl border border-border-base gap-2">
              <button
                onClick={() => setRegMode("single")}
                className={`flex-1 py-3 text-sm font-bold rounded-xl transition-all flex items-center justify-center gap-2 ${
                  regMode === "single"
                    ? "bg-accent text-accent-contrast shadow-lg shadow-accent"
                    : "text-content-muted hover:text-content-primary hover:bg-hovered"
                }`}
              >
                <Search className="w-4 h-4" /> 精准单域名查重
              </button>
              <button
                onClick={() => setRegMode("batch")}
                className={`flex-1 py-3 text-sm font-bold rounded-xl transition-all flex items-center justify-center gap-2 ${
                  regMode === "batch"
                    ? "bg-accent text-accent-contrast shadow-lg shadow-accent"
                    : "text-content-muted hover:text-content-primary hover:bg-hovered"
                }`}
              >
                <Sparkles className="w-4 h-4 text-amber-400" /> 规则多域名查重
              </button>
            </div>
  );
}
