import { useEffect, useState, type FormEvent } from "react";
import { readSessionToken, type ApiFetch } from "../../../api/client";
import type { ToastType } from "../../../hooks/useToast";
import {
  fetchAccount,
  fetchAuthStatus,
  login as loginRequest,
  logout as logoutRequest,
  setup as setupRequest,
} from "../api/auth-api";
import type { AccountInfo } from "../types";

/**
 * NOTE: `AccountInfo` 与各端点的响应形状已下沉到 `../types`（Phase 3），
 *       HTTP 调用本身下沉到 `../api/auth-api`。这里保留 `AccountInfo` 的再导出，
 *       让既有 `import type { AccountInfo } from ".../useAuthSession"` 的调用点
 *       不必在同一次提交里全部改动（先迁移、再收口）。
 */
export type { AccountInfo };

export interface UseAuthSessionDeps {
  /**
   * 会话 Token 与其 setter —— **不归本 hook 所有**，由 AppDataProvider 持有
   * （多个 features 都要读 token 才能发请求）。本 hook 只在登录/登出时改写它。
   */
  sessionToken: string | null;
  setSessionToken: (token: string | null) => void;
  apiFetch: ApiFetch;
  showToast: (type: ToastType, message: string) => void;
  /** 仅用于登录失败提示里回显「当前实际请求的地址」 */
  backendUrl: string;
}

/**
 * useAuthSession —— 鉴权 / 登录 / 首次初始化 / 退出登录 / 账户安全信息
 *
 * WHY 抽成 hook：
 * 「后端查鉴权状态 → 决定登录页展示"登录"还是"首次设置" → 提交登录（可能补 2FA 动态码）
 *  → 或首次初始化 → 会话建立 → 登出清理」是一条完整生命周期，原先连同它的表单受控状态
 * 一起平铺在 App 顶部（约 190 行），把真正的页面装配逻辑挤到了很后面。抽出来后 App 只
 * 做一次解构，鉴权流程整体可在这一个文件里通读。
 *
 * 关键不变量：
 * - **登出必须清 `DOMAIN_HUB_CACHED_ACCOUNTS`**：账号列表有本地缓存，只清 token 会让
 *   下一个登录者短暂看到上一个账户的账号列表。
 * - **`localStorage` 的 `DOMAIN_HUB_SESSION` 也要清**：它有历史遗留写入路径，只清
 *   sessionStorage 不足以登出（见 handleLogout 内注释）。
 * - **`persistSession` 刻意不写回 `backendUrl`**：理由见其函数体上方长注释（会把部署期
 *   推导出的后端地址永久冻结，换域名后只能靠清站点数据恢复）。
 * - 鉴权状态 effect 只在**未登录**时跑（`if (sessionToken) return;`），与 App 里那些
 *   `if (!sessionToken) return;` 的取数 effect 互斥，因此它被本 hook 上移到更早的调用点，
 *   不会改变任何请求的相对顺序。
 */
export function useAuthSession({
  sessionToken,
  setSessionToken,
  apiFetch,
  showToast,
  backendUrl,
}: UseAuthSessionDeps) {
  // ===== 鉴权与登录状态 =====
  // 是否已向后端查询过鉴权状态（决定登录页显示"登录"还是"首次设置"）
  const [authStatusLoaded, setAuthStatusLoaded] = useState(false);
  // 系统是否已初始化（设置过管理员密码）
  const [authInitialized, setAuthInitialized] = useState(true);
  // 系统是否已开启 2FA（登录页直接展示动态码输入框）
  const [authTwoFaEnabled, setAuthTwoFaEnabled] = useState(false);
  // 本次登录是否需要 2FA 动态码（后端返回 need_2fa 时置真）
  const [loginNeeds2fa, setLoginNeeds2fa] = useState(false);

  // 登录表单状态
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginTotp, setLoginTotp] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");

  // 首次初始化表单状态
  const [setupUsername, setSetupUsername] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupPassword2, setSetupPassword2] = useState("");

  // ===== 账户安全（设置页）状态 =====
  const [accountInfo, setAccountInfo] = useState<AccountInfo>({ username: "", two_fa_enabled: false });

  // NOTE: 这里原先有一份 checkAuthStatus() + 无依赖 useEffect，会在挂载时无条件
  //       请求一次 /api/auth/status。它与下面 [sessionToken] 那个 effect 完全重复：
  //       未登录时冷加载会把这个接口打两遍，已登录时这一次请求的结果又根本用不上
  //       （authStatusLoaded 只在未登录分支里被读取）。已删除，只保留会在已登录时
  //       提前 return 的那一个。

  // 未登录时向后端查询鉴权状态，决定登录页展示"登录"还是"首次设置"
  useEffect(() => {
    if (sessionToken) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchAuthStatus(apiFetch);
        if (!cancelled && data.success) {
          setAuthInitialized(!!data.initialized);
          setAuthTwoFaEnabled(!!data.two_fa_enabled);
        }
      } catch (e) {
        // 网络异常时保持默认（已初始化），仍展示登录表单
      } finally {
        if (!cancelled) setAuthStatusLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionToken]);

  // 保存会话 Token 并进入系统
  //
  // NOTE: 这里刻意不再把 backendUrl 写回 localStorage。backendUrl 在用户没有手动配置时
  //       等于构建期烘焙的 VITE_API_BASE_URL，一旦登录成功就被冻结进 localStorage，
  //       而 localStorage 的优先级又高于烘焙值 —— 之后 CI 重新检测出的新后端地址会被
  //       这个旧值永久遮蔽（部署流水线每次都会重新推导该地址：自定义域名 → workers.dev
  //       子域 → 空），表现为换域名/换后端后登录一直 Failed to fetch，且只能靠清站点数据恢复。
  //       localStorage 只应保存用户在设置页显式填写的覆盖值。
  const persistSession = (token: string) => {
    sessionStorage.setItem("DOMAIN_HUB_SESSION", token);
    setSessionToken(token);
  };

  // 提交登录（用户名 + 密码，若后端要求则附带 2FA 动态码）
  const handleLogin = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    setLoginError("");

    if (!loginUsername.trim() || !loginPassword) {
      setLoginError("请输入用户名与密码");
      return;
    }
    if (authTwoFaEnabled && !loginTotp.trim()) {
      setLoginError("请输入 6 位动态验证码");
      return;
    }

    setLoginLoading(true);
    try {
      const data = await loginRequest(apiFetch, {
        username: loginUsername.trim(),
        password: loginPassword,
        token: loginTotp.trim() || undefined,
      });

      if (data.success && data.session_token) {
        persistSession(data.session_token);
        setLoginPassword("");
        setLoginTotp("");
        setLoginNeeds2fa(false);
        showToast("success", data.message || "🎉 登录成功");
      } else if (data.error_code === "need_2fa") {
        // 密码正确但需要补充动态码
        setLoginNeeds2fa(true);
        setLoginError("请输入身份验证器上的 6 位动态验证码");
      } else if (data.error_code === "not_initialized") {
        setAuthInitialized(false);
        setLoginError("系统尚未初始化，请先设置管理员账户");
      } else {
        setLoginError(data.message || "登录失败");
      }
    } catch (err: unknown) {
      console.error("Login error:", err);
      // 网络类失败最常见的成因是后端地址不对，且本地覆盖值优先级高于构建期烘焙值，
      // 故直接把当前实际使用的地址与来源写进提示，避免只看到一句 Failed to fetch。
      const override = localStorage.getItem("DOMAIN_HUB_BACKEND_URL");
      const target = override || backendUrl;
      const errorMessage = err instanceof Error ? err.message : String(err || "网络异常");
      const hint = target
        ? `当前请求地址：${target}${override ? "（来自本机保存的覆盖值，优先级高于部署时写入的默认地址；如该地址已失效，清除本站点数据即可恢复默认）" : "（来自部署时写入的默认地址）"}`
        : "尚未配置后端地址";
      setLoginError(`登录请求失败：${errorMessage}。${hint}`);
    } finally {
      setLoginLoading(false);
    }
  };

  // 提交首次初始化（自行设置管理员用户名与密码）
  const handleSetup = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    setLoginError("");

    if (!setupUsername.trim() || setupUsername.trim().length < 3) {
      setLoginError("用户名至少需要 3 个字符");
      return;
    }
    if (setupPassword.length < 8) {
      setLoginError("密码至少需要 8 个字符");
      return;
    }
    if (setupPassword !== setupPassword2) {
      setLoginError("两次输入的密码不一致");
      return;
    }

    setLoginLoading(true);
    try {
      const data = await setupRequest(apiFetch, {
        username: setupUsername.trim(),
        password: setupPassword,
      });

      if (data.success && data.session_token) {
        persistSession(data.session_token);
        setSetupPassword("");
        setSetupPassword2("");
        setAuthInitialized(true);
        showToast("success", data.message || "🎉 初始化成功");
      } else {
        setLoginError(data.message || "初始化失败");
      }
    } catch (err: unknown) {
      console.error("Setup error:", err);
      const errorMessage = err instanceof Error ? err.message : String(err || "网络异常");
      setLoginError(`初始化请求失败：${errorMessage}`);
    } finally {
      setLoginLoading(false);
    }
  };

  // 退出登录
  const handleLogout = async () => {
    // 先让服务端把当前 Bearer 会话作废（token 落库的是哈希，拿到旧 token 也无法重放）
    try {
      const token = readSessionToken();
      if (token) {
        await logoutRequest(apiFetch);
      }
    } catch (err) {
      // 网络异常不影响本地登出，静默降级为仅清本地凭据
      console.warn("Logout revoke failed:", err);
    }
    sessionStorage.removeItem("DOMAIN_HUB_SESSION");
    localStorage.removeItem("DOMAIN_HUB_SESSION");
    localStorage.removeItem("DOMAIN_HUB_CACHED_ACCOUNTS");
    setSessionToken(null);
    setLoginUsername("");
    setLoginPassword("");
    setLoginTotp("");
    setLoginNeeds2fa(false);
    showToast("info", "已退出登录");
  };

  // 读取账户安全信息（用户名 + 2FA 状态）
  const fetchAccountInfo = async () => {
    try {
      const data = await fetchAccount(apiFetch);
      if (data.success) {
        setAccountInfo({ username: data.username || "", two_fa_enabled: !!data.two_fa_enabled });
      }
    } catch (e) {
      // 静默失败，设置页其余部分仍可用
    }
  };

  return {
    // 鉴权状态（登录页分支 + 动态码输入框显隐）
    authStatusLoaded,
    authInitialized,
    authTwoFaEnabled,
    loginNeeds2fa,
    // 登录表单（受控：setter 供 JSX 使用）
    loginUsername,
    setLoginUsername,
    loginPassword,
    setLoginPassword,
    loginTotp,
    setLoginTotp,
    loginLoading,
    loginError,
    // 首次初始化表单（受控）
    setupUsername,
    setSetupUsername,
    setupPassword,
    setSetupPassword,
    setupPassword2,
    setSetupPassword2,
    // 账户安全信息
    accountInfo,
    // 动作
    handleLogin,
    handleSetup,
    handleLogout,
    fetchAccountInfo,
  };
}

export type UseAuthSessionReturn = ReturnType<typeof useAuthSession>;
