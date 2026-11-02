import { ModalOverlay } from "../../../components/ModalOverlay";
import {
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  RefreshCw,
  Download,
  Upload,
  X,
} from "lucide-react";

export interface DataOpModalProps {
  /** 关闭时直接返回 null（与项目其余弹窗一致，DOM 上不留残留节点） */
  open: boolean;
  mode: "export" | "import";
  /** 关闭：同时清空动态码与已选文件（头部 X 与底部「取消」共用） */
  onClose: () => void;
  /** 2FA 动态码（受控） */
  token: string;
  onTokenChange: (v: string) => void;
  /** 已选备份文件：`name` 用于回显，非空即代表「已选」 */
  importSnapshot: { name: string } | null;
  sourceAesKey: string;
  onSourceAesKeyChange: (value: string) => void;
  importPreview: { totalAdd: number } | null;
  onPickFile: (file: File | null) => void;
  /** 账户是否已开启 2FA —— 未开启时导出按钮置灰并给出警示条 */
  twoFaEnabled: boolean;
  /** 正在导出或导入中（按钮转圈 + 全部禁用） */
  busy: boolean;
  onExport: () => void;
  onImport: () => void;
}

/**
 * DataOpModal —— 数据导入 / 导出 的 2FA 二次验证弹窗（纯展示）
 *
 * WHY 拆出来：这段 JSX 有 100+ 行、且只依赖 `useDataTransfer` 返回的少量状态，
 * 留在 App 里会让「弹窗长什么样」和「页面怎么装配」混在一起。
 *
 * 行为约定（与拆分前逐字一致，勿随意改）：
 * - 结构、class、`id="app-dataop-title"` / `id="app-fld7"` / `id="app-fld8"` 全部原样保留，
 *   后两者与原 `<label htmlFor>` 成对，改名会破坏 label 关联。
 * - 导出**强制 2FA**：未开启时按钮 disabled（`!twoFaEnabled`），并显示琥珀色警示条。
 * - 动态码输入框：\`replace(/\\D/g, "")\` 过滤非数字、\`maxLength={6}\`、回车提交当前动作。
 * - 未开启 2FA 时禁用导出，但**不**禁用导入（仅提示建议开启）。
 */
export const DataOpModal = ({
  open,
  mode,
  onClose,
  token,
  onTokenChange,
  importSnapshot,
  sourceAesKey, onSourceAesKeyChange, importPreview,
  onPickFile,
  twoFaEnabled,
  busy,
  onExport,
  onImport,
}: DataOpModalProps) => {
  if (!open) return null;

  return (
    <ModalOverlay>
      <div role="dialog" aria-labelledby="app-dataop-title" className="bg-surface border border-border-base w-full max-w-md max-h-[90dvh] rounded-2xl overflow-hidden flex flex-col shadow-2xl">
        <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between gap-2 border-b border-border-base flex-shrink-0">
          <div className="min-w-0">
            <h3 id="app-dataop-title" className="text-base sm:text-lg font-bold text-content-primary flex items-center gap-2">
              {mode === "export"
                ? <Download className="text-sky-400 w-5 h-5 flex-shrink-0" />
                : <Upload className="text-emerald-400 w-5 h-5 flex-shrink-0" />}
              <span className="truncate">{mode === "export" ? "导出数据" : "导入数据"}</span>
            </h3>
            <p className="text-xs text-content-muted mt-0.5">
              {mode === "export" ? "业务快照最多500行/8MiB" : "先预览，再确认追加；不覆盖、不删除"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-content-muted hover:text-content-primary transition-colors flex-shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-4 overflow-y-auto">
          {/* 导入：选择备份文件 */}
          {mode === "import" && (
            <div className="space-y-2">
              <label htmlFor="app-fld7" className="text-xs text-content-muted font-medium block">选择备份文件（.json）</label>
              <input id="app-fld7"
                type="file"
                accept="application/json,.json"
                disabled={busy}
                onChange={(e) => { onPickFile(e.target.files?.[0] || null); }}
                className="w-full text-xs text-content-muted file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-elevated file:text-content-secondary hover:file:bg-hovered cursor-pointer"
              />
              {importSnapshot && (
                <div className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate font-mono">{importSnapshot.name}</span>
                </div>
              )}
              <p className="text-[11px] text-content-muted leading-relaxed">
                最多500行/8MiB。本地ID映射，服务商域名ID保留；已有身份或数据冲突整批停止。更大迁移请使用停写后的数据库/AES成对备份。
              </p>
              <label htmlFor="app-source-aes" className="text-xs text-content-muted font-medium block">源 AES 密钥（仅异密钥迁移时填写）</label>
              <input id="app-source-aes" type="password" autoComplete="off" maxLength={4096} disabled={busy}
                value={sourceAesKey} onChange={e => onSourceAesKeyChange(e.target.value)}
                className="w-full bg-elevated border border-border-base rounded-lg px-3 py-2 text-sm text-content-primary"
                placeholder="留空使用目标密钥；不保存密钥" />
              <p className="text-[11px] text-content-muted">仅通过 HTTPS 或本机连接提交；关闭/成功后清空，不写入备份或浏览器存储。</p>
              {importPreview && <p role="status" className="text-xs text-content-primary">凭据与归属预览通过：新增 {importPreview.totalAdd} 行，覆盖/删除 0 行。预览不锁定数据库，确认时会重新检查。</p>}
            </div>
          )}

          {/* 2FA 验证区 */}
          {twoFaEnabled ? (
            <div className="space-y-2 pt-3 border-t border-border-soft">
              <label htmlFor="app-fld8" className="text-xs text-content-primary font-semibold flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> 两步验证动态码
              </label>
              <input id="app-fld8"
                autoFocus
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={token}
                disabled={busy}
                onChange={(e) => onTokenChange(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => { if (e.key === "Enter" && !busy && (mode === "export" || !importPreview)) mode === "export" ? onExport() : onImport(); }}
                placeholder="身份验证器上的 6 位动态码"
                className="w-full bg-elevated border border-border-base rounded-lg px-3 py-2 text-sm font-mono tracking-widest text-center text-content-primary focus:outline-none focus:border-accent placeholder:text-content-muted placeholder:tracking-normal"
              />
              <p className="text-[11px] text-content-muted">
                连续输错 5 次将锁定 15 分钟。
              </p>
            </div>
          ) : (
            <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 rounded-xl p-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                {mode === "export" ? (
                  <>
                    <b>未开启两步验证，无法导出。</b>
                    请先在「设置 → 账户安全」开启 2FA，以保护导出的完整业务数据。
                  </>
                ) : (
                  <>未开启两步验证，导入将仅凭登录会话执行。建议开启 2FA 以保护此操作。</>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="bg-elevated px-4 sm:px-6 py-3 flex justify-end gap-2 border-t border-border-base flex-shrink-0">
          <button
            onClick={onClose}
            className="bg-surface hover:bg-hovered text-content-secondary border border-border-base px-4 py-2 rounded-lg text-sm"
          >
            取消
          </button>
          <button
            onClick={mode === "export" ? onExport : onImport}
            disabled={
              busy ||
              (mode === "export" && !twoFaEnabled) ||
              (mode === "import" && !importSnapshot)
            }
            className="btn-primary px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : mode === "export" ? (
              <Download className="w-4 h-4" />
            ) : (
              <Upload className="w-4 h-4" />
            )}
            {mode === "export" ? "验证并导出" : importPreview ? "确认追加导入" : "只读预览"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
};
