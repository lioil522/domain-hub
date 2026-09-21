import type { Dispatch, SetStateAction } from "react";
import { RefreshCw } from "lucide-react";
import { Input } from "../../../../components/form/Input";
import type { AppSettings } from "../../hooks/useSettings";

export interface SettingsRenewalProps {
  settings: AppSettings;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
}

export function SettingsRenewal({ settings, setSettings }: SettingsRenewalProps) {
  return (
          <div className="bg-surface border border-border-base rounded-2xl p-4 sm:p-5 space-y-4">
            <h3 className="font-bold text-content-primary flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-emerald-400" /> 自动续期
            </h3>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-content-primary">启用自动续期</div>
                <div className="text-xs text-content-muted mt-0.5">定时任务自动为即将到期的域名续期</div>
              </div>
              <button
                onClick={() => setSettings((s) => ({ ...s, auto_renew: s.auto_renew === "1" ? "0" : "1" }))}
                role="switch"
                aria-checked={settings.auto_renew === "1"}
                aria-label="启用自动续期"
                className={`w-12 h-6 rounded-full transition-all relative flex-shrink-0 ${settings.auto_renew === "1" ? "bg-accent" : "bg-elevated border border-border-base"}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${settings.auto_renew === "1" ? "left-6" : "left-0.5"}`} />
              </button>
            </div>
            <div className="pt-2 border-t border-border-soft">
              <label htmlFor="settingspage-fld2" className="text-sm font-semibold text-content-primary">续期 / 到期提醒阈值（天）</label>
              <p className="text-xs text-content-muted mt-0.5 mb-2">剩余有效期低于此值时触发 DNSHE 自动续期，并对自定义服务商 / DigitalPlat 域名发送到期提醒；结果会通过通知渠道推送</p>
              <Input id="settingspage-fld2" size="sm"
                type="number"
                value={settings.renew_threshold_days}
                onChange={(e) => setSettings((s) => ({ ...s, renew_threshold_days: e.target.value }))}
                className="w-full text-content-primary"
              />
            </div>
            <div className="pt-2 border-t border-border-soft flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-content-primary">定时同步复用解析记录缓存</div>
                <div className="text-xs text-content-muted mt-0.5">关闭后定时任务每次都全额回源拉取每个域名的解析记录，子请求开销大（免费计划 50 次配额下容易超限）；手动同步始终全额回源</div>
              </div>
              <button
                onClick={() => setSettings((s) => ({ ...s, dns_records_cache_mode: s.dns_records_cache_mode === "scheduled" ? "always" : "scheduled" }))}
                role="switch"
                aria-checked={settings.dns_records_cache_mode === "scheduled"}
                aria-label="定时同步复用解析记录缓存"
                className={`w-12 h-6 rounded-full transition-all relative flex-shrink-0 ${settings.dns_records_cache_mode === "scheduled" ? "bg-accent" : "bg-elevated border border-border-base"}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${settings.dns_records_cache_mode === "scheduled" ? "left-6" : "left-0.5"}`} />
              </button>
            </div>
          </div>
  );
}
