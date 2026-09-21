import { Globe } from "lucide-react";
import type { BindProviderSchema } from "./types";
import { toAccountIds } from "./types";

export const DP_SCHEMA: BindProviderSchema = {
  singleAction: "dp-add-account",
  batchAction: "dp-batch-add-accounts",
  formKey: "digitalplat",
  singleUsesForm: false,
  aliasLabel: "账户别名（可选）",
  aliasName: "dp-bind-alias",
  aliasPlaceholder: "留空将使用 DigitalPlat ••••尾号",
  fields: [
    { field: "key", label: "API Key", placeholder: "粘贴 DigitalPlat API Key（dp_live_ / dp_test_ 开头）", component: "passwordInput", name: "dp-bind-key", autoComplete: "new-password", mono: true },
  ],
  singleHint: (
    <p className="text-[11px] text-content-muted leading-relaxed">
      在 DigitalPlat 控制台「API 密钥」页创建 API Key。Key 明文只在创建时显示一次，绑定后会加密存储并校验有效性。
    </p>
  ),
  footerKind: "duo",
  submitLabel: "验证并绑定账号",
  submitIcon: Globe,
  single: {
    body: (v) => ({ provider: "digitalplat", alias: v.alias.trim(), api_key: v.key.trim() }),
    validate: (v) => (!v.key?.trim() ? "请填写 DigitalPlat API Key" : null),
    // DP 成功分支不弹 toast（原实现如此）→ successToast 缺省
    onSuccess: async (data, _v, deps) => {
      await deps.fetchAccounts();
      if (data.account?.id) {
        await deps.waitForAccountDomainSync([Number(data.account.id)], "DigitalPlat 账号绑定成功", undefined, () => "digitalplat");
      } else {
        await deps.fetchDpDomains();
      }
    },
    errorFallback: "绑定 DigitalPlat 账号失败",
    catchToast: "绑定 DigitalPlat 账号请求失败",
  },
  batch: {
    batchIntro: (
      <p className="text-xs text-content-muted leading-relaxed">
        每行填入一个 <span className="font-mono text-sky-400">API Key</span>（用空格 / Tab / 逗号 / 竖线分隔），可选择性跟随别名：
        <span className="font-mono text-content-secondary">dp_live_xxx 别名A</span>。别名留空自动使用 Key 尾号。
      </p>
    ),
    batchPlaceholder: "dp_live_xxxxxxxxxxxx1 别名A\ndp_live_xxxxxxxxxxxx2 别名B\ndp_live_xxxxxxxxxxxx3",
    batchResizable: false,
    parse: (input) => {
      const lines = input.split(/[\n;；]+/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      const parsed: Array<Record<string, string>> = [];
      let invalidLines = 0;
      for (const line of lines) {
        const parts = line.split(/[\s,，|]+/).map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 1) {
          parsed.push({ api_key: parts[0], alias: parts.length >= 2 ? parts.slice(1).join(" ") : "" });
        } else {
          invalidLines++;
        }
      }
      return { parsed, invalidLines, lineCount: lines.length };
    },
    emptyToast: "请至少输入一条 DigitalPlat API Key",
    invalidLineMsg: (n) => `${n} 行格式不正确（每行需包含 API Key），已自动跳过`,
    invalidToast: "未能解析出任何有效的账号信息，请检查输入格式",
    // DP 批量成功分支不弹 toast（原实现如此）→ successToast 缺省
    onSuccess: async (data, deps) => {
      await deps.fetchAccounts();
      if (Array.isArray(data.account_ids) && data.account_ids.length > 0) {
        await deps.waitForAccountDomainSync(toAccountIds(data.account_ids), `${data.success_count} 个 DigitalPlat 账号绑定成功`, undefined, () => "digitalplat");
      } else {
        await deps.fetchDpDomains();
      }
    },
    errorFallback: "批量绑定失败",
    catchToast: "批量绑定请求失败",
    maxCountCheck: "parsed",
    buildBody: (parsed) => ({ provider: "digitalplat", accounts: parsed }),
  },
};

/** 四家新托管商（DNSPod / 阿里云 / 华为云 / Vercel）由 MULTI_PROVIDER_META 派生 */
