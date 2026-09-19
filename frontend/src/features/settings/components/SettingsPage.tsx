import {
  Settings,
  RefreshCw,
  Palette,
  Server,
  CheckCircle2,
  Info,
  Save,
  Pencil,
  ShieldCheck,
  UserCheck,
  Key,
  Send,
  Bell,
  DatabaseBackup,
  AlertTriangle,
  Download,
  Upload,
} from "lucide-react";
import { Input } from "../../../components/form/Input";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "../../../components/Button";
import { CustomSelect } from "../../../components/form/CustomSelect";
import { PasswordInput } from "../../../components/form/PasswordInput";
import { ThemePicker } from "../../../components/ThemePicker";
import { THEME_LABELS, type ThemeId } from "../../../theme";
import type { UseSettingsReturn } from "../hooks/useSettings";

/**
 * SettingsPage —— 设置标签页（外观 / 后端地址 / 账户安全 / 自动续期 / 通知 / 数据备份）
 *
 * JSX 从 App.tsx 逐字搬运（Phase 12）。状态与动作见 features/settings/hooks/useSettings；
 * 明暗主题（theme）、配色主题（colorTheme）、后端地址、数据导入导出触发等跨页值仍由 App 注入。
 */
export interface SettingsPageProps {
  /** 设置页状态与动作（见 useSettings） */
  s: UseSettingsReturn;
  /** 明暗主题（顶栏共用） */
  theme: "light" | "dark";
  setTheme: (updater: (t: "light" | "dark") => "light" | "dark") => void;
  /** 配色主题（与明暗正交） */
  colorTheme: ThemeId;
  setColorTheme: (id: ThemeId) => void;
  /** 当前后端地址（已配置时非空） */
  backendUrl: string;
  /** 打开数据导入 / 导出二次验证弹窗 */
  onOpenDataOp: (mode: "export" | "import") => void;
}

export function SettingsPage(props: SettingsPageProps) {
  const { s, theme, setTheme, colorTheme, setColorTheme, backendUrl, onOpenDataOp } = props;
  const {
    settings,
    setSettings,
    settingsConfigured,
    loadingSettings,
    backendUrlInput,
    setBackendUrlInput,
    backendUrlEditing,
    setBackendUrlEditing,
    pwOld,
    setPwOld,
    pwNew,
    setPwNew,
    pwNew2,
    setPwNew2,
    pwNewUsername,
    setPwNewUsername,
    twoFaSetup,
    setTwoFaSetup,
    twoFaEnableToken,
    setTwoFaEnableToken,
    twoFaDisableToken,
    setTwoFaDisableToken,
    handleSaveSettings,
    handleTestTelegram,
    handleTestWebhook,
    handleSaveBackendUrl,
    handleCancelBackendUrl,
    handleChangePassword,
    handleStart2faSetup,
    handleEnable2fa,
    handleDisable2fa,
    accountInfo,
    actionLoading,
  } = s;

  return (
    <div className="space-y-6 max-w-3xl pt-5 md:pt-6">
      <div>
        <h2 className="text-2xl font-black text-content-primary flex items-center gap-2">
          <Settings className="w-6 h-6 text-accent" /> 设置
        </h2>
        <p className="text-content-muted mt-1 text-sm">外观、系统配置、通知渠道与自动续期策略</p>
      </div>

      {loadingSettings ? (
        <div className="flex justify-center py-20">
          <RefreshCw className="w-6 h-6 animate-spin text-accent" />
        </div>
      ) : (
        <>
          {/* ── 外观 ────────────────────────────────────────────────
              NOTE: 这里原本只有一个「主题模式」卡片，与顶栏的日/月按钮
              完全同源（都改 theme 这一个 state），属重复入口，曾被移除。
              现在重新加回来，但职责不同 —— 它管的是「配色身份」这个
              新维度（colorTheme），顶栏那个仍管明暗。两个开关正交，
              用户在设置页能同时看到两种外观维度，不会误以为是同一个。 */}
          <div className="bg-surface border border-border-base rounded-2xl p-4 sm:p-5 space-y-4">
            <h3 className="font-bold text-content-primary flex items-center gap-2">
              <Palette className="w-4 h-4 text-accent" /> 外观
            </h3>

            <div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-3">
                <span className="text-sm font-semibold text-content-primary">配色主题</span>
                <span className="text-[11px] text-content-muted">与明暗模式独立，可自由组合</span>
              </div>

              <ThemePicker value={colorTheme} onChange={setColorTheme} />

              <p className="text-[11px] text-content-muted mt-3 leading-relaxed">
                当前为
                <b className="text-content-secondary">
                  {" "}{THEME_LABELS[colorTheme]}{" "}
                </b>
                ×
                <b className="text-content-secondary">
                  {" "}{theme === "dark" ? "暗色" : "亮色"}{" "}
                </b>
                组合。选择会保存在本机浏览器，下次打开直接生效。
              </p>
            </div>

            <div className="pt-3 border-t border-border-soft flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-content-primary">暗色模式</div>
                <div className="text-xs text-content-muted mt-0.5">
                  深色界面适合夜间与弱光环境；顶栏右上角也有快捷开关
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={theme === "dark"}
                aria-label="暗色模式"
                onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                className={`w-12 h-6 rounded-full transition-all relative flex-shrink-0 ${
                  theme === "dark" ? "bg-accent" : "bg-elevated border border-border-base"
                }`}
              >
                <span
                  className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
                    theme === "dark" ? "left-6" : "left-0.5"
                  }`}
                />
              </button>
            </div>
          </div>
          {/* NOTE: 这里原有一个「外观 / 主题模式」卡片，与顶栏的太阳/月亮切换按钮
              完全同源（都改 theme 这一个 state），属重复入口，已移除。
              主题切换保留在顶栏，任何页面都能直接点到，不必先进设置页。 */}

          {/* 后端地址 */}
          <div className="bg-surface border border-border-base rounded-2xl p-4 sm:p-5 space-y-4">
            <h3 className="font-bold text-content-primary flex items-center gap-2">
              <Server className="w-4 h-4 text-accent" /> 后端地址
            </h3>

            {backendUrlEditing ? (
              <div>
                <label htmlFor="settingspage-fld1" className="text-sm font-semibold text-content-primary">后端 Worker 地址</label>
                <div className="flex gap-2 mt-2">
                  <Input id="settingspage-fld1" size="sm"
                    value={backendUrlInput}
                    onChange={(e) => setBackendUrlInput(e.target.value)}
                    placeholder="https://domain-hub.<子域>.workers.dev"
                    className="flex-1 text-content-primary placeholder:text-content-muted"
                  />
                  <button onClick={handleSaveBackendUrl} className="btn-primary px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5">
                    <Save className="w-4 h-4" /> 保存
                  </button>
                  <button onClick={handleCancelBackendUrl} className="bg-elevated hover:bg-hovered text-content-muted border border-border-base px-4 py-2 rounded-lg text-sm">
                    取消
                  </button>
                </div>
                <p className="text-xs text-content-muted mt-2">保存后刷新页面生效；清空保存可恢复自动推演。</p>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm min-w-0">
                  {backendUrl ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                      <span className="text-content-primary">已配置自定义后端地址</span>
                    </>
                  ) : (
                    <>
                      <Info className="w-4 h-4 text-content-muted flex-shrink-0" />
                      <span className="text-content-muted">未配置，使用自动推演</span>
                    </>
                  )}
                </div>
                <button
                  onClick={() => { setBackendUrlInput(localStorage.getItem("DOMAIN_HUB_BACKEND_URL") || ""); setBackendUrlEditing(true); }}
                  className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 flex-shrink-0"
                >
                  <Pencil className="w-3.5 h-3.5" /> {backendUrl ? "修改" : "配置"}
                </button>
              </div>
            )}
          </div>

          {/* 账户安全：修改密码 + 两步验证 */}
          <div className="bg-surface border border-border-base rounded-2xl p-4 sm:p-5 space-y-5">
            <h3 className="font-bold text-content-primary flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" /> 账户安全
            </h3>

            {/* 当前账户 */}
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-content-muted flex-shrink-0">当前管理员</span>
              <span className="font-mono font-semibold text-content-primary flex items-center gap-1.5 min-w-0">
                <UserCheck className="w-4 h-4 text-accent flex-shrink-0" />
                <span className="truncate">{accountInfo.username || "—"}</span>
              </span>
            </div>

            {/* 修改密码 */}
            <div className="space-y-3 pt-3 border-t border-border-soft">
              <div className="text-sm font-semibold text-content-primary flex items-center gap-1.5">
                <Key className="w-4 h-4 text-amber-400" /> 修改登录密码
              </div>
              {/*
                NOTE: 这里刻意不用 autoComplete="current-password" / "username"。
                Chrome 是「成对」填充凭据的：只要表单里存在一个 current-password
                目标，它就会连带去找用户名字段填上。上一版把这两个语义标注补齐后，
                填充确实不再跑到页头搜索框，但改成精准落进「原密码 + 同时修改用户名」，
                等于换了个地方犯同样的毛病——修改密码表单被预填本来就不是我们想要的。
                把三个密码框统一标成 new-password（表单内不存在可填充的凭据目标），
                Chrome 就不会发起这次凭据填充，也就不会再去找用户名字段。
                name 也故意取成不像 username 的值，避免命中它的启发式。
              */}
              <PasswordInput
                name="dnshe-old-password"
                autoComplete="new-password"
                value={pwOld}
                onChange={setPwOld}
                placeholder="原密码"
                className="form-input w-full px-3 py-2 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <PasswordInput
                  name="dnshe-new-password"
                  autoComplete="new-password"
                  value={pwNew}
                  onChange={setPwNew}
                  placeholder="新密码（至少 8 位）"
                  className="form-input w-full px-3 py-2 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                />
                <PasswordInput
                  name="dnshe-new-password-confirm"
                  autoComplete="new-password"
                  value={pwNew2}
                  onChange={setPwNew2}
                  placeholder="确认新密码"
                  className="form-input w-full px-3 py-2 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
                />
              </div>
              <Input size="sm"
                type="text"
                name="dnshe-rename"
                autoComplete="off"
                value={pwNewUsername}
                onChange={(e) => setPwNewUsername(e.target.value)}
                placeholder={`同时修改用户名（可选，当前：${accountInfo.username || "admin"}）`}
                className="w-full text-content-primary placeholder:text-content-muted"
              />
              <div className="flex justify-end">
                <button
                  onClick={handleChangePassword}
                  disabled={actionLoading === "change-pw"}
                  className="btn-primary px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Save className="w-4 h-4" /> 保存新密码
                </button>
              </div>
              <p className="text-[11px] text-content-muted">修改成功后当前会话将失效，需用新凭据重新登录。</p>
            </div>

            {/* 两步验证 (2FA) */}
            <div className="space-y-3 pt-3 border-t border-border-soft">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-content-primary flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-400 flex-shrink-0" /> 两步验证 (2FA / TOTP)
                  </div>
                  <div className="text-xs text-content-muted mt-0.5">开启后登录需额外输入身份验证器的 6 位动态码</div>
                </div>
                <span className={`text-xs px-2.5 py-1 rounded-full font-semibold self-start sm:self-auto flex-shrink-0 ${accountInfo.two_fa_enabled ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400" : "bg-elevated text-content-muted border border-border-base"}`}>
                  {accountInfo.two_fa_enabled ? "已开启" : "未开启"}
                </span>
              </div>

              {/* 未开启：走生成密钥 → 验证动态码 流程 */}
              {!accountInfo.two_fa_enabled && (
                <div className="space-y-3">
                  {!twoFaSetup ? (
                    <button
                      onClick={handleStart2faSetup}
                      disabled={actionLoading === "2fa-setup"}
                      className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <ShieldCheck className="w-4 h-4 text-emerald-400" /> 开启两步验证
                    </button>
                  ) : (
                    <div className="bg-elevated border border-border-base rounded-xl p-4 space-y-3">
                      <p className="text-xs text-content-secondary leading-relaxed">
                        1. 用身份验证器（Google / Microsoft Authenticator）扫描下方二维码：
                      </p>
                      <div className="flex justify-center py-2">
                        <div className="bg-white p-3 rounded-xl">
                          <QRCodeSVG value={twoFaSetup.otpauth_uri} size={176} level="M" includeMargin={false} />
                        </div>
                      </div>
                      <p className="text-[11px] text-content-muted">
                        无法扫码时，可在验证器中手动录入以下密钥：
                      </p>
                      <div className="font-mono text-sm bg-surface border border-border-base rounded-lg px-3 py-2 break-all text-accent select-all text-center tracking-wider">
                        {twoFaSetup.secret}
                      </div>
                      <p className="text-xs text-content-secondary">2. 输入验证器当前显示的 6 位动态码以完成开启：</p>
                      <div className="flex flex-wrap gap-2">
                        <Input size="sm" mono
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          value={twoFaEnableToken}
                          onChange={(e) => setTwoFaEnableToken(e.target.value.replace(/\D/g, ""))}
                          placeholder="6 位动态码"
                          className="flex-1 text-content-primary placeholder:text-content-muted"
                        />
                        <button
                          onClick={handleEnable2fa}
                          disabled={actionLoading === "2fa-enable"}
                          className="btn-primary px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
                        >
                          <CheckCircle2 className="w-4 h-4" /> 确认开启
                        </button>
                        <button
                          onClick={() => { setTwoFaSetup(null); setTwoFaEnableToken(""); }}
                          className="bg-elevated hover:bg-hovered text-content-muted border border-border-base px-3 py-2 rounded-lg text-sm"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* 已开启：输入当前动态码确认关闭 */}
              {accountInfo.two_fa_enabled && (
                <div className="flex flex-wrap gap-2">
                  <Input size="sm" mono
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={twoFaDisableToken}
                    onChange={(e) => setTwoFaDisableToken(e.target.value.replace(/\D/g, ""))}
                    placeholder="输入身份验证器当前 6 位动态码"
                    className="flex-1 text-content-primary placeholder:text-content-muted"
                  />
                  <button
                    onClick={handleDisable2fa}
                    disabled={actionLoading === "2fa-disable"}
                    className="bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 dark:bg-red-500/10 dark:hover:bg-red-500/20 dark:text-red-400 dark:border-red-500/30 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
                  >
                    关闭 2FA
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 自动续期 */}
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

          {/* 通知 */}
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

          {/* 保存按钮 */}
          <div className="flex justify-end">
            {/*
              NOTE: 这里原先写的是 text-content-primary，压在 btn-primary 的
              品牌渐变上。亮色主题下 --text-primary 是近黑色（#0f172a），
              在靛蓝渐变上对比度只有 1.9:1，按钮文字几乎看不清 ——
              而且它跟着明暗主题变，暗色下又变成白色，等于同一个按钮
              在两种主题下有两种（其中一种是错的）前景色。
              正确做法是让颜色由强调色对比令牌决定：用 Button 组件的
              primary variant，它已经处理好了 accent-contrast。
            */}
            <Button
              variant="primary"
              size="md"
              icon={<Save className="w-4 h-4" />}
              loading={actionLoading === "save-settings"}
              onClick={handleSaveSettings}
              className="px-6"
            >
              保存全部设置
            </Button>
          </div>

          {/* 数据备份：导出需要 2FA（未配置 2FA 时禁用导出） */}
          <div className="bg-surface border border-border-base rounded-2xl p-4 sm:p-5 space-y-4">
            <h3 className="font-bold text-content-primary flex items-center gap-2">
              <DatabaseBackup className="w-4 h-4 text-sky-400" /> 数据备份与迁移
            </h3>
            <p className="text-xs text-content-muted leading-relaxed">
              导出账号、域名缓存、自定义分组与日期覆盖等<b>业务数据</b>为 JSON 快照。
              不含登录凭据、2FA 密钥、运行日志与临时缓存。
            </p>

            {/* 2FA 未开启时的阻断提示 —— 后端也会强制拒绝，这里只是提前告知 */}
            {!accountInfo.two_fa_enabled && (
              <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 rounded-xl p-3 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                  <b>导出功能需要先开启两步验证（2FA）。</b>
                  导出等于把全部账号凭据与域名数据一次性打包带走，仅凭登录会话不足以保护。
                  请在上方「账户安全」中开启 2FA 后再导出。
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => onOpenDataOp("export")}
                disabled={!accountInfo.two_fa_enabled}
                title={accountInfo.two_fa_enabled ? "导出全部业务数据" : "需先开启两步验证（2FA）"}
                className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Download className="w-4 h-4 text-sky-400" /> 导出数据
              </button>
              <button
                onClick={() => onOpenDataOp("import")}
                className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5"
              >
                <Upload className="w-4 h-4 text-emerald-400" /> 导入数据
              </button>
            </div>

            <p className="text-[11px] text-content-muted leading-relaxed">
              导入为<b>合并模式</b>：同 ID 覆盖、新 ID 新增，<b>不会删除</b>任何现有数据，可安全重复导入。
              跨环境迁移时目标环境需使用同一个 <span className="font-mono">AES_KEY</span>，否则加密的 API 凭据无法解密。
            </p>
          </div>
        </>
      )}
    </div>
  );
}
