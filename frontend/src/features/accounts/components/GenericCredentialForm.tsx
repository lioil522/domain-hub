/**
 * 绑定账号弹窗 —— 通用「单个绑定」表单（UI 优化方案 P1）
 *
 * 由 `BindProviderSchema` + 一组受控值（别名 + 各凭据字段）驱动，7 家托管商共用
 * 同一份渲染逻辑。原先每个 provider 一段 JSX 的地方，现在只剩一行调用。
 *
 * NOTE: 纯展示，不含任何请求逻辑；提交/校验回调由编排层注入。
 * DOM / className / 文案（label、placeholder、提示）全部来自 schema，与原实现逐字一致。
 */

import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { PasswordInput } from "../../../components/form/PasswordInput";
import { Input } from "../../../components/form/Input";
import type { BindFieldSpec, BindProviderSchema } from "./BIND_FORM_SCHEMA";

export interface GenericCredentialFormProps {
  schema: BindProviderSchema;
  actionLoading: string | null;

  alias: string;
  setAlias: (v: string) => void;
  values: Record<string, string>;
  setValue: (field: string, v: string) => void;

  onSubmit: () => void;
  onCancel: () => void;
}

function renderField(f: BindFieldSpec, value: string, setValue: (field: string, v: string) => void): ReactNode {
  // 宽度/文字色由调用处给出（与迁移前逐字一致）：w-full + text-content-secondary
  const cls = `w-full text-content-secondary`;
  if (f.component === "passwordInput") {
    return (
      <PasswordInput
        ariaLabel={f.label}
        required={f.required}
        name={f.name}
        autoComplete={f.autoComplete}
        placeholder={f.placeholder}
        value={value}
        onChange={(v) => setValue(f.field, v)}
        className={`form-input px-3 py-2.5 rounded-lg text-sm${f.mono ? " font-mono" : ""} ${cls}`}
      />
    );
  }
  return (
    <Input
      aria-label={f.label}
      type={f.component === "passwordRaw" ? "password" : "text"}
      required={f.required}
      name={f.name}
      autoComplete={f.autoComplete}
      spellCheck={f.spellCheck}
      placeholder={f.placeholder}
      value={value}
      onChange={(e) => setValue(f.field, e.target.value)}
      mono={f.mono}
      className={cls}
    />
  );
}

export function GenericCredentialForm({
  schema,
  actionLoading,
  alias,
  setAlias,
  values,
  setValue,
  onSubmit,
  onCancel,
}: GenericCredentialFormProps) {
  const busy = actionLoading === schema.singleAction;

  const body = (
    <>
      <div>
        <label htmlFor="genericcredentialform-fld1" className="block text-xs font-semibold text-content-muted mb-1.5">{schema.aliasLabel}</label>
        <Input id="genericcredentialform-fld1"
          type="text"
          name={schema.aliasName}
          autoComplete="off"
          placeholder={schema.aliasPlaceholder}
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          className="w-full text-content-secondary"
        />
      </div>

      {schema.fields.map((f) => (
        <div key={f.field}>
          <span className="block text-xs font-semibold text-content-muted mb-1.5">{f.label}</span>
          {renderField(f, values[f.field] ?? "", setValue)}
        </div>
      ))}

      {schema.singleHint}
    </>
  );

  // 页脚：duo =「取消 + 提交」两按钮；solo = 单个整宽提交按钮
  const footer =
    schema.footerKind === "duo" ? (
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 bg-elevated hover:bg-hovered text-content-muted border border-border-base px-4 py-2 rounded-lg text-sm"
        >
          取消
        </button>
        <button
          type={schema.singleUsesForm ? "submit" : "button"}
          onClick={schema.singleUsesForm ? undefined : onSubmit}
          disabled={busy}
          className="flex-1 btn-primary px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-1.5 disabled:opacity-50"
        >
          {busy ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : (
            <>
              <schema.submitIcon className="w-4 h-4" /> {schema.submitLabel}
            </>
          )}
        </button>
      </div>
    ) : (
      <button
        onClick={onSubmit}
        disabled={busy}
        className="w-full btn-primary py-2.5 rounded-lg font-semibold text-sm text-white flex items-center justify-center gap-2 disabled:opacity-50"
      >
        {busy ? (
          <>
            <RefreshCw className="w-4 h-4 animate-spin" /> {schema.submitLoadingText}
          </>
        ) : (
          <>
            <schema.submitIcon className="w-4 h-4" /> {schema.submitLabel}
          </>
        )}
      </button>
    );

  // DNSHE 用真 <form onSubmit>，其余为普通 div + 按钮点击（与原实现一致）
  if (schema.singleUsesForm) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="space-y-4 pt-1"
      >
        {body}
        {footer}
      </form>
    );
  }

  return (
    <div className="space-y-4 pt-1">
      {body}
      {footer}
    </div>
  );
}
