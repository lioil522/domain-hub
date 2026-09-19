/**
 * 删除域名确认弹窗（Phase 4-A，从 App.tsx 抽出）
 *
 * 不可逆操作，需用户输入完整域名二次确认。DNSHE 域名列表与 DigitalPlat
 * 域名列表共用同一个弹窗（原实现即如此，按 `account_provider` 分支文案）。
 *
 * 状态内聚：确认输入框内容、错误提示两个 useState 收进本组件；
 * 父级只保留「当前要删除哪个域名」（domain 非空即打开）。
 * 提交动作 `onConfirm` 由父级传入（删除逻辑依赖较多，仍留在 App）。
 */

import { ModalOverlay } from "../../../components/ModalOverlay";
import { useState } from "react";
import { AlertTriangle, Info, RefreshCw, Trash2, X } from "lucide-react";
import type { Domain } from "../../../types/domain";
import { toASCII, toUnicode } from "../../../punycode";

export interface DeleteDomainModalProps {
  /** 非空即打开 */
  domain: Domain | null;
  onClose: () => void;
  /** 当前 actionLoading 键（判断 `delete-${domain.id}` 是否在忙） */
  actionLoading: string | null;
  /** 提交删除；返回错误文案（null 表示成功，父级会在成功时关闭弹窗） */
  onConfirm: (confirmInput: string) => Promise<string | null> | string | null;
}

/** 输入内容是否与目标域名一致（允许输入 punycode 形式） */
export const isDeleteConfirmed = (domain: Domain, input: string) => {
  const typed = input.trim().toLowerCase();
  if (!typed) return false;
  const expected = (domain.full_domain || "").toLowerCase();
  return typed === expected || toASCII(typed).toLowerCase() === expected;
};

export function DeleteDomainModal({ domain, onClose, actionLoading, onConfirm }: DeleteDomainModalProps) {
  const [confirmInput, setConfirmInput] = useState("");
  const [error, setError] = useState("");

  if (!domain) return null;
  const isDp = domain.account_provider === "digitalplat";
  const confirmed = isDeleteConfirmed(domain, confirmInput);
  const busy = actionLoading === `delete-${domain.id}`;

  return (
    <ModalOverlay>
      <div role="dialog" aria-labelledby="delete-domain-modal-title" className="bg-surface border border-rose-200 dark:border-rose-900/60 w-full max-w-lg max-h-[90dvh] rounded-2xl overflow-hidden flex flex-col shadow-2xl">
        {/* 头部 */}
        <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between gap-2 border-b border-border-base flex-shrink-0">
          <div className="min-w-0">
            <h3 id="delete-domain-modal-title" className="text-lg font-bold text-content-primary flex items-center gap-2">
              <Trash2 className="text-rose-400 w-5 h-5 flex-shrink-0" />
              删除域名
            </h3>
            <p className="text-xs text-content-muted mt-0.5 font-mono truncate">
              {toUnicode(domain.full_domain)}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded flex-shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 内容 */}
        <div className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
          <div className="p-4 rounded-xl border border-rose-200 bg-rose-50 text-sm text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-200 flex gap-3">
            <AlertTriangle className="w-5 h-5 shrink-0 text-rose-600 dark:text-rose-400 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold">此操作不可逆</p>
              {isDp ? (
                <p className="text-xs text-rose-700/90 dark:text-rose-300/90 leading-relaxed">
                  提交删除后 DNS 立即停用，域名进入 <span className="font-medium">pendingdelete</span>{" "}
                  状态，7 天后正式释放、可被重新注册，期间无法取消。
                </p>
              ) : (
                <p className="text-xs text-rose-700/90 dark:text-rose-300/90 leading-relaxed">
                  删除后域名将立即释放，可能被他人抢注，且无法恢复。
                </p>
              )}
            </div>
          </div>

          <div className="p-4 rounded-xl border border-border-base bg-hovered text-xs text-content-secondary leading-relaxed">
            <p className="font-semibold text-content-primary mb-1.5 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-content-muted" /> {isDp ? "DigitalPlat 删除说明" : "上游限制说明"}
            </p>
            {isDp ? (
              <p className="text-content-muted">
                域名提交删除后会被 DigitalPlat 保留 <span className="text-content-secondary font-medium">7 天</span>{" "}
                直至正式释放，期间面板上会以「待删除」徽标展示。相关限制以 DigitalPlat 上游返回为准，
                如被拒绝请按返回提示处理后重试。
              </p>
            ) : (
              <p className="text-content-muted">
                域名存在<span className="text-content-secondary font-medium">解析记录历史</span>，
                或处于<span className="text-content-secondary font-medium">转赠、ServerHold、PendingDelete</span> 等状态时，
                上游不支持删除操作。此限制无法绕过，如被拒绝请按提示处理后重试。
              </p>
            )}
          </div>

          <div>
            <label htmlFor="deletedomainmodal-fld1" className="text-xs text-content-muted font-medium block mb-1.5">
              请输入完整域名以确认删除：
              <span className="font-mono text-content-primary ml-1">
                {toUnicode(domain.full_domain)}
              </span>
            </label>
            <input id="deletedomainmodal-fld1"
              autoFocus
              value={confirmInput}
              onChange={(e) => { setConfirmInput(e.target.value); setError(""); }}
              placeholder="在此输入完整域名"
              className="w-full bg-elevated border border-border-base rounded-lg px-3 py-2 text-sm font-mono text-content-primary focus:outline-none focus:border-rose-700"
            />
          </div>

          {error && (
            <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300 flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-end gap-3 border-t border-border-base flex-shrink-0">
          <button
            onClick={onClose}
            className="text-xs font-semibold px-4 py-2 rounded-lg bg-elevated hover:bg-hovered text-content-secondary border border-border-base"
          >
            取消
          </button>
          <button
            onClick={async () => {
              setError("");
              const err = await onConfirm(confirmInput);
              if (err) setError(err);
            }}
            disabled={busy || !confirmed}
            className={`text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 transition-all ${
              confirmed && !busy
                ? "bg-rose-600 hover:bg-rose-500 text-white cursor-pointer"
                : "bg-elevated text-content-muted opacity-50 cursor-not-allowed"
            }`}
          >
            {busy ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
            确认删除
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
