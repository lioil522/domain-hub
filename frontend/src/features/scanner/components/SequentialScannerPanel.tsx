import { CustomSelect } from "../../../components/form/CustomSelect";
import type { SequentialScannerModel } from "../utils/scanner-view-model";

interface SequentialScannerPanelProps {
  scanner: SequentialScannerModel;
}

export function SequentialScannerPanel({ scanner }: SequentialScannerPanelProps) {
  const {
    seqMode, setSeqMode,
    seqCharset, setSeqCharset,
    seqLength, setSeqLength,
    seqStart, setSeqStart,
  } = scanner;

  return (
    <>
      <label htmlFor="registerpage-fld5" className="flex items-center gap-2 cursor-pointer">
        <input id="registerpage-fld5"
          type="checkbox"
          checked={seqMode}
          onChange={(e) => setSeqMode(e.target.checked)}
          className="w-4 h-4 accent-[var(--accent)]"
        />
        <span className="text-xs font-semibold text-content-secondary">
          启用顺序检测模式（按字符集进位递增，如 aaa → aab → aac…，开启后忽略上方规则框）
        </span>
      </label>

      {seqMode && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pl-6">
          <div className="space-y-1.5">
            <span className="block text-[11px] font-semibold text-content-muted">字符集:</span>
            <CustomSelect
              value={seqCharset}
              onChange={(v) => setSeqCharset(v as typeof seqCharset)}
              bare
              ariaLabel="字符集"
              options={[
                { value: "字母", label: "纯字母 (a-z)" },
                { value: "数字", label: "纯数字 (0-9)" },
                { value: "字母数字", label: "字母+数字 (a-z0-9)" },
              ]}
              className="bg-elevated border border-border-base rounded-xl px-3 py-2 text-content-primary text-xs focus:border-accent focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <span className="block text-[11px] font-semibold text-content-muted">长度:</span>
            <CustomSelect
              value={String(seqLength)}
              onChange={(v) => setSeqLength(Number(v))}
              bare
              ariaLabel="长度"
              options={[
                { value: "2", label: "2 位" },
                { value: "3", label: "3 位" },
                { value: "4", label: "4 位" },
              ]}
              className="bg-elevated border border-border-base rounded-xl px-3 py-2 text-content-primary text-xs focus:border-accent focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="registerpage-fld6" className="block text-[11px] font-semibold text-content-muted">起始串 (可选):</label>
            <input id="registerpage-fld6"
              type="text"
              value={seqStart}
              onChange={(e) => setSeqStart(e.target.value)}
              placeholder="如 qwe，留空从头开始"
              className="w-full bg-elevated border border-border-base rounded-xl px-3 py-2 text-content-primary text-xs focus:border-accent focus:outline-none"
            />
          </div>
        </div>
      )}
    </>
  );
}
