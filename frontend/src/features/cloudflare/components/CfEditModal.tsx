import { ModalOverlay } from "../../../components/ModalOverlay";
import { useState } from "react";
import { useAppData } from "../../../state/AppDataContext";
import { DateField } from "../../../components/form/DateField/DateField";
import { Input } from "../../../components/form/Input";
import { formatDate } from "../../../lib/display-domain";
import { normalizeDomainKey } from "../../../lib/domain-keys";
import { toUnicode } from "../../../punycode";
import { Info, Pencil, RefreshCw, X } from "lucide-react";
import type { Domain, CfExpiryEntry } from "../../../types/domain";

export interface CfEditModalProps {
  /** 是否可见（由父级 `cfEditOpen && cfEditZone` 守卫） */
  open: boolean;
  /** 当前编辑的 CF zone */
  zone: Domain | null;
  onClose: () => void;
  /** 到期信息本地缓存（来自 useCfExpiry） */
  cfExpiryMap: Record<string, CfExpiryEntry>;
  /** 到期信息缓存落盘（来自 useCfExpiry） */
  persistCfExpiryMap: (map: Record<string, CfExpiryEntry>, touchTs?: boolean) => void;
  /** 注册/到期信息的统一推导（来自 useCfExpiry，卡片与弹窗共用） */
  cfZoneDateInfo: (zone: Domain) => {
    autoRegisteredRaw?: string;
    autoExpiryRaw?: string;
    manualEntry?: CfExpiryEntry;
  };
}

/**
 * CF zone 注册信息手动编辑弹窗（注册时间 / 到期时间 / 注册来源）
 *
 * 从 `App.tsx` 抽出（Phase 5-4）。**纯搬运**：请求路径、字段语义、文案与注释逐字保留。
 *
 * 状态内聚（state-internalization）：`cfEditRegistered / cfEditExpiry / cfEditSource /
 * cfEditSaving` 由本组件持有，父级只保留 `cfEditOpen + cfEditZone` 触发器。父级以
 * `{cfEditOpen && cfEditZone && <CfEditModal/>}` 渲染 —— 关闭即卸载，下次打开重新挂载，
 * `useState` 初始化器恰好复现原 `openCfEditZone` 的「预填手动值 + 复位」行为。
 *
 * 依赖注入：`cfExpiryMap / persistCfExpiryMap / cfZoneDateInfo` 由 App 从 `useCfExpiry`
 * 取得后透传（该 hook 需要 activeTab/cfZones/domains/dpDomains/两个集合，无法在组件内自取）。
 */
export function CfEditModal({
  open,
  zone,
  onClose,
  cfExpiryMap,
  persistCfExpiryMap,
  cfZoneDateInfo,
}: CfEditModalProps) {
  const { apiFetch, showToast } = useAppData();


  // 转为 <input type="date"> 所需的 YYYY-MM-DD；无法解析（“永久”/“未记录”/空）时返回空串
  const toDateInputValue = (dateStr?: string | null) => {
    if (!dateStr) return "";
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(String(dateStr).trim());
    if (m) {
      return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    }
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return "";
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  };

  const [cfEditRegistered, setCfEditRegistered] = useState(() => {
    const info = zone ? cfZoneDateInfo(zone) : null;
    return info?.manualEntry?.registered_at ? toDateInputValue(info.manualEntry.registered_at) : "";
  });
  const [cfEditExpiry, setCfEditExpiry] = useState(() => {
    const info = zone ? cfZoneDateInfo(zone) : null;
    return info?.manualEntry?.expires_at ? toDateInputValue(info.manualEntry.expires_at) : "";
  });
  const [cfEditSource, setCfEditSource] = useState(() => (zone ? cfZoneDateInfo(zone).manualEntry?.source || "" : ""));
  const [cfEditSaving, setCfEditSaving] = useState(false);

  // 守卫：未打开 / 无 zone 时不渲染（父级已用 cfEditOpen && cfEditZone 守卫，这里再收窄一次）
  if (!open || !zone) return null;

  // 保存手动录入的注册/到期时间与来源（PUT 到后端随账号存储；成功后才更新本地缓存）。
  // 全空视为误触（应点「恢复自动查询」）。
  const handleCfSaveEdit = async () => {
    if (!zone) return;
    const key = normalizeDomainKey(String(zone.full_domain || ""));
    const registered = cfEditRegistered.trim();
    const expiry = cfEditExpiry.trim();
    const source = cfEditSource.trim();
    if (!registered && !expiry && !source) {
      showToast("error", "没有要保存的内容：清空全部后请用「恢复自动查询」");
      return;
    }
    setCfEditSaving(true);
    try {
      const res = await apiFetch(`/api/domains/${zone.id}/date-override`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          registered_at: registered || undefined,
          expires_at: expiry || undefined,
          source: source || undefined
        })
      });
      const data = await res.json();
      if (!data.success) {
        showToast("error", data.message || "保存失败");
        return;
      }
      const prev = cfExpiryMap[key];
      const nextEntry: CfExpiryEntry = {
        found: prev?.found ?? false,
        registered_at: registered || undefined,
        expires_at: expiry || undefined,
        source: source || undefined,
        manual: true
      };
      persistCfExpiryMap({ ...cfExpiryMap, [key]: nextEntry });
      onClose();
      showToast("success", data.message || "已保存，手动值将优先于自动查询");
    } catch {
      showToast("error", "保存请求失败，请检查网络后重试");
    } finally {
      setCfEditSaving(false);
    }
  };

  // 清除手动设置：DELETE 后端记录并移除本地缓存，后续进入 Cloudflare 页会重新自动查询
  const handleCfRestoreAuto = async () => {
    if (!zone) return;
    const key = normalizeDomainKey(String(zone.full_domain || ""));
    setCfEditSaving(true);
    try {
      const res = await apiFetch(`/api/domains/${zone.id}/date-override`, { method: "DELETE" });
      const data = await res.json();
      if (!data.success) {
        showToast("error", data.message || "恢复失败");
        return;
      }
      const next = { ...cfExpiryMap };
      delete next[key];
      persistCfExpiryMap(next);
      onClose();
      showToast("info", data.message || "已清除手动设置，恢复自动查询");
    } catch {
      showToast("error", "恢复请求失败，请检查网络后重试");
    } finally {
      setCfEditSaving(false);
    }
  };

  return (
    <ModalOverlay>
      <div role="dialog" aria-labelledby="cf-edit-modal-title" className="bg-surface border border-border-base w-full max-w-lg max-h-[90dvh] rounded-2xl overflow-hidden flex flex-col shadow-2xl">
        {/* 模态框头部 */}
        <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between gap-2 border-b border-border-base flex-shrink-0">
          <div className="min-w-0">
            <h3 id="cf-edit-modal-title" className="text-base sm:text-lg font-bold text-content-primary flex items-center gap-2">
              <Pencil className="text-sky-400 w-5 h-5 flex-shrink-0" />
              <span className="truncate">编辑注册信息（手动覆盖）</span>
            </h3>
            <p className="text-xs text-content-muted mt-0.5 font-mono truncate">
              域名: {toUnicode(zone.full_domain)}
            </p>
          </div>
          <button
            onClick={() => onClose()}
            disabled={cfEditSaving}
            className="text-content-muted hover:text-content-primary p-2 md:p-1 hover:bg-hovered rounded flex-shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 模态框内容 */}
        <div className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
          <div className="p-3.5 rounded-xl border border-sky-200 bg-sky-50 text-xs text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200 flex gap-2.5">
            <Info className="w-4 h-4 shrink-0 text-sky-500 mt-0.5" />
            <div className="space-y-1 leading-relaxed">
              <p>
                有些域名在注册商侧查不到（RDAP/WHOIS 无记录），自动查询会一直显示「—」。
                这里可自行录入<b>注册时间 / 到期时间 / 注册来源</b>。
              </p>
              <p>
                保存后填写过的手动值<b>优先于自动查询</b>，并<b>随账号保存在服务器</b>（换设备/浏览器也一致）；
                想回到自动数据时点「恢复自动查询」即可删除。
              </p>
            </div>
          </div>

          {/* 自动查询参考值提示（仅在有自动数据时展示，避免用户重复录入） */}
          {(() => {
            const info = zone ? cfZoneDateInfo(zone) : null;
            if (!info || (!info.autoRegisteredRaw && !info.autoExpiryRaw)) return null;
            return (
              <p className="text-[11px] text-content-muted leading-relaxed">
                自动查询参考值：注册{" "}
                {info.autoRegisteredRaw ? formatDate(info.autoRegisteredRaw, false) : "—"} · 到期{" "}
                {info.autoExpiryRaw ? formatDate(info.autoExpiryRaw, true) : "—"}
                （注册留空沿用自动值；到期留空视为「永久」）
              </p>
            );
          })()}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <span className="block text-xs font-semibold text-content-secondary mb-1.5">
                注册时间
              </span>
              <DateField ariaLabel="注册时间"
                value={cfEditRegistered}
                onChange={setCfEditRegistered}
                minYear={1986}
                maxYear={new Date().getFullYear()}
                className="w-full form-input px-3 py-2 rounded-lg text-sm text-content-secondary"
              />
            </div>
            <div>
              <span className="block text-xs font-semibold text-content-secondary mb-1.5">
                到期时间 <span className="font-normal text-content-muted">（留空 = 永久）</span>
              </span>
              <DateField ariaLabel="到期时间 （留空 = 永久）"
                value={cfEditExpiry}
                onChange={setCfEditExpiry}
                minYear={new Date().getFullYear()}
                maxYear={2999}
                className="w-full form-input px-3 py-2 rounded-lg text-sm text-content-secondary"
              />
            </div>
          </div>

          <div>
            <label htmlFor="cfeditmodal-fld1" className="block text-xs font-semibold text-content-secondary mb-1.5">
              注册来源（选填）
            </label>
            <Input id="cfeditmodal-fld1" size="sm"
              type="text"
              value={cfEditSource}
              onChange={(e) => setCfEditSource(e.target.value)}
              maxLength={80}
              placeholder="如：Namecheap / GoDaddy / 赠送 / 自有注册商"
              className="w-full text-content-secondary"
            />
          </div>
        </div>

        {/* 底部操作 */}
        <div className="bg-elevated px-4 sm:px-6 py-4 flex items-center justify-between gap-3 border-t border-border-base flex-shrink-0">
          {cfExpiryMap[normalizeDomainKey(String(zone.full_domain || ""))]?.manual ? (
            <button
              onClick={handleCfRestoreAuto}
              disabled={cfEditSaving}
              className="text-xs font-semibold px-3 py-2 rounded-lg bg-elevated hover:bg-hovered text-amber-600 dark:text-amber-400 border border-border-base transition-colors"
              title="删除服务器与本地的手动设置，下次进入将重新自动查询"
            >
              恢复自动查询
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={() => onClose()}
              disabled={cfEditSaving}
              className="text-xs font-semibold px-4 py-2 rounded-lg bg-elevated hover:bg-hovered text-content-secondary border border-border-base transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleCfSaveEdit}
              disabled={cfEditSaving || (!cfEditRegistered.trim() && !cfEditExpiry.trim() && !cfEditSource.trim())}
              className={`text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5 transition-all ${
                !cfEditSaving && (cfEditRegistered.trim() || cfEditExpiry.trim() || cfEditSource.trim())
                  ? "bg-accent-gradient hover:opacity-95 text-accent-contrast cursor-pointer shadow-lg shadow-accent"
                  : "bg-elevated text-content-muted opacity-50 cursor-not-allowed"
              }`}
            >
              {cfEditSaving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              保存手动值
            </button>
          </div>
        </div>
      </div>
    </ModalOverlay>
  );
}
