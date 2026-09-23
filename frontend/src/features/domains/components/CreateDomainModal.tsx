import { useState } from "react";
import {
  Globe,
  X,
  CheckCircle2,
  Copy,
  Check,
  Server,
  AlertCircle,
  Loader2,
  Plus,
} from "lucide-react";
import { ModalOverlay } from "../../../components/ModalOverlay";
import { CustomSelect } from "../../../components/form/CustomSelect";
import { Button } from "../../../components/Button";
import { domainsApi } from "../../../api/endpoints/domains";
import { useAppData } from "../../../state/AppDataContext";
import type { Account } from "../../../types/account";
import type { Domain } from "../../../types/domain";

export interface CreateDomainModalProps {
  open: boolean;
  onClose: () => void;
  accounts: Account[];
  /** 默认预选的账号 ID（若从某个提供商页面打开） */
  defaultAccountId?: number;
  /** 创建成功后的回调（通常用于重新拉取域名列表） */
  onSuccess?: (newDomain?: Domain) => void;
  /** 点击「立即配置解析」的回调 */
  onOpenDns?: (domain: Domain) => void;
}

const SUPPORTED_PROVIDERS = new Set([
  "dnspod",
  "cloudflare",
  "alidns",
  "huaweicloud",
  "vercel",
]);

const PROVIDER_LABELS: Record<string, string> = {
  dnspod: "DNSPod",
  cloudflare: "Cloudflare",
  alidns: "阿里云 DNS",
  huaweicloud: "华为云 DNS",
  vercel: "Vercel",
};

export function CreateDomainModal({
  open,
  onClose,
  accounts,
  defaultAccountId,
  onSuccess,
  onOpenDns,
}: CreateDomainModalProps) {
  const { apiFetch, showToast } = useAppData();

  // 过滤出支持添加域名的账号列表
  const supportedAccounts = accounts.filter((a) =>
    SUPPORTED_PROVIDERS.has(a.provider || "")
  );

  const initialAccountId =
    defaultAccountId && supportedAccounts.some((a) => a.id === defaultAccountId)
      ? defaultAccountId
      : supportedAccounts[0]?.id || 0;

  const [selectedAccountId, setSelectedAccountId] = useState<number>(initialAccountId);
  const [domainInput, setDomainInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 成功状态
  const [createdResult, setCreatedResult] = useState<{
    domain: Domain;
    nameservers: string[];
    message: string;
  } | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  if (!open) return null;

  const handleCopyNs = async (ns: string, index: number) => {
    try {
      await navigator.clipboard.writeText(ns);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
      showToast("success", `已复制: ${ns}`);
    } catch {
      showToast("error", "复制失败，请手动选取复制");
    }
  };

  const handleCopyAllNs = async (nsList: string[]) => {
    try {
      await navigator.clipboard.writeText(nsList.join("\n"));
      showToast("success", "已复制全部 DNS 服务器地址");
    } catch {
      showToast("error", "复制失败");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const domain = domainInput.trim().toLowerCase();
    if (!domain) {
      setErrorMsg("请输入要添加的域名");
      return;
    }
    if (!selectedAccountId) {
      setErrorMsg("请选择要绑定的账号");
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await domainsApi.create(apiFetch, {
        account_id: selectedAccountId,
        domain,
      });

      if (res.success && res.domain) {
        showToast("success", res.message || "域名添加成功！");
        setCreatedResult({
          domain: res.domain,
          nameservers: res.nameservers || [],
          message: res.message || "域名添加成功！",
        });
        if (onSuccess) {
          onSuccess(res.domain);
        }
      } else {
        throw new Error(res.message || "添加域名失败");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "添加域名失败，请重试";
      setErrorMsg(msg);
      showToast("error", msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetAndClose = () => {
    setDomainInput("");
    setCreatedResult(null);
    setErrorMsg(null);
    onClose();
  };

  return (
    <ModalOverlay>
      <div className="relative w-full max-w-lg bg-surface border border-border-base rounded-2xl shadow-2xl p-6 sm:p-7 overflow-hidden text-content-primary animate-in fade-in zoom-in-95 duration-200">
        {/* 背景光晕微装饰 */}
        <div className="absolute -top-20 -right-20 w-44 h-44 bg-accent/10 rounded-full blur-3xl pointer-events-none" />

        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between pb-4 border-b border-border-base mb-5">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-accent/15 text-accent border border-accent/20 flex-shrink-0">
              <Globe className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-content-primary">
                添加域名托管
              </h3>
              <p className="text-xs text-content-muted mt-0.5">
                支持添加主域（如 example.com）或子域（如 a.test.com）
              </p>
            </div>
          </div>
          <button
            onClick={handleResetAndClose}
            className="p-1.5 rounded-lg text-content-muted hover:text-content-primary hover:bg-hovered transition-colors"
            title="关闭"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 内容展示：成功结果页 */}
        {createdResult ? (
          <div className="space-y-5">
            <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/25 flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" />
              <div>
                <h4 className="text-sm font-bold text-emerald-300">
                  {createdResult.message}
                </h4>
                <p className="text-xs text-content-secondary mt-1">
                  域名 <span className="font-mono font-semibold text-content-primary">{createdResult.domain.full_domain}</span> 已成功添加到服务商并自动同步至系统！
                </p>
              </div>
            </div>

            {createdResult.nameservers.length > 0 ? (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-content-secondary flex items-center gap-1.5">
                    <Server className="w-3.5 h-3.5 text-accent" />
                    上游分配的 DNS 服务器 (NS 记录)：
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopyAllNs(createdResult.nameservers)}
                    className="text-xs text-accent hover:underline flex items-center gap-1"
                  >
                    <Copy className="w-3 h-3" /> 复制全部
                  </button>
                </div>
                <div className="p-3 bg-surface-raised rounded-xl border border-border-base space-y-2 font-mono text-xs">
                  {createdResult.nameservers.map((ns, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between p-2 rounded-lg bg-surface border border-border-subtle group hover:border-accent/40 transition-colors"
                    >
                      <span className="text-content-primary font-medium">{ns}</span>
                      <button
                        type="button"
                        onClick={() => handleCopyNs(ns, idx)}
                        className="p-1 rounded text-content-muted hover:text-accent transition-colors"
                        title="复制此记录"
                      >
                        {copiedIndex === idx ? (
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-content-muted leading-relaxed">
                  💡 提示：若该域名刚购买，请前往域名原注册商控制台，将 DNS 服务器修改为上述地址，全球生效约需数分钟至数小时。
                </p>
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                variant="secondary"
                onClick={handleResetAndClose}
              >
                完成
              </Button>
              {onOpenDns && (
                <Button
                  variant="primary"
                  onClick={() => {
                    const dom = createdResult.domain;
                    handleResetAndClose();
                    onOpenDns(dom);
                  }}
                >
                  立即配置解析记录
                </Button>
              )}
            </div>
          </div>
        ) : (
          /* 输入表单 */
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* 选择账号 */}
            <div>
              <label className="block text-xs font-semibold text-content-secondary mb-1.5">
                所属账号 / 服务商
              </label>
              {supportedAccounts.length === 0 ? (
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-300 text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  当前尚未绑定支持在线添加域名的账号（DNSPod、Cloudflare、阿里云、华为云、Vercel）。请先前往「账号管理」进行绑定。
                </div>
              ) : (
                <CustomSelect
                  value={String(selectedAccountId)}
                  onChange={(val) => setSelectedAccountId(Number(val))}
                  options={supportedAccounts.map((acc) => ({
                    value: String(acc.id),
                    label: `[${PROVIDER_LABELS[acc.provider || ""] || acc.provider || "未知"}] ${acc.alias || `账号 ${acc.id}`}`,
                  }))}
                  ariaLabel="选择目标账号"
                  className="w-full text-sm"
                />
              )}
            </div>

            {/* 域名输入框 */}
            <div>
              <label className="block text-xs font-semibold text-content-secondary mb-1.5">
                域名名称
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={domainInput}
                  onChange={(e) => {
                    setDomainInput(e.target.value);
                    if (errorMsg) setErrorMsg(null);
                  }}
                  placeholder="如 example.com 或 a.test.com"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-surface-raised border border-border-base focus:border-accent focus:ring-1 focus:ring-accent text-sm text-content-primary placeholder:text-content-muted outline-none transition-all font-mono"
                  autoFocus
                />
              </div>
              <p className="text-xs text-content-muted mt-1.5 leading-relaxed">
                支持主域名（如 <code className="text-content-secondary">test.com</code>）或独立委派的子域名（如 <code className="text-content-secondary">sub.test.com</code>）。
              </p>
            </div>

            {/* 错误提示 */}
            {errorMsg && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-300 text-xs flex items-center gap-2 animate-in fade-in">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* 底部按钮 */}
            <div className="flex items-center justify-end gap-3 pt-3 border-t border-border-base mt-5">
              <Button
                type="button"
                variant="secondary"
                onClick={handleResetAndClose}
                disabled={submitting}
              >
                取消
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={submitting || supportedAccounts.length === 0}
                className="flex items-center gap-2"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    正在上游添加...
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4" />
                    确认添加
                  </>
                )}
              </Button>
            </div>
          </form>
        )}
      </div>
    </ModalOverlay>
  );
}
