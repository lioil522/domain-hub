import type { Dispatch, SetStateAction } from "react";
import { Input } from "../../../../components/form/Input";
import type { AppSettings } from "../../hooks/useSettings";

export interface SettingsRenewalProps { settings: AppSettings; setSettings: Dispatch<SetStateAction<AppSettings>> }
export function SettingsRenewal({ settings, setSettings }: SettingsRenewalProps) {
  return <div className="bg-surface border border-border-base rounded-2xl p-4 sm:p-5 space-y-4">
    <h3 className="font-bold text-content-primary">提醒、续期与静默同步</h3>
    <p className="text-xs text-content-muted">Cron 仅读取本地缓存提醒和续期，不更新域名列表或 DNS。关闭页面后完整同步暂停，断点保留。</p>
    <label className="flex items-center gap-2 text-content-primary"><input type="checkbox" checked={settings.auto_renew === "1"} onChange={e => setSettings(s => ({ ...s, auto_renew: e.target.checked ? "1" : "0" }))} />启用 DNSHE 自动续期</label>
    <label className="block text-sm text-content-primary">到期提醒天数（不是续期窗口）<Input type="number" min={1} max={3650} value={settings.renew_threshold_days} onChange={e => setSettings(s => ({ ...s, renew_threshold_days: e.target.value }))} /></label>
    <label className="block text-sm text-content-primary">DNSHE 允许自动续期窗口（天）<Input type="number" min={0} max={365} value={settings.dnshe_renew_window_days} onChange={e => setSettings(s => ({ ...s, dnshe_renew_window_days: e.target.value }))} /></label>
    <p className="text-xs text-content-muted">默认 0：不自动发送新续期。仅按可靠契约配置；未知写结果仅只读核验，不重复 POST。</p>
    <label className="flex items-center gap-2 text-content-primary"><input type="checkbox" checked={settings.login_sync_enabled === "true"} onChange={e => setSettings(s => ({ ...s, login_sync_enabled: e.target.checked ? "true" : "false" }))} />登录后静默完整同步（升级默认关闭）</label>
    <label className="block text-sm text-content-primary">完整同步新鲜度（秒）<Input type="number" min={60} max={86400} value={settings.sync_freshness_seconds} onChange={e => setSettings(s => ({ ...s, sync_freshness_seconds: e.target.value }))} /></label>
    <p className="text-xs text-content-muted">手动按钮可继续/重新同步；操作记录可显式取消，取消后不会自动恢复。仅完整成功更新新鲜度。</p>
  </div>;
}
