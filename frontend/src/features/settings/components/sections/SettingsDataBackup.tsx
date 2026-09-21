import { AlertTriangle, DatabaseBackup, Download, Save, Upload } from "lucide-react";
import { Button } from "../../../../components/Button";

export interface SettingsDataBackupProps {
  accountInfo: { two_fa_enabled: boolean };
  actionLoading: string | null;
  handleSaveSettings: () => void;
  onOpenDataOp: (mode: "export" | "import") => void;
}

export function SettingsDataBackup({ accountInfo, actionLoading, handleSaveSettings, onOpenDataOp }: SettingsDataBackupProps) {
  return (
    <>
          {/* 保存按钮 */}
          <div className="flex justify-end">
            {/*
              NOTE: 这里原先写的是 text-content-primary，压在 btn-primary 的
              品牌渐变上。亮色主题下 --text-primary 是近黑色（#0f172a），
              在靛蓝渐变上对比度只有 1.9:1，按钮文字几乎看不清 ——
              而且它跟着明暗主题变，暗色下又变成白色，等于同一个按钮
              在两种主题下有两种（其中一种是错的）前景色。
              正确做法是让颜色由强调色对比令牌决定：用 Button 组件的
              primary variant，它已经处理好了 accent-contrast。
            */}
            <Button
              variant="primary"
              size="md"
              icon={<Save className="w-4 h-4" />}
              loading={actionLoading === "save-settings"}
              onClick={handleSaveSettings}
              className="px-6"
            >
              保存全部设置
            </Button>
          </div>

          {/* 数据备份：导出需要 2FA（未配置 2FA 时禁用导出） */}
          <div className="bg-surface border border-border-base rounded-2xl p-4 sm:p-5 space-y-4">
            <h3 className="font-bold text-content-primary flex items-center gap-2">
              <DatabaseBackup className="w-4 h-4 text-sky-400" /> 数据备份与迁移
            </h3>
            <p className="text-xs text-content-muted leading-relaxed">
              导出账号、域名缓存、自定义分组与日期覆盖等<b>业务数据</b>为 JSON 快照。
              不含登录凭据、2FA 密钥、运行日志与临时缓存。
            </p>

            {/* 2FA 未开启时的阻断提示 —— 后端也会强制拒绝，这里只是提前告知 */}
            {!accountInfo.two_fa_enabled && (
              <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 rounded-xl p-3 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                  <b>导出功能需要先开启两步验证（2FA）。</b>
                  导出等于把全部账号凭据与域名数据一次性打包带走，仅凭登录会话不足以保护。
                  请在上方「账户安全」中开启 2FA 后再导出。
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => onOpenDataOp("export")}
                disabled={!accountInfo.two_fa_enabled}
                title={accountInfo.two_fa_enabled ? "导出全部业务数据" : "需先开启两步验证（2FA）"}
                className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Download className="w-4 h-4 text-sky-400" /> 导出数据
              </button>
              <button
                onClick={() => onOpenDataOp("import")}
                className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5"
              >
                <Upload className="w-4 h-4 text-emerald-400" /> 导入数据
              </button>
            </div>

            <p className="text-[11px] text-content-muted leading-relaxed">
              导入为<b>合并模式</b>：同 ID 覆盖、新 ID 新增，<b>不会删除</b>任何现有数据，可安全重复导入。
              跨环境迁移时目标环境需使用同一个 <span className="font-mono">AES_KEY</span>，否则加密的 API 凭据无法解密。
            </p>
          </div>
    </>
  );
}
