import { CheckCircle2, Key, Save, ShieldCheck, UserCheck } from "lucide-react";
import { Input } from "../../../../components/form/Input";
import { PasswordInput } from "../../../../components/form/PasswordInput";
import { QRCodeSVG } from "qrcode.react";

export interface SettingsSecurityProps {
  accountInfo: { username: string; two_fa_enabled: boolean };
  pwOld: string; setPwOld: (v: string) => void;
  pwNew: string; setPwNew: (v: string) => void;
  pwNew2: string; setPwNew2: (v: string) => void;
  pwNewUsername: string; setPwNewUsername: (v: string) => void;
  twoFaSetup: { secret: string; otpauth_uri: string } | null; setTwoFaSetup: (v: { secret: string; otpauth_uri: string } | null) => void;
  twoFaEnableToken: string; setTwoFaEnableToken: (v: string) => void;
  twoFaDisableToken: string; setTwoFaDisableToken: (v: string) => void;
  handleChangePassword: () => void;
  handleStart2faSetup: () => void;
  handleEnable2fa: () => void;
  handleDisable2fa: () => void;
  actionLoading: string | null;
}

export function SettingsSecurity(props: SettingsSecurityProps) {
  const { accountInfo, pwOld, setPwOld, pwNew, setPwNew, pwNew2, setPwNew2, pwNewUsername, setPwNewUsername, twoFaSetup, setTwoFaSetup, twoFaEnableToken, setTwoFaEnableToken, twoFaDisableToken, setTwoFaDisableToken, handleChangePassword, handleStart2faSetup, handleEnable2fa, handleDisable2fa, actionLoading } = props;
  return (
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

  );
}
