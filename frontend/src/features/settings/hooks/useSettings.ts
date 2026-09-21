import { useState } from "react";
import type { ApiFetch } from "../../../api/client";
import { apiJson } from "../../../api/request";

/**
 * useSettings —— 设置页的状态与动作
 *
 * WHY 抽成 hook：
 * 「设置」标签页原先在 App.tsx 里内联了 499 行 JSX，外加散落在 App 顶部与
 * 中段的一整套状态和 10 个处理函数（保存设置 / 测试推送 / 改密码 / 2FA 开关
 * / 后端地址编辑）。它们全部只服务于设置页，却把 App 撑得又长又难扫。
 *
 * 这里把**设置页私有**的状态与处理函数收拢成一个 hook，App 只消费一个扁平
 * 对象；SettingsPage 组件再把这个对象摊平成 props。跨页共享的 `accountInfo`
 * / `fetchAccountInfo` / `actionLoading` / `apiFetch` 等仍由 App 注入。
 *
 * 注意 `fetchSettings` 需要被 App 的「切页按需拉取」effect 调用，故必须从
 * 本 hook 的返回值暴露出去。
 */
export interface AppSettings {
  webhook_url: string;
  webhook_type: string;
  tg_token: string;
  tg_chat_id: string;
  renew_threshold_days: string;
  auto_renew: string;
  /** 定时任务的解析记录缓存策略：scheduled=只读缓存 / always=每次全额回源 */
  dns_records_cache_mode: string;
}

export interface UseSettingsOptions {
  /** 带鉴权的 fetch 封装（来自 AppDataProvider） */
  apiFetch: ApiFetch;
  /** 全局 Toast */
  showToast: (type: "success" | "error" | "info" | "warning", msg: string) => void;
  /** 全局动作 loading 指示（与其它页面共用） */
  actionLoading: string | null;
  setActionLoading: (v: string | null) => void;
  /** 当前管理员信息（跨页共享，设置页只读消费） */
  accountInfo: { username: string; two_fa_enabled: boolean };
  /** 重新拉取管理员信息（2FA 开关成功后刷新） */
  fetchAccountInfo: () => void | Promise<void>;
  /** 退出登录（改密码成功后当前会话作废，强制重登） */
  handleLogout: () => void | Promise<void>;
}

export function useSettings(opts: UseSettingsOptions) {
  const {
    apiFetch,
    showToast,
    actionLoading,
    setActionLoading,
    accountInfo,
    fetchAccountInfo,
    handleLogout,
  } = opts;

  // 应用设置状态
  type SettingsApiResponse = {
    success?: boolean;
    message?: string;
    settings?: Partial<AppSettings>;
    configured?: { tg_token: boolean; webhook_url: boolean };
    secret: string;
    otpauth_uri: string;
  };
  const [settings, setSettings] = useState<AppSettings>({
    webhook_url: "",
    webhook_type: "custom",
    tg_token: "",
    tg_chat_id: "",
    renew_threshold_days: "90",
    auto_renew: "1",
    dns_records_cache_mode: "scheduled",
  });
  const [settingsConfigured, setSettingsConfigured] = useState<{ tg_token: boolean; webhook_url: boolean }>({ tg_token: false, webhook_url: false });
  const [loadingSettings, setLoadingSettings] = useState(false);
  // 设置页本地后端地址输入
  const [backendUrlInput, setBackendUrlInput] = useState(
    () => localStorage.getItem("DOMAIN_HUB_BACKEND_URL") || ""
  );
  // 后端地址是否处于编辑状态（保存后收起，不常驻显示在输入框）
  const [backendUrlEditing, setBackendUrlEditing] = useState(false);

  // 修改密码表单
  const [pwOld, setPwOld] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwNew2, setPwNew2] = useState("");
  const [pwNewUsername, setPwNewUsername] = useState("");
  // 2FA 流程
  const [twoFaSetup, setTwoFaSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [twoFaEnableToken, setTwoFaEnableToken] = useState("");
  const [twoFaDisableToken, setTwoFaDisableToken] = useState("");

  const fetchSettings = async () => {
    setLoadingSettings(true);
    try {
      const data = await apiJson<SettingsApiResponse>(apiFetch, "/api/settings");
      if (data.success && data.settings) {
        setSettings((prev) => ({ ...prev, ...data.settings }));
        if (data.configured) setSettingsConfigured(data.configured);
      }
    } catch (e) {
      showToast("error", "获取设置失败");
    } finally {
      setLoadingSettings(false);
    }
  };

  // 保存应用设置
  const handleSaveSettings = async () => {
    setActionLoading("save-settings");
    try {
      // 敏感字段：若仍是打码占位（已配置且用户未改动），则不提交，避免覆盖
      const payload: Record<string, string> = {
        webhook_type: settings.webhook_type,
        tg_chat_id: settings.tg_chat_id,
        renew_threshold_days: settings.renew_threshold_days,
        auto_renew: settings.auto_renew,
        dns_records_cache_mode: settings.dns_records_cache_mode,
      };
      if (settings.tg_token && !settings.tg_token.startsWith("****")) payload.tg_token = settings.tg_token;
      if (settings.webhook_url && !settings.webhook_url.startsWith("****")) payload.webhook_url = settings.webhook_url;

      const data = await apiJson<SettingsApiResponse>(apiFetch, "/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (data.success) {
        showToast("success", "✅ 设置已保存");
        fetchSettings();
      } else {
        showToast("error", data.message || "保存设置失败");
      }
    } catch (e) {
      showToast("error", "保存设置网络请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 测试 Telegram 推送
  const handleTestTelegram = async () => {
    setActionLoading("test-tg");
    try {
      const payload: Record<string, string> = { tg_chat_id: settings.tg_chat_id };
      if (settings.tg_token && !settings.tg_token.startsWith("****")) payload.tg_token = settings.tg_token;
      const data = await apiJson<SettingsApiResponse>(apiFetch, "/api/settings/test-telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (data.success) {
        showToast("success", data.message || "测试消息已发送");
      } else {
        showToast("error", data.message || "测试推送失败");
      }
    } catch (e) {
      showToast("error", "测试推送网络请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 测试 Webhook 推送
  const handleTestWebhook = async () => {
    setActionLoading("test-webhook");
    try {
      const payload: Record<string, string> = { webhook_type: settings.webhook_type };
      // 打码值（已配置但未改动）不回传，让后端用库里的原值
      if (settings.webhook_url && !settings.webhook_url.startsWith("****")) {
        payload.webhook_url = settings.webhook_url;
      }
      const data = await apiJson<SettingsApiResponse>(apiFetch, "/api/settings/test-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (data.success) {
        showToast("success", data.message || "测试消息已发送");
      } else {
        showToast("error", data.message || "测试推送失败");
      }
    } catch (e) {
      showToast("error", "测试推送网络请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 保存本地后端地址
  const handleSaveBackendUrl = () => {
    const v = backendUrlInput.trim().replace(/\/$/, "");
    if (v) {
      localStorage.setItem("DOMAIN_HUB_BACKEND_URL", v);
      showToast("success", "后端地址已保存，即将刷新页面生效");
    } else {
      localStorage.removeItem("DOMAIN_HUB_BACKEND_URL");
      showToast("info", "已清除自定义后端地址");
    }
    setBackendUrlEditing(false);
    setTimeout(() => window.location.reload(), 1200);
  };

  // 取消编辑，恢复已保存的值并收起输入框
  const handleCancelBackendUrl = () => {
    setBackendUrlInput(localStorage.getItem("DOMAIN_HUB_BACKEND_URL") || "");
    setBackendUrlEditing(false);
  };

  // 修改密码（可选同时改用户名）
  const handleChangePassword = async () => {
    if (!pwOld) {
      showToast("error", "请输入原密码");
      return;
    }
    if (pwNew.length < 8) {
      showToast("error", "新密码至少需要 8 个字符");
      return;
    }
    if (pwNew !== pwNew2) {
      showToast("error", "两次输入的新密码不一致");
      return;
    }
    setActionLoading("change-pw");
    try {
      const payload: Record<string, string> = { old_password: pwOld, new_password: pwNew };
      // 与当前用户名相同时不下发 username：避免浏览器把当前用户名预填进「同时修改用户名」
      // 之后，提交时产生一次毫无意义的改名写入与日志。
      const wantUsername = pwNewUsername.trim();
      if (wantUsername && wantUsername !== (accountInfo.username || "")) {
        payload.username = wantUsername;
      }
      const data = await apiJson<SettingsApiResponse>(apiFetch, "/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (data.success) {
        showToast("success", data.message || "密码修改成功，请重新登录");
        setPwOld(""); setPwNew(""); setPwNew2(""); setPwNewUsername("");
        // 密码已变更，当前会话作废，强制重新登录
        setTimeout(() => handleLogout(), 1500);
      } else {
        showToast("error", data.message || "修改密码失败");
      }
    } catch (e) {
      showToast("error", "修改密码请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 第一步：生成 2FA 密钥与二维码
  const handleStart2faSetup = async () => {
    setActionLoading("2fa-setup");
    try {
      const data = await apiJson<SettingsApiResponse>(apiFetch, "/api/auth/2fa/setup", { method: "POST" });
      if (data.success) {
        setTwoFaSetup({ secret: data.secret, otpauth_uri: data.otpauth_uri });
        setTwoFaEnableToken("");
      } else {
        showToast("error", data.message || "生成 2FA 密钥失败");
      }
    } catch (e) {
      showToast("error", "生成 2FA 密钥请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 第二步：输入动态码正式开启 2FA
  const handleEnable2fa = async () => {
    if (!twoFaEnableToken.trim()) {
      showToast("error", "请输入身份验证器上的 6 位动态码");
      return;
    }
    setActionLoading("2fa-enable");
    try {
      const data = await apiJson<SettingsApiResponse>(apiFetch, "/api/auth/2fa/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: twoFaEnableToken.trim() }),
      });
      if (data.success) {
        showToast("success", data.message || "两步验证已开启");
        setTwoFaSetup(null);
        setTwoFaEnableToken("");
        fetchAccountInfo();
      } else {
        showToast("error", data.message || "开启 2FA 失败");
      }
    } catch (e) {
      showToast("error", "开启 2FA 请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  // 关闭 2FA（需输入当前动态码确认）
  const handleDisable2fa = async () => {
    if (!twoFaDisableToken) {
      showToast("error", "请输入身份验证器上的 6 位动态码以确认关闭 2FA");
      return;
    }
    setActionLoading("2fa-disable");
    try {
      const data = await apiJson<SettingsApiResponse>(apiFetch, "/api/auth/2fa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: twoFaDisableToken }),
      });
      if (data.success) {
        showToast("success", data.message || "两步验证已关闭");
        setTwoFaDisableToken("");
        fetchAccountInfo();
      } else {
        showToast("error", data.message || "关闭 2FA 失败");
      }
    } catch (e) {
      showToast("error", "关闭 2FA 请求失败");
    } finally {
      setActionLoading(null);
    }
  };

  return {
    // state
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
    // actions
    fetchSettings,
    handleSaveSettings,
    handleTestTelegram,
    handleTestWebhook,
    handleSaveBackendUrl,
    handleCancelBackendUrl,
    handleChangePassword,
    handleStart2faSetup,
    handleEnable2fa,
    handleDisable2fa,
    // 注入的只读值（便于 SettingsPage 直接消费）
    accountInfo,
    actionLoading,
  };
}

export type UseSettingsReturn = ReturnType<typeof useSettings>;
