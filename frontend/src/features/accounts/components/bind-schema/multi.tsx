import { Plus } from "lucide-react";
import type { MultiProviderKey } from "../../../../types/provider";
import { MULTI_PROVIDER_META } from "../../../providers/providerMeta";
import type { BindProviderSchema, BindFieldSpec } from "./types";
import { toAccountIds } from "./types";

export function multiSchema(key: MultiProviderKey): BindProviderSchema {
  const meta = MULTI_PROVIDER_META[key];
  const fields: BindFieldSpec[] = [];
  if (!meta.singleCredential) {
    fields.push({ field: "primary", label: meta.primaryLabel, placeholder: `请输入 ${meta.primaryLabel}`, component: "text", name: `${key}-bind-primary`, autoComplete: "off", mono: true, spellCheck: false });
  }
  fields.push({ field: "secondary", label: meta.secondaryLabel, placeholder: `请输入 ${meta.secondaryLabel}`, component: "passwordRaw", name: `${key}-bind-secondary`, autoComplete: "new-password", mono: true, spellCheck: false });

  return {
    singleAction: `multi-add-${key}`,
    batchAction: `multi-batch-${key}`,
    formKey: "multi",
    singleUsesForm: false,
    aliasLabel: "账户别名 (可选，留空自动生成)",
    aliasName: `${key}-bind-alias`,
    aliasPlaceholder: `如：${meta.label} 主账号`,
    fields,
    singleHint: (
      <p className="text-[11px] text-content-muted leading-relaxed bg-elevated border border-border-base rounded-lg p-3">
        {meta.credentialHint}
      </p>
    ),
    footerKind: "solo",
    submitLabel: "验证并绑定",
    submitIcon: Plus,
    submitLoadingText: "正在验证凭据…",
    single: {
      body: (v) => {
        // 单凭据型（Vercel）只送 secondary；双凭据型两个都送（primary 为空串）
        const primary = meta.singleCredential ? "" : (v.primary ?? "").trim();
        return { provider: key, alias: (v.alias ?? "").trim(), api_key: primary, api_secret: (v.secondary ?? "").trim() };
      },
      validate: (v) => {
        if (meta.singleCredential) {
          return !(v.secondary ?? "").trim() ? `请填写 ${meta.secondaryLabel}` : null;
        }
        if (!(v.primary ?? "").trim() || !(v.secondary ?? "").trim()) {
          return `${meta.primaryLabel} 与 ${meta.secondaryLabel} 均为必填项！`;
        }
        return null;
      },
      successToast: () => `${meta.label} 账号绑定成功！`,
      onSuccess: async (data, _v, deps) => {
        await deps.fetchAccounts();
        if (data.account?.id) {
          await deps.waitForAccountDomainSync([Number(data.account.id)], `${meta.label} 账号绑定成功`, undefined, () => key);
        } else {
          await deps.fetchMultiProviderDomains(key);
        }
      },
      errorFallback: `${meta.label} 账号绑定失败`,
      catchToast: `绑定 ${meta.label} 账号请求失败`,
    },
    batch: {
      batchIntro: (
        <p className="text-xs text-content-muted leading-relaxed">
          每行填入一组凭据：<span className="font-mono text-sky-400">{meta.batchHint}</span>。
          别名留空时自动使用凭据尾号。
        </p>
      ),
      batchPlaceholder: meta.batchHint,
      batchExtraHint: (
        <p className="text-[11px] text-content-muted leading-relaxed bg-elevated border border-border-base rounded-lg p-3">
          {meta.credentialHint}
        </p>
      ),
      batchResizable: false,
      parse: (input) => {
        const lines = input.split(/[\n;；]+/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
        const parsed: Array<Record<string, string>> = [];
        let invalidLines = 0;
        for (const line of lines) {
          const parts = line.split(/[,，|\s]+/).map((p) => p.trim()).filter(Boolean);
          if (meta.singleCredential) {
            // 单凭据型：Token[,别名]
            if (parts.length >= 1) {
              parsed.push({ api_key: "", api_secret: parts[0], alias: parts.length >= 2 ? parts.slice(1).join(" ") : "" });
            } else {
              invalidLines++;
            }
          } else {
            // 双凭据型：凭据1,凭据2[,别名]
            if (parts.length >= 2) {
              parsed.push({ api_key: parts[0], api_secret: parts[1], alias: parts.length >= 3 ? parts.slice(2).join(" ") : "" });
            } else {
              invalidLines++;
            }
          }
        }
        return { parsed, invalidLines, lineCount: lines.length };
      },
      emptyToast: `请至少输入一条 ${meta.label} 凭据`,
      invalidLineMsg: (n) => `${n} 行格式不正确，已自动跳过`,
      invalidToast: "未能解析出任何有效的账号信息，请检查输入格式",
      // multi 批量成功分支不弹 toast（原实现如此）→ successToast 缺省
      onSuccess: async (data, deps) => {
        await deps.fetchAccounts();
        if (Array.isArray(data.account_ids) && data.account_ids.length > 0) {
          await deps.waitForAccountDomainSync(toAccountIds(data.account_ids), `${data.success_count} 个 ${meta.label} 账号绑定成功`, undefined, () => key);
        } else {
          await deps.fetchMultiProviderDomains(key);
        }
      },
      errorFallback: "批量绑定失败",
      catchToast: "批量绑定请求失败",
      maxCountCheck: "parsed",
      buildBody: (parsed) => ({ provider: key, accounts: parsed }),
    },
  };
}
