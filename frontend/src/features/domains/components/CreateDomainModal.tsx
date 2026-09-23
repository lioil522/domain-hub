import { useState, useEffect } from "react";
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
  ShieldAlert,
  ExternalLink,
  ArrowLeft,
  RotateCw,
} from "lucide-react";
import { ModalOverlay } from "../../../components/ModalOverlay";
import { Input } from "../../../components/form/Input";
import { Button } from "../../../components/Button";
import { domainsApi, type SubdomainVerifyInfo } from "../../../api/endpoints/domains";
import { isApiRequestError } from "../../../api/request";
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

  // 子域名 TXT 授权校验状态
  const [txtVerifyInfo, setTxtVerifyInfo] = useState<(SubdomainVerifyInfo & { message?: string }) | null>(null);
  const [manualTxtValue, setManualTxtValue] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // 当外部传入的 defaultAccountId 发生变化时，同步选中的账号
  useEffect(() => {
    if (defaultAccountId && supportedAccounts.some((a) => a.id === defaultAccountId)) {
      setSelectedAccountId(defaultAccountId);
    } else if (supportedAccounts.length > 0 && !supportedAccounts.some((a) => a.id === selectedAccountId)) {
      setSelectedAccountId(supportedAccounts[0].id);
    }
  }, [defaultAccountId, supportedAccounts]);

  const currentAccount = supportedAccounts.find((a) => a.id === selectedAccountId) || supportedAccounts[0];

  // 成功状态
  const [createdResult, setCreatedResult] = useState<{
    domain: Domain;
    nameservers: string[];
    message: string;
  } | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  if (!open) return null;

  const handleCopyText = async (text: string, key: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
      showToast("success", `已复制: ${label}`);
    } catch {
      showToast("error", "复制失败，请手动选取复制");
    }
  };

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

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const domain = domainInput.trim().toLowerCase();
    if (!domain) {
      setErrorMsg("请输入要添加的域名");
      return;
    }
    const targetId = selectedAccountId || currentAccount?.id;
    if (!targetId) {
      setErrorMsg("未指定目标托管账号，请先在「账号管理」中绑定支持的服务商");
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await domainsApi.create(apiFetch, {
        account_id: targetId,
        domain,
      });

      if (res.success && res.domain) {
        showToast("success", res.message || "域名添加成功！");
        setTxtVerifyInfo(null);
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
      if (isApiRequestError(err)) {
        const payload = err.payload as any;
        if (payload?.need_txt_verify && payload?.verify_info) {
          setTxtVerifyInfo({
            ...payload.verify_info,
            message: payload.message,
          });
          if (payload.verify_info.value) {
            setManualTxtValue(payload.verify_info.value);
          }
          return;
        }
      }
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
    setTxtVerifyInfo(null);
    setManualTxtValue("");
    setErrorMsg(null);
    onClose();
  };

  return (
    <ModalOverlay>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-domain-modal-title"
        className="bg-surface border border-border-base w-full max-w-lg max-h-[90dvh] rounded-2xl overflow-hidden flex flex-col shadow-2xl animate-in fade-in zoom-in-95 duration-200"
      >
        {/* 顶部标题栏 */}
        <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between border-b border-border-base flex-shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-1.5 rounded-lg bg-accent/15 text-accent flex-shrink-0">
              <Globe className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 id="create-domain-modal-title" className="text-base sm:text-lg font-bold text-content-primary truncate">
                添加域名托管
              </h3>
              <p className="text-xs text-content-muted mt-0.5 truncate">
                {currentAccount ? (
                  <>
                    所属账号: <span className="font-semibold text-accent">[{PROVIDER_LABELS[currentAccount.provider || ""] || currentAccount.provider}] {currentAccount.alias}</span> · 
                  </>
                ) : null}
                支持添加主域或独立子域
              </p>
            </div>
          </div>
          <button
            onClick={handleResetAndClose}
            className="p-1.5 rounded-lg text-content-muted hover:text-content-primary hover:bg-hovered transition-colors flex-shrink-0"
            title="关闭"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 内容展示：成功结果页 */}
        {createdResult ? (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4">
              <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 flex items-start gap-3">
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
            </div>

            {/* 成功页底部操作栏 */}
            <div className="bg-elevated px-4 sm:px-6 py-3.5 flex items-center justify-end gap-3 border-t border-border-base flex-shrink-0">
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
        ) : txtVerifyInfo ? (
          /* 子域名 TXT 授权校验界面 */
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4">
              {/* 提示横幅 */}
              <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-start gap-3">
                <ShieldAlert className="w-5 h-5 text-amber-400 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <h4 className="text-sm font-bold text-amber-300">
                    需要完成 TXT 记录授权校验
                  </h4>
                  <p className="text-xs text-content-secondary leading-relaxed">
                    为防止子域劫持，腾讯云 DNSPod 要求证明您拥有该子域控制权。请前往主域名{" "}
                    <span className="font-mono font-semibold text-accent">{txtVerifyInfo.parent_domain}</span>{" "}
                    的原 DNS 服务商处添加以下 TXT 解析记录：
                  </p>
                </div>
              </div>

              {/* 专属校验值参数表格 */}
              <div className="p-3.5 bg-surface-raised rounded-xl border border-border-base space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-content-primary">
                    请在主域 [{txtVerifyInfo.parent_domain}] 添加以下记录：
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const val = txtVerifyInfo.value || manualTxtValue || "";
                      const text = `主机记录: ${txtVerifyInfo.host}\n记录类型: ${txtVerifyInfo.type}\n记录值: ${val}`;
                      handleCopyText(text, "all_txt", "全部校验信息");
                    }}
                    className="text-xs text-accent hover:underline flex items-center gap-1"
                  >
                    <Copy className="w-3 h-3" /> 复制整段
                  </button>
                </div>

                <div className="space-y-2">
                  {/* 主机记录 */}
                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-surface border border-border-subtle group hover:border-accent/40 transition-colors">
                    <div className="min-w-0 pr-2">
                      <span className="text-[11px] text-content-muted block">主机记录 (Host)</span>
                      <span className="font-mono text-xs font-semibold text-content-primary truncate block">
                        {txtVerifyInfo.host}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCopyText(txtVerifyInfo.host, "host", txtVerifyInfo.host)}
                      className="p-1.5 rounded-lg text-content-muted hover:text-accent hover:bg-hovered transition-colors flex-shrink-0"
                      title="复制主机记录"
                    >
                      {copiedKey === "host" ? (
                        <Check className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                  </div>

                  {/* 记录类型 */}
                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-surface border border-border-subtle group hover:border-accent/40 transition-colors">
                    <div className="min-w-0 pr-2">
                      <span className="text-[11px] text-content-muted block">记录类型 (Type)</span>
                      <span className="font-mono text-xs font-semibold text-content-primary truncate block">
                        {txtVerifyInfo.type}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCopyText(txtVerifyInfo.type, "type", txtVerifyInfo.type)}
                      className="p-1.5 rounded-lg text-content-muted hover:text-accent hover:bg-hovered transition-colors flex-shrink-0"
                      title="复制记录类型"
                    >
                      {copiedKey === "type" ? (
                        <Check className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                  </div>

                  {/* 记录值 */}
                  <div className="p-2.5 rounded-lg bg-surface border border-border-subtle space-y-1.5 group hover:border-accent/40 transition-colors">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-content-muted">
                        专属校验记录值 (Value)
                      </span>
                      {(txtVerifyInfo.value || manualTxtValue) ? (
                        <button
                          type="button"
                          onClick={() => handleCopyText(txtVerifyInfo.value || manualTxtValue, "value", "记录值")}
                          className="p-1 rounded text-content-muted hover:text-accent transition-colors"
                          title="复制记录值"
                        >
                          {copiedKey === "value" ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      ) : null}
                    </div>

                    {txtVerifyInfo.value ? (
                      <div className="font-mono text-xs font-semibold text-emerald-400 break-all select-all py-0.5">
                        {txtVerifyInfo.value}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Input
                          type="text"
                          value={manualTxtValue}
                          onChange={(e) => setManualTxtValue(e.target.value)}
                          placeholder="粘贴在腾讯云控制台获取的 32 位校验记录值（如 7bdae52...）"
                          mono
                          size="sm"
                          className="w-full text-xs text-content-primary"
                        />
                        <div className="flex items-center justify-between text-[11px] text-content-muted">
                          <span>💡 您可直接前往腾讯云 DNSPod 控制台添加时复制该 32 位值</span>
                          <a
                            href="https://console.cloud.tencent.com/cns"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-accent hover:underline flex items-center gap-1 flex-shrink-0 ml-2"
                          >
                            直达控制台 <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <p className="text-[11px] text-content-muted leading-relaxed">
                  💡 步骤说明：前往 <code className="text-content-secondary">{txtVerifyInfo.parent_domain}</code> 的原 DNS 服务商添加上述 TXT 记录后，点击下方【我已添加解析，立即验证】按钮，系统将自动发起上游校验并完成域名创建。
                </p>
              </div>

              {/* 错误提示（若重试时依然校验不通过） */}
              {errorMsg && (
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-300 text-xs flex items-center gap-2 animate-in fade-in">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}
            </div>

            {/* 校验页底部操作栏 */}
            <div className="bg-elevated px-4 sm:px-6 py-3.5 flex items-center justify-between border-t border-border-base flex-shrink-0">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setTxtVerifyInfo(null);
                  setErrorMsg(null);
                }}
                disabled={submitting}
                className="flex items-center gap-1.5"
              >
                <ArrowLeft className="w-4 h-4" />
                返回修改
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={() => handleSubmit()}
                disabled={submitting}
                className="flex items-center gap-2"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    正在上游验证并添加...
                  </>
                ) : (
                  <>
                    <RotateCw className="w-4 h-4" />
                    我已添加解析，立即验证
                  </>
                )}
              </Button>
            </div>
          </div>
        ) : (
          /* 输入表单 */
          <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
            <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4">
              {supportedAccounts.length === 0 ? (
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-300 text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  当前尚未绑定支持在线添加域名的账号（DNSPod、Cloudflare、阿里云、华为云、Vercel）。请先前往「账号管理」进行绑定。
                </div>
              ) : null}

              {/* 域名输入框 */}
              <div>
                <label className="block text-xs font-semibold text-content-secondary mb-1.5">
                  域名名称
                </label>
                <Input
                  type="text"
                  value={domainInput}
                  onChange={(e) => {
                    setDomainInput(e.target.value);
                    if (errorMsg) setErrorMsg(null);
                  }}
                  placeholder="如 example.com 或 a.test.com"
                  mono
                  size="md"
                  className="w-full text-content-primary placeholder:text-content-muted"
                  autoFocus
                />
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
            </div>

            {/* 表单底部按钮 */}
            <div className="bg-elevated px-4 sm:px-6 py-3.5 flex items-center justify-end gap-3 border-t border-border-base flex-shrink-0">
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
