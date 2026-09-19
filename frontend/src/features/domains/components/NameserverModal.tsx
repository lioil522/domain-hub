/**
 * NS 域名服务器设置 / 域名委派弹窗（DNSHE，Phase 4-B 从 App.tsx 抽出）
 *
 * 原实现为 App.tsx 内的内联 JSX（`nsModalOpen && nsModalDomain`），状态、取数、
 * 增删改、一键恢复默认 NS 全部内聚在组件内，父级只保留「开关」：
 * 用 `open` + `domain` 两个 props 驱动（`open && domain` 时渲染，否则卸载）。
 *
 * 关键行为对齐（逐行搬运，勿改）：
 * - 打开即拉 `/api/domains/:id/dns` 并过滤出 NS 记录，失败弹 toast；
 * - 「一键恢复 / 清理残留」逐条 DELETE 并检查每条业务结果（apiFetch 只在网络层抛异常，
 *   后端 `{success:false}` 不会抛，不检查就会误报成功）；失败时重新拉取列表保持弹窗打开；
 * - 「添加 NS」先按需清理同名冲突记录，再串行创建（上游限频、单条失败不中断其余），
 *   最后统一汇报；
 * - 打开/恢复/新增成功都会回调 `onSynced`（原 `handleSyncDnsheDomains`）。
 *
 * NOTE: `checkHasDns` / `getDnsProviderLabel` 由父级注入 —— 二者在域名列表卡片等处
 * 也被使用，属于跨模块共享的纯函数，暂留在 App（Phase 10 再归位）。
 */

import { ModalOverlay } from "../../../components/ModalOverlay";
import { Textarea } from "../../../components/form/Textarea";
import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Server, Trash2, X } from "lucide-react";
import type { Domain } from "../../../types/domain";
import type { DnsRecord } from "../../../types/dns";
import { useAppData } from "../../../state/AppDataContext";
import { parseNsInput } from "../../../lib/ns";

export interface NameserverModalProps {
  /** 弹窗开关（与 domain 同时为真才渲染） */
  open: boolean;
  /** 当前操作的域名 */
  domain: Domain | null;
  onClose: () => void;
  /** 操作忙碌键（`reset-ns` / `add-ns`），与父级 actionLoading 共用 */
  actionLoading: string | null;
  setActionLoading: (v: string | null) => void;
  /** 判断域名是否使用系统默认 NS（DNSHE） */
  checkHasDns: (dom: Domain) => boolean;
  /** 按 NS 记录识别并展示托管商标签 */
  getDnsProviderLabel: (dom: Domain, records?: DnsRecord[]) => string;
  /** 删除单条解析记录（域名由本组件显式传入，避免误删当前 DNS 弹窗的域名） */
  onDeleteDnsRecord: (recordId: string | number, domain: Domain | null) => Promise<void>;
  /** 域名同步（原 handleSyncDnsheDomains） */
  onSynced: () => void;
}

export function NameserverModal(props: NameserverModalProps) {
  const {
    open,
    domain,
    onClose,
    actionLoading,
    setActionLoading,
    checkHasDns,
    getDnsProviderLabel,
    onDeleteDnsRecord,
    onSynced,
  } = props;

  const { apiFetch, showToast } = useAppData();

  const [nsRecords, setNsRecords] = useState<DnsRecord[]>([]);
  const [loadingNsModal, setLoadingNsModal] = useState(false);
  const [newCustomNsContent, setNewCustomNsContent] = useState("");
  const [forceReplaceConflict, setForceReplaceConflict] = useState(true);

  const parsedNsList = useMemo(() => parseNsInput(newCustomNsContent), [newCustomNsContent]);

  // 打开 NS 管理模态框（也是「刷新列表」的复用入口）
  const handleOpenNsModal = async (dom: Domain) => {
    setLoadingNsModal(true);
    setNsRecords([]);
    setNewCustomNsContent("");

    try {
      const res = await apiFetch(`/api/domains/${dom.id}/dns`);
      const data = await res.json();
      if (data.success) {
        const nsOnly = (data.records || []).filter((r: DnsRecord) => r.type === "NS");
        setNsRecords(nsOnly);
      } else {
        showToast("error", data.message || "获取 NS 记录失败");
      }
    } catch (e) {
      showToast("error", "获取 NS 记录网络异常");
    } finally {
      setLoadingNsModal(false);
    }
  };

  // 打开 / 换域名时初始化。依赖用 `domain` 整体而非 `domain.id`：
  // 父级只在「打开」时设置该对象、关闭时清空，期间不变，故不会重复拉取。
  useEffect(() => {
    if (open && domain) handleOpenNsModal(domain);
  }, [open, domain]);

  // 一键恢复为系统默认 NS / 清理残留 NS 记录（两者都是删除区域内的 NS 解析记录）
  const handleResetToDefaultNs = async () => {
    if (!domain) return;
    const isDefaultNs = checkHasDns(domain);
    const confirmMsg = isDefaultNs
      ? `域名 [${domain.full_domain}] 已委派回系统默认 NS，确定清理区域内残留的 ${nsRecords.length} 条 NS 解析记录吗？`
      : `确定要将域名 [${domain.full_domain}] 恢复为系统默认 NS 吗？这会清除当前配置的第三方 NS 记录。`;
    if (!confirm(confirmMsg)) return;

    setActionLoading("reset-ns");
    try {
      // 逐条删除并检查每条的业务结果 —— apiFetch 只在网络层失败时抛异常，
      // 后端返回 {success:false} 时不会抛，若不检查就会误报"恢复成功"而记录仍在。
      const failed: Array<{ ns: string; msg: string }> = [];
      let nsDisabled = false;

      for (const rec of nsRecords) {
        const label = rec.content || rec.name || String(rec.id ?? rec.record_id);
        try {
          const res = await apiFetch(`/api/domains/${domain.id}/dns/${rec.id ?? rec.record_id}`, {
            method: "DELETE"
          });
          const data = await res.json().catch(() => ({ success: res.ok }));
          if (!data.success) {
            if (data.error_code === "ns_management_disabled") nsDisabled = true;
            failed.push({ ns: label, msg: data.message || `HTTP ${res.status}` });
          }
        } catch (err) {
          failed.push({ ns: label, msg: err instanceof Error ? err.message : "请求异常" });
        }
      }

      if (failed.length === 0) {
        showToast(
          "success",
          isDefaultNs
            ? `已清理 ${nsRecords.length} 条残留 NS 记录`
            : `域名 [${domain.full_domain}] 已成功恢复为系统默认 NS！`
        );
        onClose();
      } else {
        showToast(
          "error",
          nsDisabled
            ? "DNSHE 上游平台已禁用 NS 管理，无法通过 API 删除 NS 记录。请前往 DNSHE 官网后台手动设置。"
            : `${failed.length} 条 NS 记录删除失败：${failed.map(f => `${f.ns}(${f.msg})`).join("；")}`
        );
        // 失败时保持弹窗打开并刷新列表，让实际剩余记录可见
        handleOpenNsModal(domain);
      }
      onSynced();
    } catch (e) {
      showToast("error", "恢复系统默认 NS 发生异常");
    } finally {
      setActionLoading(null);
    }
  };

  // 添加自定义 NS 记录 (支持一次填多个，逐条提交；并可自动清理与 NS 冲突的同名记录)
  const handleAddCustomNs = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!domain) return;

    // NS 委派通常要求至少主备两条，这里逐条提交
    const nsList = parseNsInput(newCustomNsContent);
    if (nsList.length === 0) return;

    setActionLoading("add-ns");
    try {
      if (forceReplaceConflict) {
        // 1. 先查询当前域名的已有解析记录
        const res = await apiFetch(`/api/domains/${domain.id}/dns`);
        const data = await res.json();
        if (data.success && Array.isArray(data.records)) {
          // 2. 筛选出非 NS 类型的冲突记录 (如 A, CNAME, TXT, MX 等)
          const conflicts = data.records.filter((r: DnsRecord) => r.type !== "NS");
          const undeleted: string[] = [];
          for (const conf of conflicts) {
            try {
              const delRes = await apiFetch(
                `/api/domains/${domain.id}/dns/${conf.id ?? conf.record_id}`,
                { method: "DELETE" }
              );
              const delData = await delRes.json().catch(() => ({ success: delRes.ok }));
              if (!delData.success) undeleted.push(`${conf.type} ${conf.name}`);
            } catch {
              undeleted.push(`${conf.type} ${conf.name}`);
            }
          }
          // 删不掉要说出来：否则后面 NS 添加失败时，用户会以为是别的原因
          if (undeleted.length > 0) {
            showToast("warning", `${undeleted.length} 条冲突记录未能删除：${undeleted.join("、")}`);
          }
        }
      }

      // 3. 逐条创建 NS 记录。上游接口一次只收一条，且有限频，因此串行提交。
      //    单条失败不中断其余条目，最后统一汇报，避免"加了一半却什么都没说"。
      const succeeded: string[] = [];
      const failed: Array<{ ns: string; msg: string }> = [];
      let nsDisabled = false;

      for (const ns of nsList) {
        try {
          const res = await apiFetch(`/api/domains/${domain.id}/dns`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "NS", name: "@", content: ns, ttl: 86400 })
          });
          const data = await res.json();
          if (data.success) {
            succeeded.push(ns);
          } else {
            if (data.error_code === "ns_management_disabled") nsDisabled = true;
            failed.push({ ns, msg: data.message || "添加失败" });
          }
        } catch (err) {
          failed.push({ ns, msg: err instanceof Error ? err.message : "请求异常" });
        }
      }

      if (succeeded.length > 0) {
        showToast("success", `成功添加 ${succeeded.length} 条 NS 记录：${succeeded.join("、")}`);
        setNewCustomNsContent("");
        handleOpenNsModal(domain);
        onSynced();
      }

      if (failed.length > 0) {
        showToast(
          "error",
          nsDisabled
            ? "DNSHE 上游平台已禁用 NS 管理，无法通过 API 修改 NS 记录。请前往 DNSHE 官网后台手动设置。"
            : `${failed.length} 条添加失败：${failed.map(f => `${f.ns}(${f.msg})`).join("；")}${
                succeeded.length === 0 ? "。可尝试勾选【强制替换冲突记录】" : ""
              }`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "添加 NS 记录发生异常";
      showToast("error", msg);
    } finally {
      setActionLoading(null);
    }
  };

  if (!open || !domain) return null;

  return (
    <ModalOverlay>
      <div role="dialog" aria-labelledby="nameserver-modal-title" className="bg-surface border border-border-base w-full max-w-2xl max-h-[90dvh] rounded-2xl overflow-hidden flex flex-col shadow-2xl">
        {/* 模态框头部 */}
        <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between gap-2 border-b border-border-base flex-shrink-0">
          <div className="min-w-0">
            <h3 id="nameserver-modal-title" className="text-base sm:text-lg font-bold text-content-primary flex items-center gap-2">
              <Server className="text-sky-400 w-5 h-5 flex-shrink-0" />
              <span className="truncate">NS 域名服务器设置 / 域名委派</span>
            </h3>
            <p className="text-xs text-content-muted mt-0.5 font-mono truncate">
              域名: {domain.full_domain}
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

        {/* 模态框内容 */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4 sm:space-y-6">
          
          {/* 当前 NS 状态指示
              以域名自身的委派状态（checkHasDns，来自同步的 ns1/ns2 字段）为准，
              而不是区域内 NS 解析记录的条数 —— 两者是两回事：
              官网把 NS 改回 ns1/ns2.dnshe.com 后，区域里遗留的 NS 记录不会自动消失。 */}
          {(() => {
            const isDefaultNs = checkHasDns(domain);
            const hasLeftoverNs = nsRecords.length > 0;
            const providerLabel = getDnsProviderLabel(domain, nsRecords);
            return (
              <div className="p-4 rounded-xl border border-border-base bg-hovered flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-xs text-content-muted block font-medium">当前 NS 运行状态</span>
                  <span className="text-sm font-bold text-content-primary mt-1 block">
                    {isDefaultNs
                      ? "系统默认 (ns1.dnshe.com / ns2.dnshe.com)"
                      : `${providerLabel} 委派托管中`}
                  </span>
                  {isDefaultNs && hasLeftoverNs && (
                    <span className="text-[11px] text-amber-400 mt-1 block">
                      域名已委派回系统默认，但区域内仍残留 {nsRecords.length} 条 NS 解析记录，建议清理
                    </span>
                  )}
                </div>
                <div className="shrink-0">
                  {isDefaultNs ? (
                    <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/80 dark:text-emerald-400 dark:border-emerald-900/60 text-xs px-3 py-1 rounded-full font-semibold">
                      系统默认
                    </span>
                  ) : (
                    <span className="bg-sky-50 text-sky-700 border border-sky-200 dark:bg-sky-950/80 dark:text-sky-300 dark:border-sky-800/60 text-xs px-3 py-1 rounded-full font-semibold">
                      {providerLabel}
                    </span>
                  )}
                </div>
              </div>
            );
          })()}

          {/* 已设置的 NS 记录列表 */}
          {loadingNsModal ? (
            <div className="flex justify-center py-6">
              <RefreshCw className="w-6 h-6 animate-spin text-accent" />
            </div>
          ) : nsRecords.length > 0 ? (
            <div className="space-y-3">
              <h4 className="text-xs font-bold text-content-secondary uppercase tracking-wider">
                {checkHasDns(domain)
                  ? "区域内残留的 NS 解析记录"
                  : "当前委派的第三方 NS 服务器列表"}
              </h4>
              <div className="bg-hovered border border-border-base rounded-xl overflow-hidden divide-y divide-border-soft">
                {nsRecords.map((rec) => (
                  <div key={rec.id} className="p-3.5 flex justify-between items-center text-xs font-mono">
                    <span className="text-content-secondary">{rec.content}</span>
                    <button
                      onClick={async () => {
                        await onDeleteDnsRecord(rec.id ?? rec.record_id!, domain);
                        handleOpenNsModal(domain);
                        onSynced();
                      }}
                      disabled={actionLoading === `delete-dns-${rec.id ?? rec.record_id}`}
                      className="text-red-600 hover:text-red-700 p-2 md:p-1 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-950/40 rounded transition-all"
                      title="删除此 NS 记录"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>

              <button
                onClick={handleResetToDefaultNs}
                disabled={actionLoading === "reset-ns"}
                className="w-full bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/60 dark:hover:bg-emerald-900/60 dark:text-emerald-300 dark:border-emerald-900/60 py-2.5 rounded-xl font-semibold text-xs flex items-center justify-center gap-2 transition-all shadow-inner mt-2"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${actionLoading === "reset-ns" ? "animate-spin" : ""}`} />
                {checkHasDns(domain)
                  ? `清理这 ${nsRecords.length} 条残留 NS 记录`
                  : "一键恢复为系统默认 NS (ns1.dnshe.com / ns2.dnshe.com)"}
              </button>
            </div>
          ) : (
            <div className="text-center py-4 bg-hovered rounded-xl border border-border-base text-content-muted text-xs">
              当前处于系统默认 NS。填下方表单可直接新增外部 NS 并切为「外部 DNS 委派」模式。
            </div>
          )}

          {/* 添加自定义第三方 NS 表单 */}
          <form onSubmit={handleAddCustomNs} className="p-4 border border-border-base rounded-xl bg-hovered space-y-3">
            <h4 className="text-xs font-bold text-content-secondary">添加 / 变更自定义 NS 服务器</h4>
            <div>
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <label htmlFor="nameservermodal-fld1" className="block text-[10px] text-content-muted font-bold uppercase">
                  第三方 NS 服务器地址
                </label>
                {parsedNsList.length > 0 && (
                  <span className="text-[10px] text-accent font-semibold">
                    已识别 {parsedNsList.length} 条
                  </span>
                )}
              </div>
              <Textarea id="nameservermodal-fld1" size="sm" mono resizable
                required
                rows={3}
                placeholder={"每行一个，或用逗号/空格分隔，例如：\ndara.ns.cloudflare.com\nrick.ns.cloudflare.com"}
                value={newCustomNsContent}
                onChange={(e) => setNewCustomNsContent(e.target.value)}
                className="w-full text-content-secondary"
              />
              <p className="text-[10px] text-content-muted mt-1">
                可一次填多个（NS 委派通常需要主备至少两条），将逐条提交
              </p>
            </div>
            <div className="flex items-center gap-2 py-1">
              <input
                type="checkbox"
                id="forceReplaceNs"
                checked={forceReplaceConflict}
                onChange={(e) => setForceReplaceConflict(e.target.checked)}
                className="w-4 h-4 text-accent accent-[var(--accent)] rounded bg-surface border-border-base focus:ring-accent cursor-pointer"
              />
              <label htmlFor="forceReplaceNs" className="text-xs text-content-secondary font-medium cursor-pointer flex items-center gap-1">
                强制替换冲突记录
                <span className="text-[11px] text-content-muted font-normal">（自动删除同名 A / CNAME / TXT / MX 等冲突解析）</span>
              </label>
            </div>
            <button
              type="submit"
              disabled={actionLoading === "add-ns" || parsedNsList.length === 0}
              className="w-full btn-primary py-2.5 rounded-lg font-semibold text-xs text-white flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {actionLoading === "add-ns" && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              {parsedNsList.length > 1
                ? `添加 ${parsedNsList.length} 条 NS 委派记录`
                : "添加 NS 委派记录"}
            </button>
          </form>

        </div>

        {/* 页脚 */}
        <div className="bg-elevated px-4 sm:px-6 py-4 border-t border-border-base flex justify-end flex-shrink-0">
          <button
            onClick={onClose}
            className="bg-elevated hover:bg-hovered text-content-secondary text-sm font-semibold px-4 py-2 rounded-lg"
          >
            完成
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
