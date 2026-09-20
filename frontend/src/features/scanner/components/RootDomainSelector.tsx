import { Plus, X } from "lucide-react";
import type { RootDomainSelectorModel } from "../utils/scanner-view-model";

interface RootDomainSelectorProps {
  scanner: RootDomainSelectorModel;
}

export function RootDomainSelector({ scanner }: RootDomainSelectorProps) {
  const {
    DEFAULT_ROOT_DOMAINS,
    allRootDomains,
    newRootInput,
    setNewRootInput,
    handleAddCustomRootDomain,
    handleRemoveCustomRootDomain,
    selectedRoots,
    setSelectedRoots,
  } = scanner;

  return (
    <div className="space-y-3 border-t border-border-base pt-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <span className="text-xs font-semibold text-content-secondary">
          选择欲检测的 DNSHE 官方及自定义根域名后缀:
        </span>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSelectedRoots([...allRootDomains])}
            className="text-xs text-accent hover:underline"
          >
            全选 ({allRootDomains.length})
          </button>
          <span className="text-content-muted">|</span>
          <button
            onClick={() => setSelectedRoots([])}
            className="text-xs text-content-muted hover:underline"
          >
            反选
          </button>
        </div>
      </div>

      {/* 根域名复选框网格 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2">
        {allRootDomains.map((root) => {
          const isChecked = selectedRoots.includes(root);
          const isDefault = DEFAULT_ROOT_DOMAINS.includes(root);
          return (
            <div
              key={root}
              className={`group relative flex items-center justify-between p-2.5 md:p-2 rounded-lg border text-xs font-mono transition-all ${
                isChecked
                  ? "bg-accent-soft border-accent/40 text-accent"
                  : "bg-elevated border-border-base text-content-muted hover:text-content-primary"
              }`}
            >
              <label className="flex items-center gap-2 cursor-pointer w-full overflow-hidden">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedRoots(prev => Array.from(new Set([...prev, root])));
                    } else {
                      setSelectedRoots(prev => prev.filter(r => r !== root));
                    }
                  }}
                  className="rounded border-border-base text-accent accent-[var(--accent)] focus:ring-0"
                />
                <span className="truncate">.{root}</span>
              </label>

              {!isDefault && (
                <button
                  type="button"
                  title="删除该自定义根域名"
                  onClick={() => handleRemoveCustomRootDomain(root)}
                  /*
                    NOTE: 原本是 opacity-0 group-hover:opacity-100 —— 触屏没有
                    hover，这个按钮在手机上永远显不出来也点不到。窄屏改为常显，
                    ≥md 才保留"悬停才出现"的桌面观感。
                  */
                  className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-content-muted hover:text-red-400 p-1.5 md:p-0.5 ml-1 transition-opacity"
                >
                  <X className="w-3.5 h-3.5 md:w-3 md:h-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* 添加自定义根域名输入栏 */}
      <form onSubmit={handleAddCustomRootDomain} className="flex items-center gap-2 pt-1 max-w-sm">
        <input
          type="text"
          placeholder="添加新根域名(如 sample.cd)"
          value={newRootInput}
          onChange={(e) => setNewRootInput(e.target.value)}
          className="bg-elevated border border-border-base focus:border-accent rounded-lg px-3 py-1.5 text-xs text-content-primary focus:outline-none flex-1 font-mono"
        />
        <button
          type="submit"
          disabled={!newRootInput.trim()}
          className="bg-elevated hover:bg-hovered text-accent hover:opacity-80 border border-border-base text-xs px-3 py-1.5 rounded-lg transition-all flex items-center gap-1 disabled:opacity-40"
        >
          <Plus className="w-3.5 h-3.5" /> 添加根域
        </button>
      </form>
    </div>
  );
}
