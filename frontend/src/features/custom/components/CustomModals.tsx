import { ModalOverlay } from "../../../components/ModalOverlay";
import { Input } from "../../../components/form/Input";
import {
  RefreshCw,
  X,
  AlertTriangle,
  CheckCircle2,
  CalendarClock,
  FolderPlus,
  UserCheck,
  Plus,
  Trash2,
} from "lucide-react";
import { DateField } from "../../../components/form/DateField/DateField";
import type { Account } from "../../../types/account";
import type { CustomAccount, CustomDomain } from "../../../types/custom";

/**
 * 五个自定义服务商弹窗共享的外层容器（保持各处 overlay 结构与 z-index 一致）。
 * `labelledBy` 是标题元素的 id：面板上声明 `role="dialog"` + `aria-labelledby`，让读屏器
 * 能播报弹窗用途。焦点陷阱由 `ModalOverlay` 统一提供，本层不必管。
 *
 * 仍**不加 `aria-modal`** —— 声明后辅助技术会把「对话框之外」视为惰性，而
 * `CustomSelect` / `DateField` 的面板是 portal 到 body 的（在对话框子树之外），
 * 会把读屏用户的下拉选项挡掉。见 docs/a11y-audit-2026-09-18.md §3.5。
 */
function ModalShell({ children, maxWidth, labelledBy }: { children: React.ReactNode; maxWidth: string; labelledBy: string }) {
  return (
    <ModalOverlay>
      <div role="dialog" aria-labelledby={labelledBy} className={`bg-surface border border-border-base w-full ${maxWidth} max-h-[90dvh] rounded-xl overflow-hidden flex flex-col shadow-2xl`}>
        {children}
      </div>
    </ModalOverlay>
  );
}

/** 新建 / 批量新建自定义服务商分组弹窗 */
export interface CustomGroupModalProps {
  open: boolean;
  onClose: () => void;
  saving: boolean;
  mode: "single" | "batch";
  setMode: (m: "single" | "batch") => void;
  alias: string;
  setAlias: (v: string) => void;
  website: string;
  setWebsite: (v: string) => void;
  batchRows: Array<{ alias: string; website: string }>;
  setBatchRows: React.Dispatch<React.SetStateAction<Array<{ alias: string; website: string }>>>;
  batchResults: Array<{ alias: string; success: boolean; message: string }> | null;
  setBatchResults: (v: Array<{ alias: string; success: boolean; message: string }> | null) => void;
  onCreate: () => void;
  onBatchCreate: () => void;
}

export function CustomGroupModal(props: CustomGroupModalProps) {
  const {
    open, onClose, saving, mode, setMode, alias, setAlias, website, setWebsite,
    batchRows, setBatchRows, batchResults, setBatchResults, onCreate, onBatchCreate,
  } = props;
  if (!open) return null;

  const close = () => { onClose(); setBatchResults(null); setMode("single"); };

  return (
    <ModalShell maxWidth="max-w-lg" labelledBy="custom-group-modal-title">
      <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between border-b border-border-base flex-shrink-0">
        <h3 id="custom-group-modal-title" className="text-lg font-bold text-content-primary flex items-center gap-2">
          <FolderPlus className="w-5 h-5 text-emerald-400" /> 新建自定义服务商分组
        </h3>
        <button onClick={close} disabled={saving} aria-label="关闭"
          className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
        {/* 模式切换 */}
        <div className="flex gap-1 bg-hovered border border-border-base rounded-lg p-1">
          <button
            onClick={() => { setMode("single"); setBatchResults(null); }}
            className={`flex-1 text-xs font-semibold py-1.5 rounded-md transition-all ${
              mode === "single" ? "bg-surface text-content-primary shadow-sm" : "text-content-muted hover:text-content-secondary"
            }`}
          >
            单个分组
          </button>
          <button
            onClick={() => setMode("batch")}
            className={`flex-1 text-xs font-semibold py-1.5 rounded-md transition-all ${
              mode === "batch" ? "bg-surface text-content-primary shadow-sm" : "text-content-muted hover:text-content-secondary"
            }`}
          >
            批量创建
          </button>
        </div>

        {mode === "single" ? (
          <div className="space-y-4">
            <div>
              <label htmlFor="custommodals-fld1" className="block text-xs font-semibold text-content-muted mb-1.5">分组名称</label>
              <Input id="custommodals-fld1"
                type="text" autoFocus value={alias}
                onChange={(e) => setAlias(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onCreate()}
                placeholder="例如：eu.org、pp.ua、公益域名"
                className="w-full text-content-secondary"
              />
              <p className="text-xs text-content-muted mt-2">
                用于归类没有 API 接口的社区公益域名。创建后可在组下手动添加域名与到期时间。
              </p>
            </div>
            <div>
              <label htmlFor="custommodals-fld2" className="block text-xs font-semibold text-content-muted mb-1.5">官网链接（可选）</label>
              <Input id="custommodals-fld2"
                type="text" value={website}
                onChange={(e) => setWebsite(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onCreate()}
                placeholder="例如：https://nic.eu.org"
                className="w-full text-content-secondary"
              />
              <p className="text-xs text-content-muted mt-2">
                填写后分组卡片名称旁会显示跳转按钮，方便直达该服务商官网。
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div>
              <span className="block text-xs font-semibold text-content-muted mb-1.5">批量分组（每行「分组名 | 官网」）</span>
              <div className="space-y-2 max-h-56 overflow-y-auto pr-0.5">
                {batchRows.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input aria-label="分组名" size="sm"
                      type="text" autoFocus={i === 0} value={row.alias}
                      onChange={(e) => setBatchRows((prev) => prev.map((r, idx) => idx === i ? { ...r, alias: e.target.value } : r))}
                      placeholder="分组名（如 eu.org）"
                      className="flex-1 min-w-0 text-content-secondary"
                    />
                    <Input aria-label="官网（可选）" size="sm"
                      type="text" value={row.website}
                      onChange={(e) => setBatchRows((prev) => prev.map((r, idx) => idx === i ? { ...r, website: e.target.value } : r))}
                      placeholder="官网（可选）"
                      className="flex-1 min-w-0 text-content-secondary"
                    />
                    <button
                      onClick={() => setBatchRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev))}
                      disabled={batchRows.length <= 1}
                      className="p-2 text-content-muted hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                      title="删除此行"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={() => setBatchRows((prev) => [...prev, { alias: "", website: "" }])}
                disabled={batchRows.length >= 50}
                className="mt-2 w-full text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 border border-dashed border-emerald-300 dark:border-emerald-900/60 rounded-lg py-2 flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus className="w-3.5 h-3.5" /> 添加一行
              </button>
              <p className="text-xs text-content-muted mt-2">
                每行填写一个分组名，官网链接可选。点「添加一行」可继续增加输入框，最多 50 个分组。
              </p>
            </div>

            {batchResults && (
              <div className="space-y-1 max-h-40 overflow-y-auto bg-hovered border border-border-base rounded-lg p-3 text-xs">
                {batchResults.map((r, i) => (
                  <div key={i} className={`flex items-start gap-2 ${r.success ? "text-emerald-500" : "text-red-500"}`}>
                    {r.success ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
                    <span className="break-all">{r.alias} — {r.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-end gap-3 border-t border-border-base flex-shrink-0">
        <button onClick={close} disabled={saving}
          className="text-xs font-semibold px-4 py-2 rounded-lg bg-elevated hover:bg-hovered text-content-secondary border border-border-base">
          取消
        </button>
        {mode === "single" ? (
          <button
            onClick={onCreate}
            disabled={saving || !alias.trim()}
            className={`text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 transition-all ${
              !saving && alias.trim()
                ? "bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer shadow-lg shadow-emerald-500/20"
                : "bg-elevated text-content-muted opacity-50 cursor-not-allowed"
            }`}
          >
            {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            创建
          </button>
        ) : (
          <button
            onClick={onBatchCreate}
            disabled={saving || !batchRows.some((r) => r.alias.trim())}
            className={`text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 transition-all ${
              !saving && batchRows.some((r) => r.alias.trim())
                ? "bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer shadow-lg shadow-emerald-500/20"
                : "bg-elevated text-content-muted opacity-50 cursor-not-allowed"
            }`}
          >
            {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            批量创建
          </button>
        )}
      </div>
    </ModalShell>
  );
}

/** 添加 / 编辑手动域名弹窗 */
export interface CustomDomainModalProps {
  open: boolean;
  onClose: () => void;
  saving: boolean;
  group: Account | null;
  account: CustomAccount | null;
  editing: CustomDomain | null;
  full: string;
  setFull: (v: string) => void;
  registered: string;
  setRegistered: (v: string) => void;
  expiry: string;
  setExpiry: (v: string) => void;
  remark: string;
  setRemark: (v: string) => void;
  onSave: () => void;
}

export function CustomDomainModal(props: CustomDomainModalProps) {
  const {
    open, onClose, saving, group, account, editing, full, setFull,
    registered, setRegistered, expiry, setExpiry, remark, setRemark, onSave,
  } = props;
  if (!open || !group) return null;

  return (
    <ModalShell maxWidth="max-w-md" labelledBy="custom-domain-modal-title">
      <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between border-b border-border-base flex-shrink-0">
        <h3 id="custom-domain-modal-title" className="text-lg font-bold text-content-primary flex items-center gap-2">
          <CalendarClock className="w-5 h-5 text-emerald-400" />
          {editing ? "编辑域名" : "添加域名"}
        </h3>
        <button onClick={onClose} disabled={saving} aria-label="关闭"
          className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded">
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
        <div>
          <label htmlFor="custommodals-fld4" className="block text-xs font-semibold text-content-muted mb-1.5">
            域名{account ? `（账号: ${account.name}）` : `（分组: ${group.alias}）`}
          </label>
          <Input id="custommodals-fld4" mono
            type="text" autoFocus value={full}
            onChange={(e) => setFull(e.target.value)}
            placeholder="例如：example.eu.org"
            className="w-full text-content-secondary"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className="block text-xs font-semibold text-content-muted mb-1.5">注册时间（可选）</span>
            <DateField ariaLabel="注册时间（可选）" value={registered} onChange={setRegistered} minYear={1986} maxYear={new Date().getFullYear()}
              className="w-full form-input px-3 py-2.5 rounded-lg text-sm text-content-secondary" />
          </div>
          <div>
            <span className="block text-xs font-semibold text-content-muted mb-1.5">到期时间（留空为永久）</span>
            <DateField ariaLabel="到期时间（留空为永久）" value={expiry} onChange={setExpiry} minYear={new Date().getFullYear()} maxYear={2999}
              className="w-full form-input px-3 py-2.5 rounded-lg text-sm text-content-secondary" />
          </div>
        </div>
        <div>
          <label htmlFor="custommodals-fld5" className="block text-xs font-semibold text-content-muted mb-1.5">备注（可选）</label>
          <Input id="custommodals-fld5"
            type="text" value={remark}
            onChange={(e) => setRemark(e.target.value)}
            placeholder="例如：公益免费域名，需手动续期"
            className="w-full text-content-secondary"
          />
        </div>
        <p className="text-xs text-content-muted bg-hovered border border-border-soft rounded-lg px-3 py-2">
          到期前会通过通知渠道（Webhook / Telegram）提醒你。若该域名已托管在 Cloudflare，卡片上会自动显示跳转按钮。
        </p>
      </div>
      <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-end gap-3 border-t border-border-base flex-shrink-0">
        <button onClick={onClose} disabled={saving}
          className="text-xs font-semibold px-4 py-2 rounded-lg bg-elevated hover:bg-hovered text-content-secondary border border-border-base">
          取消
        </button>
        <button
          onClick={onSave}
          disabled={saving || !full.trim()}
          className={`text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 transition-all ${
            !saving && full.trim()
              ? "bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer shadow-lg shadow-emerald-500/20"
              : "bg-elevated text-content-muted opacity-50 cursor-not-allowed"
          }`}
        >
          {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
          保存
        </button>
      </div>
    </ModalShell>
  );
}

/** 添加账号弹窗 */
export interface CustomAccountModalProps {
  open: boolean;
  onClose: () => void;
  saving: boolean;
  group: Account | null;
  name: string;
  setName: (v: string) => void;
  onSave: () => void;
}

export function CustomAccountModal(props: CustomAccountModalProps) {
  const { open, onClose, saving, group, name, setName, onSave } = props;
  if (!open || !group) return null;

  return (
    <ModalShell maxWidth="max-w-md" labelledBy="custom-account-modal-title">
      <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between border-b border-border-base flex-shrink-0">
        <h3 id="custom-account-modal-title" className="text-lg font-bold text-content-primary flex items-center gap-2">
          <UserCheck className="w-5 h-5 text-sky-400" /> 添加账号
        </h3>
        <button onClick={onClose} disabled={saving} aria-label="关闭"
          className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded">
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="p-4 sm:p-6 space-y-4">
        <div>
          <label htmlFor="custommodals-fld6" className="block text-xs font-semibold text-content-muted mb-1.5">账号名称（分组: {group.alias}）</label>
          <Input id="custommodals-fld6"
            type="text" autoFocus value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSave()}
            placeholder="例如：user1@example.com、张三、昵称"
            className="w-full text-content-secondary"
          />
          <p className="text-xs text-content-muted mt-2">
            用于把同一分组的域名按账号归组（如不同用户/邮箱注册的公益域名）。
          </p>
        </div>
      </div>
      <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-end gap-3 border-t border-border-base flex-shrink-0">
        <button onClick={onClose} disabled={saving}
          className="text-xs font-semibold px-4 py-2 rounded-lg bg-elevated hover:bg-hovered text-content-secondary border border-border-base">
          取消
        </button>
        <button
          onClick={onSave}
          disabled={saving || !name.trim()}
          className={`text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 transition-all ${
            !saving && name.trim()
              ? "bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer shadow-lg shadow-emerald-500/20"
              : "bg-elevated text-content-muted opacity-50 cursor-not-allowed"
          }`}
        >
          {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
          添加
        </button>
      </div>
    </ModalShell>
  );
}

/** 三个删除确认弹窗共用的小卡片外壳 */
function ConfirmCard({ title, body, onCancel, onConfirm, labelledBy }: {
  title: string;
  body: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  labelledBy: string;
}) {
  return (
    <ModalShell maxWidth="max-w-sm" labelledBy={labelledBy}>
      <div className="p-5">
        <div className="flex items-center gap-3 mb-3">
          <AlertTriangle className="w-6 h-6 text-red-500 shrink-0" />
          <h3 id={labelledBy} className="text-base font-bold text-content-primary">{title}</h3>
        </div>
        <p className="text-sm text-content-secondary">{body}</p>
      </div>
      <div className="bg-elevated px-5 py-4 flex items-center justify-end gap-3 border-t border-border-base rounded-b-xl">
        <button onClick={onCancel}
          className="text-xs font-semibold px-4 py-2 rounded-lg bg-elevated hover:bg-hovered text-content-secondary border border-border-base">
          取消
        </button>
        <button onClick={onConfirm}
          className="text-xs font-semibold px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-500/20">
          确认删除
        </button>
      </div>
    </ModalShell>
  );
}

/** 删除账号确认弹窗 */
export function CustomDeleteAccountModal({ account, onCancel, onConfirm }: {
  account: CustomAccount | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!account) return null;
  return (
    <ConfirmCard
      title="删除账号"
      labelledBy="custom-delete-account-title"
      body={<>确定删除账号 <b>{account.name}</b> 吗？该账号下的所有域名也会一并删除，此操作不可撤销。</>}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/** 删除分组确认弹窗 */
export function CustomDeleteGroupModal({ group, onCancel, onConfirm }: {
  group: Account | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!group) return null;
  return (
    <ConfirmCard
      title="删除分组"
      labelledBy="custom-delete-group-title"
      body={<>确定删除分组 <b>{group.alias}</b> 吗？该分组下的所有账号与域名也会一并删除，此操作不可撤销。</>}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/** 删除域名确认弹窗 */
export function CustomDeleteDomainModal({ domain, onCancel, onConfirm }: {
  domain: CustomDomain | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!domain) return null;
  return (
    <ConfirmCard
      title="删除域名"
      labelledBy="custom-delete-domain-title"
      body={<>确定删除域名 <b className="font-mono">{domain.full_domain}</b> 吗？此操作不可撤销。</>}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
