import { Plus } from "lucide-react";
import type { BindProviderSchema } from "./types";

export const DNSHE_SCHEMA: BindProviderSchema = {
  singleAction: "add-account",
  batchAction: "batch-add-accounts",
  formKey: "dnshe",
  singleUsesForm: true,
  aliasLabel: "账户别名 (可选，留空自动解析)",
  aliasName: "dnshe-bind-alias",
  aliasPlaceholder: "如：主账号、测试组",
  fields: [
    { field: "apiKey", label: "API Key", placeholder: "cfsd_xxxxxxxxxx", component: "text", name: "dnshe-bind-api-key", autoComplete: "off", required: true, mono: true },
    { field: "apiSecret", label: "API Secret", placeholder: "请输入 API Secret", component: "passwordInput", name: "dnshe-bind-api-secret", autoComplete: "new-password", required: true },
  ],
  singleHint: (
    <p className="text-[11px] text-content-muted leading-relaxed">
      别名留空时，系统会自动调用 DNSHE 密钥列表接口获取该 Key 的名称作为别名。
    </p>
  ),
  footerKind: "duo",
  submitLabel: "验证并绑定账号",
  submitIcon: Plus,
  single: {
    body: (v) => ({ alias: v.alias, api_key: v.apiKey, api_secret: v.apiSecret }),
    validate: (v) => (!v.apiKey?.trim() || !v.apiSecret?.trim() ? "API Key 与 API Secret 为必填项！" : null),
    successToast: (data, v) => `账号 [${data.account?.alias || v.alias || v.apiKey}] 验证并绑定成功！`,
    // 原实现：fetchAccounts() 与 waitForAccountDomainSync(...) 均不 await（fire-and-forget）
    onSuccess: (data, v, deps) => {
      deps.fetchAccounts();
      deps.waitForAccountDomainSync([Number(data.account?.id)], `账号 [${data.account?.alias || v.apiKey}] 绑定成功`);
    },
    errorFallback: "账号绑定失败，请检查密钥是否正确",
    catchToast: "绑定请求发送失败，请检查网络",
  },
  batch: {
    batchIntro: (
      <p className="text-xs text-content-muted leading-relaxed">
        每行填入一组 <span className="font-mono text-accent">API Key + API Secret</span>（用空格 / Tab / 逗号分隔），别名自动从 API Key 解析，无需填写。
      </p>
    ),
    batchPlaceholder: "cfsd_xxxxxxxx1 你的secret1\ncfsd_xxxxxxxx2 你的secret2\ncfsd_xxxxxxxx3,你的secret3",
    batchResizable: true,
    parse: (input) => {
      const lines = input.split(/[\n;；]+/).map((l) => l.trim()).filter(Boolean);
      let parsed: Array<Record<string, string>> = [];
      let invalidLines = 0;
      // 兼容 JSON 数组格式：[{"api_key":"cfsd_xx","api_secret":"yy","alias":"可选"}]
      try {
        const jsonParsed = JSON.parse(input.trim());
        if (Array.isArray(jsonParsed) && jsonParsed.length > 0 && jsonParsed[0]?.api_key) {
          parsed = jsonParsed.map((it) => ({
            alias: it.alias ? String(it.alias).trim() : "",
            api_key: String(it.api_key).trim(),
            api_secret: String(it.api_secret).trim(),
          }));
        }
      } catch {
        // 非 JSON，走逐行解析
      }
      if (parsed.length === 0) {
        for (const line of lines) {
          const parts = line.split(/[\s,，|]+/).map((p) => p.trim()).filter(Boolean);
          if (parts.length >= 2) {
            parsed.push({ api_key: parts[0], api_secret: parts[1], alias: parts.length >= 3 ? parts.slice(2).join(" ") : "" });
          } else {
            invalidLines++;
          }
        }
      }
      return { parsed, invalidLines, lineCount: lines.length };
    },
    emptyToast: "请先粘贴至少一条 API Key 与 API Secret",
    invalidLineMsg: (n) => `${n} 行格式不正确（每行需包含 API Key 与 API Secret），已自动跳过`,
    invalidToast: "未能解析出任何有效的账号信息，请检查输入格式",
    successToast: (data) => ({ level: "success", msg: data.message || "批量绑定完成" }),
    onSuccess: (data, deps) => {
      deps.fetchAccounts();
      deps.waitForAccountDomainSync((data.account_ids || []).map(Number), `${(data.account_ids || []).length} 个账号绑定成功`);
    },
    errorFallback: "批量绑定失败",
    catchToast: "批量绑定请求发送失败，请检查网络",
    maxCountCheck: "raw",
    buildBody: (parsed) => ({ accounts: parsed }),
  },
};
