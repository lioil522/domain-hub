import type { Dispatch, SetStateAction } from "react";
import { Bell, Send } from "lucide-react";
import { Input } from "../../../../components/form/Input";
import { CustomSelect } from "../../../../components/form/CustomSelect";
import type { AppSettings } from "../../hooks/useSettings";

export interface SettingsNotificationsProps {
  settings: AppSettings;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  settingsConfigured: { tg_token: boolean; webhook_url: boolean };
  handleTestTelegram: () => void;
  handleTestWebhook: () => void;
  actionLoading: string | null;
}

export function SettingsNotifications(props: SettingsNotificationsProps) {
  const { settings, setSettings, settingsConfigured, handleTestTelegram, handleTestWebhook, actionLoading } = props;
  return (
          <div className="bg-surface border border-border-base rounded-2xl p-4 sm:p-5 space-y-4">
            <h3 className="font-bold text-content-primary flex items-center gap-2">
              <Bell className="w-4 h-4 text-amber-400" /> 通知渠道
            </h3>

            {/* Telegram */}
            <div className="space-y-3">
              <div className="text-sm font-semibold text-content-primary flex items-center gap-1.5">
                <Send className="w-4 h-4 text-sky-400" /> Telegram
              </div>
              <Input size="sm"
                value={settings.tg_token}
                onChange={(e) => setSettings((s) => ({ ...s, tg_token: e.target.value }))}
                placeholder={settingsConfigured.tg_token ? "已配置（留空不修改）" : "Bot Token"}
                className="w-full text-content-primary placeholder:text-content-muted"
              />
              <div className="flex flex-col sm:flex-row gap-2">
                <Input size="sm"
                  value={settings.tg_chat_id}
                  onChange={(e) => setSettings((s) => ({ ...s, tg_chat_id: e.target.value }))}
                  placeholder="Chat ID"
                  className="flex-1 text-content-primary placeholder:text-content-muted"
                />
                <button
                  onClick={handleTestTelegram}
                  disabled={actionLoading === "test-tg"}
                  className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-4 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50 flex-shrink-0"
                >
                  <Send className="w-4 h-4" /> 测试推送
                </button>
              </div>
            </div>

            {/* Webhook */}
            <div className="space-y-3 pt-3 border-t border-border-soft">
              <div className="text-sm font-semibold text-content-primary">Webhook</div>
              <Input size="sm"
                value={settings.webhook_url}
                onChange={(e) => setSettings((s) => ({ ...s, webhook_url: e.target.value }))}
                placeholder={
                  settingsConfigured.webhook_url
                    ? "已配置（留空不修改）"
                    : settings.webhook_type === "serverchan"
                    ? "SendKey，如 SCTxxxxxxxxxxxxxxxx"
                    : "Webhook URL"
                }
                className="w-full text-content-primary placeholder:text-content-muted"
              />
              <div className="flex flex-col sm:flex-row gap-2">
                <CustomSelect
                  value={settings.webhook_type}
                  onChange={(v) => setSettings((s) => ({ ...s, webhook_type: v }))}
                  ariaLabel="Webhook 类型"
                  options={[
                    { value: "custom", label: "通用 (custom)" },
                    { value: "dingtalk", label: "钉钉 (dingtalk)" },
                    { value: "feishu", label: "飞书 (feishu)" },
                    { value: "wecom", label: "企业微信 (wecom)" },
                    { value: "serverchan", label: "Server酱 · 方糖 (serverchan)" },
                  ]}
                  className="flex-1 px-3 py-2 rounded-lg text-sm text-content-primary"
                />
                <button
                  onClick={handleTestWebhook}
                  disabled={actionLoading === "test-webhook"}
                  className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-4 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50 flex-shrink-0"
                >
                  <Send className="w-4 h-4" /> 测试推送
                </button>
              </div>
              <p className="text-[11px] text-content-muted leading-relaxed">
                {settings.webhook_type === "serverchan" ? (
                  <>
                    直接填 Server酱 控制台首页的 <b>SendKey</b> 即可，系统会自动补全推送地址
                    （Turbo 版与 Server酱³ 都支持）；<b>不要</b>填「快速创建入口链接」那种网页地址。
                  </>
                ) : (
                  <>平台类型要与 URL 来源对上，否则对方会因字段名不认而拒收。</>
                )}
                {" "}续期报告只在<b>确实有域名被续期时</b>推送，平时不会有心跳消息；推送失败会在「运行日志」里留一条 warning。
              </p>
            </div>
          </div>
  );
}
