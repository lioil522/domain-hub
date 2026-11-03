import { Cloud } from "lucide-react";
import type { BindProviderSchema } from "./types";

export const CF_SCHEMA: BindProviderSchema = {
  singleAction: "cf-add-account",
  batchAction: "cf-batch-add-accounts",
  formKey: "cloudflare",
  singleUsesForm: false,
  aliasLabel: "账户别名（可选，留空自动解析）",
  aliasName: "cf-bind-alias",
  aliasPlaceholder: "留空将使用 Cloudflare 账号名称",
  fields: [
    { field: "token", label: "API Token", placeholder: "粘贴 Cloudflare API Token", component: "passwordInput", name: "cf-bind-token", autoComplete: "new-password", mono: true },
  ],
  singleHint: (
    <p className="text-[11px] text-content-muted leading-relaxed">
      在 Cloudflare 控制台「My Profile → API Tokens」创建 Token，权限需包含
      <span className="font-mono text-content-secondary"> Zone:Read </span>与
      <span className="font-mono text-content-secondary"> Zone DNS:Edit</span>
      。Token 仅用于调用 Cloudflare 官方 API，绑定后会加密存储并校验有效性。
    </p>
  ),
  footerKind: "duo",
  submitLabel: "验证并绑定账号",
  submitIcon: Cloud,
  single: {
    body: (v) => ({ provider: "cloudflare", alias: v.alias.trim(), api_token: v.token.trim() }),
    validate: (v) => (!v.token?.trim() ? "请填写 Cloudflare API Token" : null),
    // CF 成功分支不弹 toast（原实现如此）→ successToast 缺省
    onSuccess: async (data, _v, deps) => {
      await deps.fetchAccounts();
      if (data.account?.id) {
        await deps.waitForAccountDomainSync([Number(data.account.id)], "Cloudflare 账号绑定成功", undefined, () => "cloudflare");
      } else {
        await deps.fetchCfZones();
      }
    },
    errorFallback: "绑定 Cloudflare 账号失败",
    catchToast: "绑定 Cloudflare 账号请求失败",
  },
  batch: {
    batchIntro: (
      <p className="text-xs text-content-muted leading-relaxed">
        每行填入一个 <span className="font-mono text-sky-400">API Token</span>（用空格 / Tab / 逗号 / 竖线分隔），可选择性跟随别名：
        <span className="font-mono text-content-secondary">token 你的别名</span>。别名留空自动使用 Cloudflare 账号名称。
      </p>
    ),
    batchPlaceholder: "cfut_xxxxxxxxxxxx1 别名A\ncfut_xxxxxxxxxxxx2 别名B\ncfut_xxxxxxxxxxxx3",
    batchResizable: false,
    parse: (input) => {
      const lines = input.split(/[\n;；]+/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      const parsed: Array<Record<string, string>> = [];
      let invalidLines = 0;
      for (const line of lines) {
        const parts = line.split(/[\s,，|]+/).map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 1) {
          parsed.push({ api_token: parts[0], alias: parts.length >= 2 ? parts.slice(1).join(" ") : "" });
        } else {
          invalidLines++;
        }
      }
      return { parsed, invalidLines, lineCount: lines.length };
    },
    emptyToast: "请至少输入一条 Cloudflare API Token",
    invalidLineMsg: (n) => `${n} 行格式不正确（每行需包含 API Token），已自动跳过`,
    invalidToast: "未能解析出任何有效的账号信息，请检查输入格式",
    successToast: (data) => ({ level: data.fail_count === 0 ? "success" : "warning", msg: data.message || "批量绑定完成" }),
    onSuccess: async (data, deps) => {
      await deps.fetchAccounts();
      const ids: number[] = (data.account_ids || []).map(Number);
      if (ids.length > 0) {
        // 后台逐个同步 zones，落库后自动刷新（fetchCfZones 在等待函数末尾统一调用）
        await deps.waitForAccountDomainSync(ids, `${ids.length} 个 Cloudflare 账号绑定成功`, undefined, () => "cloudflare");
      } else {
        await deps.fetchCfZones();
      }
    },
    errorFallback: "批量绑定失败",
    catchToast: "批量绑定请求发送失败，请检查网络",
    maxCountCheck: "parsed",
    buildBody: (parsed) => ({ provider: "cloudflare", accounts: parsed }),
  },
};
