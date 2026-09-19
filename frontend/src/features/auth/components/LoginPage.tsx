import { AlertTriangle, Globe, LogIn, RefreshCw, ShieldCheck } from "lucide-react";
import type { ComponentProps } from "react";
import { Input } from "../../../components/form/Input";
import { PasswordInput } from "../../../components/form/PasswordInput";
import { ToastView } from "../../../components/feedback/ToastView";
import type { UseAuthSessionReturn } from "../hooks/useAuthSession";

/**
 * LoginPage —— 未登录时的登录 / 首次初始化页面
 *
 * JSX 从 App.tsx 逐字搬运（Phase 3）。DOM / className / 文案 / 字段 id 均未改，
 * 行为保持一致。
 *
 * WHY 抽出来：
 *   这块约 135 行的 JSX 是 auth 域唯一的「视图」，却留在 App.tsx 的 early-return 里，
 *   使 App 同时承担「应用装配」与「登录界面细节」两件事，也让 App 必须 import
 *   Input / PasswordInput / 四个只有登录页会用到的图标。
 *
 * WHY 整体接收 `auth` 对象而不是摊平成 18 个 props：
 *   登录页需要的每一个值都来自同一个 `useAuthSession()` 返回对象，逐个透传只会得到
 *   一份必然与 hook 漂移的重复签名（God Prop Driller）。本仓库既有同构先例：
 *   `RegisterPage({ scanner })` 与 `SettingsPage({ s })`。
 *
 * NOTE: 「鉴权状态未加载完成时先显示加载态」的判断一并迁入 —— `authStatusLoaded`
 *       在 App 内除这一处 gate 外没有其他消费点，留在 App 只是白占决策面。
 */
export interface LoginPageProps {
  /** 鉴权状态、登录/初始化表单与动作（见 features/auth/hooks/useAuthSession） */
  auth: UseAuthSessionReturn;
  /**
   * 当前 Toast —— 登录页在外壳之外，拿不到全局 Toast 层，需自行渲染一份。
   * NOTE: 类型从 ToastView 反推，避免在此重复声明 Toast 形状。
   */
  toast: ComponentProps<typeof ToastView>["toast"];
}

export function LoginPage({ auth, toast }: LoginPageProps) {
  const {
    authStatusLoaded,
    authInitialized,
    authTwoFaEnabled,
    loginNeeds2fa,
    loginUsername,
    setLoginUsername,
    loginPassword,
    setLoginPassword,
    loginTotp,
    setLoginTotp,
    loginLoading,
    loginError,
    setupUsername,
    setSetupUsername,
    setupPassword,
    setSetupPassword,
    setupPassword2,
    setSetupPassword2,
    handleLogin,
    handleSetup,
  } = auth;

  // 鉴权状态尚未加载完成时，先展示加载态，避免登录/初始化界面闪烁
  if (!authStatusLoaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-page text-content-primary">
        <RefreshCw className="w-6 h-6 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-page text-content-primary px-4">
      <div className="w-full max-w-sm bg-surface border border-border-base rounded-2xl shadow-2xl p-7 space-y-6">
        {/* 头部 LOGO */}
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="w-12 h-12 rounded-2xl bg-accent-gradient flex items-center justify-center shadow-lg shadow-accent">
            <Globe className="w-7 h-7 text-accent-contrast" />
          </div>
          <h1 className="text-xl font-black text-content-primary">Domain Hub</h1>
          <p className="text-xs text-content-muted">
            {authInitialized ? "请登录以管理您的免费域名资产" : "首次使用，请设置管理员账户"}
          </p>
        </div>

        {/* 错误提示 */}
        {loginError && (
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-50 border border-red-200 text-red-700 dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-400 text-xs">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{loginError}</span>
          </div>
        )}

        {authInitialized ? (
          /* ── 登录表单 ── */
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="app-fld1" className="text-xs font-semibold text-content-secondary">用户名</label>
              <Input id="app-fld1" size="lg"
                type="text"
                autoComplete="username"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                placeholder="管理员用户名"
                className="w-full text-content-primary placeholder:text-content-muted"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="app-fld2" className="text-xs font-semibold text-content-secondary">密码</label>
              <PasswordInput id="app-fld2"
                autoComplete="current-password"
                value={loginPassword}
                onChange={setLoginPassword}
                placeholder="登录密码"
                className="form-input w-full px-3.5 py-2.5 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
              />
            </div>
            {(authTwoFaEnabled || loginNeeds2fa) && (
              <div className="space-y-1.5">
                <label htmlFor="app-fld3" className="text-xs font-semibold text-content-secondary flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> 两步验证动态码
                </label>
                <Input id="app-fld3" size="lg" mono
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={loginTotp}
                  onChange={(e) => setLoginTotp(e.target.value)}
                  placeholder="身份验证器上的 6 位数字"
                  className="w-full text-content-primary placeholder:text-content-muted"
                />
              </div>
            )}
            <button
              type="submit"
              disabled={loginLoading}
              className="btn-primary w-full py-2.5 rounded-lg text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {loginLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
              {loginLoading ? "登录中..." : "登录"}
            </button>
          </form>
        ) : (
          /* ── 首次初始化表单 ── */
          <form onSubmit={handleSetup} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="app-fld4" className="text-xs font-semibold text-content-secondary">设置用户名</label>
              <Input id="app-fld4" size="lg"
                type="text"
                autoComplete="username"
                value={setupUsername}
                onChange={(e) => setSetupUsername(e.target.value)}
                placeholder="至少 3 个字符"
                className="w-full text-content-primary placeholder:text-content-muted"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="app-fld5" className="text-xs font-semibold text-content-secondary">设置密码</label>
              <PasswordInput id="app-fld5"
                autoComplete="new-password"
                value={setupPassword}
                onChange={setSetupPassword}
                placeholder="至少 8 个字符"
                className="form-input w-full px-3.5 py-2.5 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="app-fld6" className="text-xs font-semibold text-content-secondary">确认密码</label>
              <PasswordInput id="app-fld6"
                autoComplete="new-password"
                value={setupPassword2}
                onChange={setSetupPassword2}
                placeholder="再次输入密码"
                className="form-input w-full px-3.5 py-2.5 rounded-lg text-sm text-content-primary placeholder:text-content-muted"
              />
            </div>
            <button
              type="submit"
              disabled={loginLoading}
              className="btn-primary w-full py-2.5 rounded-lg text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {loginLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              {loginLoading ? "创建中..." : "创建管理员账户并进入"}
            </button>
          </form>
        )}

        {/* 登录页 Toast 通知 */}
      </div>

      {/* 登录页也需要 Toast 通知（限宽与换行同全局 Toast，理由见那处注释） */}
      <ToastView toast={toast} />
    </div>
  );
}
