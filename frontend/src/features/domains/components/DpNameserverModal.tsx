/**
 * DigitalPlat「修改 NS」弹窗（Phase 4-C 从 App.tsx 抽出）
 *
 * 原实现为 App.tsx 内的内联 JSX（`dpNsModalOpen && dpNsModalDomain`），状态、取数、
 * 草稿增删、整组保存全部内聚在组件内，父级只保留「开关」：用 `open` + `domain`
 * 两个 props 驱动（`open && domain` 时渲染，否则卸载）。
 *
 * 关键行为对齐（逐行搬运，勿改）：
 * - DigitalPlat 的 NS 是**注册局级整组替换**：草稿改动只在本地，点「保存替换」才
 *   一次性 PUT 覆盖全部 NS；
 * - 打开时先秒显会话记忆（dpNsMemoRef）里的最近一次 NS，再向后端拉取；
 *   用户已开始编辑（dpNsDirtyRef）时不覆盖草稿；
 * - `force=true`（弹窗内刷新按钮）带 ?refresh=1 绕过后端 10 分钟缓存回源，且不预填记忆值；
 * - 保存成功后记忆新值、关闭弹窗，并回调 `onSaved` 刷新 DP 域名列表
 *   （NS 变化会改 dns_provider / has_dns，需保持卡片展示一致）。
 *
 * NOTE: DP_DEFAULT_NS 在本文件定义并导出 —— App 内已无其它引用，归入本组件专属模块。
 */

import { ModalOverlay } from "../../../components/ModalOverlay";
import { Textarea } from "../../../components/form/Textarea";
import { useEffect, useRef, useState } from "react";
import { Info, Plus, RefreshCw, Server, Trash2, X } from "lucide-react";
import type { Domain } from "../../../types/domain";
import { useAppData } from "../../../state/AppDataContext";
import { parseNsInput, normalizeNs } from "../../../lib/ns";
import { toUnicode } from "../../../punycode";

/** DigitalPlat 默认托管 NS（弹窗内「一键恢复默认」的目标值） */
export const DP_DEFAULT_NS: string[] = ["dns1.digitalplat.org", "dns2.digitalplat.org"];


// 草稿是否就是 DigitalPlat 默认 NS（无论顺序，集合相等即视为默认）
const isDpDefaultNs = (list: string[]) => {
  const set = new Set(list.map(normalizeNs).filter(Boolean));
  return set.size === DP_DEFAULT_NS.length && DP_DEFAULT_NS.every((n) => set.has(n));
};

// 展示用托管方标签：按 NS 域名猜测（仅用于状态徽章，不参与判定）
const dpNsProviderLabel = (list: string[]) => {
  const joined = list.join(" ");
  if (/digitalplat\.org/.test(joined)) return "DigitalPlat";
  if (/cloudflare\.(com|net)/.test(joined)) return "Cloudflare";
  return "自定义（外部）";
};

// 域名行已同步的 dns_provider → 托管方标签（弹窗刚打开、NS 列表还没回来时的占位，
// 与 DNSHE 弹窗用行内委派字段秒显状态条同理；external/未知返回 null 交由 UI 显示读取中）
const dpRowProviderLabel = (dom: Domain | null): string | null => {
  if (!dom) return null;
  const p = String(dom.dns_provider || "").toLowerCase();
  if (p === "digitalplat") return "DigitalPlat";
  if (p === "cloudflare") return "Cloudflare";
  if (p === "dnspod") return "DNSPod";
  if (p === "vercel") return "Vercel";
  if (p === "vps8") return "vps8";
  return null; // external / 空：具体 NS 未知，等列表返回
};

export interface DpNameserverModalProps {
  /** 弹窗开关（与 domain 同时为真才渲染） */
  open: boolean;
  /** 当前操作的域名 */
  domain: Domain | null;
  onClose: () => void;
  /** 保存成功后刷新 DigitalPlat 域名列表 */
  onSaved: () => void;
}

export function DpNameserverModal(props: DpNameserverModalProps) {
  const { open, domain, onClose, onSaved } = props;

  const { apiFetch, showToast } = useAppData();

  // 草稿 NS 列表：打开时用当前 NS 预填；下方表单增删只改草稿，点「保存替换」才整组 PATCH
  const [dpNsList, setDpNsList] = useState<string[]>([]);
  // 「添加 NS」输入框内容（每行一条；解析后合并进上方草稿列表）
  const [dpNsInput, setDpNsInput] = useState("");
  // 打开弹窗时向后端拉取当前 NS 的加载态
  const [dpNsLoading, setDpNsLoading] = useState(false);
  // 提交替换 NS 的保存态
  const [dpNsSaving, setDpNsSaving] = useState(false);
  // 最近一次读到的 NS 会话记忆（按 domain.id）：再次打开先秒显旧值再后台同步，避免每次白等一次上游查询
  const dpNsMemoRef = useRef<Record<number, string[]>>({});
  // 弹窗打开后用户是否改过草稿：改过后后台同步结果不覆盖，避免吞掉用户正在编辑的内容
  const dpNsDirtyRef = useRef(false);

  // 打开 / 换域名时初始化（先秒显记忆值，再后台同步）
  useEffect(() => {
    if (open && domain) void handleDpOpenNsModal(domain);
  }, [open, domain]);

  // 打开「修改 NS」弹窗：先秒显（会话记忆的最近一次 NS / 无则空），再向后端拉取当前 NS
  // 同步（GET /api/domains/:id/nameservers，后端有 10 分钟缓存，基本瞬时）。force=true 时
  // 带 ?refresh=1 强制绕过缓存回源（弹窗内「刷新」按钮用），且不预填记忆值。
  const handleDpOpenNsModal = async (domain: Domain, force = false) => {
    setDpNsInput("");
    dpNsDirtyRef.current = false;
    const known = !force ? dpNsMemoRef.current[domain.id] : undefined;
    setDpNsList(known ? [...known] : []);
    setDpNsLoading(true);
    try {
      const res = await apiFetch(`/api/domains/${domain.id}/nameservers${force ? "?refresh=1" : ""}`);
      const data = await res.json();
      if (data.success && Array.isArray(data.nameservers)) {
        const fresh = data.nameservers.map((ns: unknown) => normalizeNs(String(ns))).filter(Boolean);
        // 用户已开始编辑草稿时不整体覆盖（记忆值保留），避免丢输入
        if (!dpNsDirtyRef.current) {
          setDpNsList(fresh);
          dpNsMemoRef.current[domain.id] = fresh;
        }
      }
      // 拿不到当前 NS（如尚未生效/上游异常）也允许打开弹窗手动填写
    } catch {
      // 同上：保留草稿/记忆值由用户手动填写
    } finally {
      setDpNsLoading(false);
    }
  };

  // 把「添加 NS」输入框内容合并进草稿列表（去重；保存时才真正提交）
  const handleDpAddNsFromInput = () => {
    const parsed = parseNsInput(dpNsInput);
    if (parsed.length === 0) {
      showToast("error", "请输入至少一条合法的 NS 服务器地址");
      return;
    }
    dpNsDirtyRef.current = true;
    setDpNsList((prev) => Array.from(new Set([...prev, ...parsed.map(normalizeNs)])));
    setDpNsInput("");
  };

  // 从草稿列表中移除一条（仅改本地草稿，不触发上游调用）
  const handleDpRemoveNsItem = (ns: string) => {
    const target = normalizeNs(ns);
    dpNsDirtyRef.current = true;
    setDpNsList((prev) => prev.filter((n) => normalizeNs(n) !== target));
  };

  // 一键恢复为 DigitalPlat 默认 NS（填入草稿，需再点「保存替换」生效）
  const handleDpResetDefaultNs = () => {
    dpNsDirtyRef.current = true;
    setDpNsList([...DP_DEFAULT_NS]);
    setDpNsInput("");
    showToast("info", "已填入默认 NS，点「保存替换」后生效");
  };

  // 提交整组替换 NS（PUT /api/domains/:id/nameservers）—— 以草稿列表为最终结果
  const handleDpSaveNameservers = async () => {
    if (!domain) return;
    const nsList = dpNsList.map(normalizeNs).filter(Boolean);
    if (nsList.length === 0) {
      showToast("error", "请至少保留一条 NS 服务器地址");
      return;
    }
    setDpNsSaving(true);
    try {
      const res = await apiFetch(`/api/domains/${domain.id}/nameservers`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nameservers: nsList })
      });
      const data = await res.json();
      if (data.success) {
        showToast("success", data.message || "NS 修改成功");
        // 记忆新值：下次打开直接秒显，无需等待上游
        dpNsMemoRef.current[domain.id] = nsList;
        onClose();
        // NS 变化会改 dns_provider / has_dns，刷新 DP 域名列表保持卡片展示一致
        onSaved();
      } else {
        showToast("error", data.message || "修改 NS 失败");
      }
    } catch {
      showToast("error", "修改 NS 请求失败，请检查网络后重试");
    } finally {
      setDpNsSaving(false);
    }
  };

  if (!open || !domain) return null;

  return (
    <ModalOverlay>
      <div role="dialog" aria-labelledby="dp-nameserver-modal-title" className="bg-surface border border-border-base w-full max-w-2xl max-h-[90dvh] rounded-2xl overflow-hidden flex flex-col shadow-2xl">
        {/* 模态框头部 */}
        <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between gap-2 border-b border-border-base flex-shrink-0">
          <div className="min-w-0">
            <h3 id="dp-nameserver-modal-title" className="text-base sm:text-lg font-bold text-content-primary flex items-center gap-2">
              <Server className="text-sky-400 w-5 h-5 flex-shrink-0" />
              <span className="truncate">NS 域名服务器设置 / 域名委派</span>
            </h3>
            <p className="text-xs text-content-muted mt-0.5 font-mono truncate">
              域名: {toUnicode(domain.full_domain)}（DigitalPlat）
            </p>
          </div>
          <button
            onClick={() => onClose()}
            disabled={dpNsSaving}
            className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded flex-shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 模态框内容 */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4 sm:space-y-6">
          <div className="p-3.5 rounded-xl border border-sky-200 bg-sky-50 text-xs text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200 flex gap-2.5">
            <Info className="w-4 h-4 shrink-0 text-sky-500 mt-0.5" />
            <div className="space-y-1 leading-relaxed">
              <p>
                DigitalPlat 的 NS 是<b>注册局级整组替换</b>：下方列表的改动只保留在草稿，
                点「保存替换」才一次性覆盖该域名的全部 NS，DNS 委派立即切换，解析生效通常需数分钟到数小时。
              </p>
              <p className="opacity-90">
                DigitalPlat 默认托管：<span className="font-mono">dns1.digitalplat.org</span> /{" "}
                <span className="font-mono">dns2.digitalplat.org</span>；委派到 Cloudflare：填 Cloudflare
                分配给该域名的两条 NS。
              </p>
            </div>
          </div>

          {/* 当前 NS 状态指示（跟随草稿实时变化，保存后才是实际委派）。
              列表未到时用行内已同步的 dns_provider 秒显占位（与 DNSHE 弹窗用行内委派字段
              即时渲染同理），不再整块等网络、也不误导为「尚未设置」。 */}
          {(() => {
            const list = dpNsList.map(normalizeNs).filter(Boolean);
            const isDefault = isDpDefaultNs(list);
            const rowProvider = dpRowProviderLabel(domain);
            const reading = dpNsLoading && list.length === 0;
            const titleText =
              list.length === 0
                ? reading
                  ? rowProvider
                    ? `${rowProvider} · 正在同步具体 NS…`
                    : "正在读取当前 NS…"
                  : "尚未设置 NS"
                : isDefault
                  ? `DigitalPlat 默认 (${DP_DEFAULT_NS.join(" / ")})`
                  : `${dpNsProviderLabel(list)} 委派托管中（${list.length} 条）`;
            const pillText =
              list.length === 0
                ? reading
                  ? rowProvider || "读取中"
                  : "未设置"
                : isDefault
                  ? "DigitalPlat"
                  : dpNsProviderLabel(list);
            const pillCls =
              list.length === 0
                ? reading
                  ? rowProvider === "DigitalPlat"
                    ? "bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/80 dark:text-emerald-400 dark:border-emerald-900/60"
                    : rowProvider
                      ? "bg-sky-50 text-sky-700 border border-sky-200 dark:bg-sky-950/80 dark:text-sky-300 dark:border-sky-800/60"
                      : "bg-slate-100 text-slate-500 border border-slate-200 dark:bg-slate-900/70 dark:text-slate-300 dark:border-slate-800"
                  : "bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/80 dark:text-amber-300 dark:border-amber-900/60"
                : isDefault
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/80 dark:text-emerald-400 dark:border-emerald-900/60"
                  : "bg-sky-50 text-sky-700 border border-sky-200 dark:bg-sky-950/80 dark:text-sky-300 dark:border-sky-800/60";
            return (
              <div className="p-4 rounded-xl border border-border-base bg-hovered flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-xs text-content-muted block font-medium">当前 NS 运行状态</span>
                  <span className="text-sm font-bold text-content-primary mt-1 block">{titleText}</span>
                  {list.length > 0 && !isDefault && (
                    <span className="text-[11px] text-content-muted mt-1 block">
                      草稿与线上可能不一致，点「保存替换」后生效
                    </span>
                  )}
                  {reading && (
                    <span className="text-[11px] text-content-muted mt-1 block">
                      正在从 DigitalPlat 读取注册局当前 NS，列表可先行编辑
                    </span>
                  )}
                </div>
                <div className="shrink-0">
                  <span className={`text-xs px-3 py-1 rounded-full font-semibold ${pillCls}`}>{pillText}</span>
                </div>
              </div>
            );
          })()}

          {/* NS 草稿列表：记忆/缓存命中时秒显，同步只在标题行给角标，不再整块空白等待 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-bold text-content-secondary uppercase tracking-wider">
                {dpNsList.length > 0
                  ? `当前 NS 列表（共 ${dpNsList.length} 条，保存后整组替换生效）`
                  : "当前 NS 列表"}
              </h4>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {dpNsLoading && dpNsList.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-content-muted font-semibold">
                    <RefreshCw className="w-3 h-3 animate-spin text-accent" />
                    与上游同步中…
                  </span>
                )}
                {!dpNsLoading && (
                  <button
                    onClick={() => domain && handleDpOpenNsModal(domain, true)}
                    className="text-content-muted hover:text-content-primary p-1.5 hover:bg-hovered rounded transition-all"
                    title="强制从 DigitalPlat 重新读取当前 NS（绕过缓存）"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {dpNsList.length > 0 ? (
              <>
                <div className="bg-hovered border border-border-base rounded-xl overflow-hidden divide-y divide-border-soft">
                  {dpNsList.map((ns) => {
                    const normalized = normalizeNs(ns);
                    return (
                      <div key={normalized} className="p-3.5 flex justify-between items-center text-xs font-mono">
                        <span className="text-content-secondary truncate min-w-0">{normalized}</span>
                        <button
                          onClick={() => handleDpRemoveNsItem(normalized)}
                          className="text-red-600 hover:text-red-700 p-2 md:p-1 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-950/40 rounded transition-all flex-shrink-0"
                          title="从列表移除（点「保存替换」后生效）"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>

                {!isDpDefaultNs(dpNsList.map(normalizeNs).filter(Boolean)) && (
                  <button
                    onClick={handleDpResetDefaultNs}
                    className="w-full bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/60 dark:hover:bg-emerald-900/60 dark:text-emerald-300 dark:border-emerald-900/60 py-2.5 rounded-xl font-semibold text-xs flex items-center justify-center gap-2 transition-all shadow-inner mt-2"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    一键恢复为 DigitalPlat 默认 NS ({DP_DEFAULT_NS.join(" / ")})
                  </button>
                )}
              </>
            ) : dpNsLoading ? (
              <div className="text-center py-6 bg-hovered rounded-xl border border-border-base text-content-muted text-xs flex items-center justify-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin text-accent" />
                正在从 DigitalPlat 读取当前 NS…
              </div>
            ) : (
              <div className="text-center py-4 bg-hovered rounded-xl border border-border-base text-content-muted text-xs">
                当前没有 NS。可在下方添加，或点「一键恢复默认」回到 DigitalPlat 托管。
              </div>
            )}
          </div>

          {/* 添加 NS 表单（解析后合并进草稿列表，保存时才提交） */}
          <div className="p-4 border border-border-base rounded-xl bg-hovered space-y-3">
            <h4 className="text-xs font-bold text-content-secondary">添加 / 变更 NS 服务器</h4>
            <div>
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <label htmlFor="dpnameservermodal-fld1" className="block text-[10px] text-content-muted font-bold uppercase">
                  NS 服务器地址
                </label>
                {parseNsInput(dpNsInput).length > 0 && (
                  <span className="text-[10px] text-accent font-semibold">
                    已识别 {parseNsInput(dpNsInput).length} 条
                  </span>
                )}
              </div>
              <Textarea id="dpnameservermodal-fld1" size="sm" mono resizable
                rows={3}
                placeholder={"每行一条，或用逗号/空格分隔，例如：\ndns1.digitalplat.org\ndns2.digitalplat.org"}
                value={dpNsInput}
                onChange={(e) => setDpNsInput(e.target.value)}
                className="w-full text-content-secondary"
              />
              <p className="text-[10px] text-content-muted mt-1">
                点「添加到列表」合并进上方草稿；最终以「保存替换」整组生效
              </p>
            </div>
            <button
              onClick={handleDpAddNsFromInput}
              disabled={parseNsInput(dpNsInput).length === 0}
              className="w-full btn-primary py-2.5 rounded-lg font-semibold text-xs text-white flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus className="w-3.5 h-3.5" />
              {parseNsInput(dpNsInput).length > 1
                ? `添加 ${parseNsInput(dpNsInput).length} 条到列表`
                : "添加到列表"}
            </button>
          </div>
        </div>

        {/* 底部操作 */}
        <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-end gap-3 border-t border-border-base flex-shrink-0">
          <button
            onClick={() => onClose()}
            disabled={dpNsSaving}
            className="text-xs font-semibold px-4 py-2 rounded-lg bg-elevated hover:bg-hovered text-content-secondary border border-border-base"
          >
            取消
          </button>
          <button
            onClick={handleDpSaveNameservers}
            disabled={dpNsSaving || dpNsList.length === 0}
            className={`text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 transition-all ${
              !dpNsSaving && dpNsList.length > 0
                ? "bg-accent-gradient hover:opacity-95 text-accent-contrast cursor-pointer shadow-lg shadow-accent"
                : "bg-elevated text-content-muted opacity-50 cursor-not-allowed"
            }`}
          >
            {dpNsSaving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            {dpNsSaving
              ? "正在保存…"
              : dpNsList.length > 0
                ? `保存替换（共 ${dpNsList.length} 条）`
                : "保存替换"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
