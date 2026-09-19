/**
 * 账号编辑弹窗（Phase 3-B，从 App.tsx 抽出并去重）
 *
 * WHY 合并：App.tsx 里原有 4 个几乎逐字相同的编辑弹窗 ——
 *   DNSHE「修改账号」、Cloudflare「编辑 Cloudflare 账号」、
 *   DigitalPlat「编辑 DigitalPlat 账号」、四个新托管商（表驱动）共用一份。
 * 四者的 DOM 结构、取消/保存按钮、加载态完全一致，差异仅在
 * 「标题 / 图标 / 凭据字段数量与文案 / name 属性」。
 * 按铁律 3（禁止制造重复实现）合并为这一个表驱动组件。
 *
 * 状态内聚：4 个弹窗各自的「别名 / 凭据1 / 凭据2」共 12 个 useState 全部收进本组件，
 * 父级只保留「当前编辑哪个账号」（account 非空即打开）。
 *
 * 行为保持：打开时别名预填、凭据清空（父级以 `{account && <EditAccountModal/>}` 挂载，
 * 关闭即卸载，因此每次打开都是全新实例，useState 初值即「预填 + 清空」）。
 */

import { ModalOverlay } from "../../../components/ModalOverlay";
import { Input } from "../../../components/form/Input";
import { useState, type ReactNode } from "react";
import { RefreshCw, Save, X } from "lucide-react";
import type { Account } from "../../../types/account";
import { PasswordInput } from "../../../components/form/PasswordInput";

/** 单个凭据字段的渲染配置（className 逐字保留原值，避免任何视觉漂移） */
export interface EditFieldSpec {
  label: string;
  /** 输入框 name 属性（用于规避浏览器自动填充，逐字保留原值） */
  name: string;
  placeholder?: string;
  /** true 走 PasswordInput（带显隐切换），false 走普通文本框 */
  secret?: boolean;
  /** 仅新托管商的主凭据设了 false */
  spellCheck?: boolean;
  className: string;
}

export interface EditAccountModalProps {
  /** 非空即打开 */
  account: Account | null;
  onClose: () => void;
  title: string;
  /** 标题图标（DNSHE 用 Settings，其余用 Pencil） */
  icon: ReactNode;
  /** 当前 actionLoading 键前缀，实际判断 `${actionKeyPrefix}-${account.id}` */
  actionKeyPrefix: string;
  actionLoading: string | null;
  /** 提交：回传三个字段当前值（凭据为空串表示「保持不变」） */
  onSave: (fields: { alias: string; primary: string; secondary: string }) => void | Promise<void>;
  /** 别名输入框 name */
  aliasName: string;
  /** 主凭据（可选；单凭据型托管商没有） */
  primary?: EditFieldSpec;
  /** 次凭据（DNSHE 的 API Secret / CF 的 Token / DP 的 Key / 新托管商的 secondary） */
  secondary?: EditFieldSpec;
  /** 底部说明文案 */
  note: string;
}

export function EditAccountModal(props: EditAccountModalProps) {
  const { account, onClose, title, icon, actionKeyPrefix, actionLoading, onSave, aliasName, primary, secondary, note } = props;

  // 挂载即预填别名、清空凭据（父级关闭时卸载本组件，故每次打开都是新实例）
  const [alias, setAlias] = useState(account?.alias ?? "");
  const [primaryVal, setPrimaryVal] = useState("");
  const [secondaryVal, setSecondaryVal] = useState("");

  if (!account) return null;
  const busy = actionLoading === `${actionKeyPrefix}-${account.id}`;

  const renderField = (spec: EditFieldSpec, value: string, setValue: (v: string) => void) => (
    <div>
      <label htmlFor="editaccountmodal-fld1" className="block text-xs font-semibold text-content-muted mb-1.5">{spec.label}</label>
      {spec.secret ? (
        <PasswordInput id="editaccountmodal-fld1"
          name={spec.name}
          autoComplete="new-password"
          value={value}
          onChange={setValue}
          placeholder={spec.placeholder}
          className={spec.className}
        />
      ) : (
        <input
          type="text"
          name={spec.name}
          autoComplete="off"
          spellCheck={spec.spellCheck}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={spec.placeholder}
          className={spec.className}
        />
      )}
    </div>
  );

  return (
    <ModalOverlay>
      {/* NOTE: max-h + flex-col + 正文 overflow-y-auto 三件套缺一不可 —— 少了 max-h，
          内容超过屏高时会被 overflow-hidden 直接裁掉且滚不到（手机上尤其明显） */}
      <div role="dialog" aria-labelledby="edit-account-modal-title" className="bg-surface border border-border-base w-full max-w-md max-h-[90dvh] rounded-xl overflow-hidden flex flex-col shadow-2xl">
        <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between border-b border-border-base flex-shrink-0">
          <h3 id="edit-account-modal-title" className="text-lg font-bold text-content-primary flex items-center gap-1.5">
            {icon} {title}
          </h3>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
          {/* NOTE: 这些输入框必须显式标注 autoComplete 与不像凭据的 name。
              缺了这些提示，Chrome 密码管理器会把「API Secret」当成登录密码框，
              再顺手把它上方最近的文本框（API Key）当成用户名一起填上——于是
              只想改个别名时，两个密钥框会被静默填成登录用户名与登录密码。
              这不只是要手动清空的麻烦：更新逻辑见到两个框都非空就认定「要换密钥」，
              把填进去的登录凭据当新密钥送去校验，结果是改别名直接失败在
              「无法验证新 API 密钥有效性」上。
              和设置页的密码表单同一套解法：把密码框标成 new-password，表单内
              就不存在可填充的凭据目标，Chrome 不会发起这次成对填充。 */}
          <div>
            <label htmlFor="editaccountmodal-fld2" className="block text-xs font-semibold text-content-muted mb-1.5">账户别名</label>
            <Input id="editaccountmodal-fld2"
              type="text"
              name={aliasName}
              autoComplete="off"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="账户别名"
              className="w-full text-content-secondary"
            />
          </div>
          {primary && renderField(primary, primaryVal, setPrimaryVal)}
          {secondary && renderField(secondary, secondaryVal, setSecondaryVal)}
          <p className="text-[11px] text-content-muted leading-relaxed">{note}</p>

          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              className="flex-1 bg-elevated hover:bg-hovered text-content-muted border border-border-base px-4 py-2 rounded-lg text-sm"
            >
              取消
            </button>
            <button
              onClick={() => void onSave({ alias, primary: primaryVal, secondary: secondaryVal })}
              disabled={busy}
              className="flex-1 btn-primary px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              {busy ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <Save className="w-4 h-4" /> 保存修改
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </ModalOverlay>
  );
}
