/**
 * 全局数据与横切能力上下文（Phase 2.5）
 *
 * WHY 需要它：
 *   项目已抽出的组件（如 AccountsPage）靠 props 接收数据与回调，当前已需 13 个 props；
 *   若继续按「把 App 状态搬进子组件」的方式拆，props 面会迅速膨胀到 25+（God Prop Driller）。
 *   把「被多页共用、且不随页面切换变化」的数据与动作收敛到一个 Context 后：
 *     - 子组件用 useAppData() 直接取，不再逐层透传；
 *     - App 自身也消费该 Context，因此 App 内部对这些量的引用无需改动。
 *
 * 本阶段（Phase 2.5）只收编「账号域 + 横切基础设施」这一最小切片：
 *   sessionToken / backendUrl / apiFetch / accounts / loadingAccounts / fetchAccounts / toast。
 * 其余域（domains / cfZones / dpDomains / multiProviderData / quotas / logs / settings）
 * 在各自的 Phase 里按同样方式逐步并入，避免一次性大改。
 *
 * 分层：state → (api, hooks, types)，不反向依赖 features/components，杜绝循环依赖。
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Account } from "../types/account";
import { createApiFetch, readSessionToken, type ApiFetch } from "../api/client";
import { accountsApi } from "../api/endpoints/accounts";
import { useToast, type ToastState, type ToastType } from "../hooks/useToast";

/** 账号列表在 localStorage 中的缓存键（用于冷启动先渲染） */
const CACHED_ACCOUNTS_KEY = "DOMAIN_HUB_CACHED_ACCOUNTS";

export interface AppDataContextValue {
  // ===== 会话与后端地址 =====
  /** 当前会话 Token（登录成功后签发；存在即视为已登录） */
  sessionToken: string | null;
  setSessionToken: React.Dispatch<React.SetStateAction<string | null>>;
  /** 后端 Worker 基准地址（设置页覆盖值优先，其次构建期烘焙值） */
  backendUrl: string;
  /** 统一 API 请求封装（自动注入 Authorization 与 baseURL，401/403 清会话） */
  apiFetch: ApiFetch;

  // ===== 账号数据 =====
  accounts: Account[];
  setAccounts: React.Dispatch<React.SetStateAction<Account[]>>;
  loadingAccounts: boolean;
  /** 拉取账号列表（成功后写入 localStorage 缓存） */
  fetchAccounts: () => Promise<void>;

  // ===== Toast =====
  toast: ToastState | null;
  showToast: (type: ToastType, message: string) => void;
}

const AppDataContext = createContext<AppDataContextValue | null>(null);

export const AppDataProvider = ({ children }: { children: ReactNode }) => {
  // 后端 Worker 地址：用户覆盖值优先于构建期烘焙值
  const backendUrl =
    localStorage.getItem("DOMAIN_HUB_BACKEND_URL") || import.meta.env?.VITE_API_BASE_URL || "";

  // 当前会话 Token（登录成功后签发；存在即视为已登录）
  const [sessionToken, setSessionToken] = useState<string | null>(() => readSessionToken());

  // Toast（横切能力，Provider 级挂载，生命周期覆盖整个应用）
  const { toast, showToast } = useToast();

  // 统一 API 请求封装；会话失效时清空登录态
  const apiFetch = useMemo(
    () => createApiFetch({ backendUrl, onSessionExpired: () => setSessionToken(null) }),
    [backendUrl]
  );

  // 账号列表：冷启动先用 localStorage 缓存渲染，登录后再以服务端结果覆盖
  const [accounts, setAccounts] = useState<Account[]>(() => {
    try {
      const cached = localStorage.getItem(CACHED_ACCOUNTS_KEY);
      return cached ? JSON.parse(cached) : [];
    } catch {
      return [];
    }
  });
  const [loadingAccounts, setLoadingAccounts] = useState(false);

  // 2. 获取账号列表
  const fetchAccounts = async () => {
    setLoadingAccounts(true);
    try {
      const data = await accountsApi.list(apiFetch);
      if (data.success) {
        const nextAccounts = data.accounts || [];
        setAccounts(nextAccounts);
        try {
          localStorage.setItem(CACHED_ACCOUNTS_KEY, JSON.stringify(nextAccounts));
        } catch {}
      }
    } catch (e) {
      showToast("error", "获取账号列表失败");
    } finally {
      setLoadingAccounts(false);
    }
  };

  const value: AppDataContextValue = {
    sessionToken,
    setSessionToken,
    backendUrl,
    apiFetch,
    accounts,
    setAccounts,
    loadingAccounts,
    fetchAccounts,
    toast,
    showToast,
  };

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
};

/** 读取全局数据上下文；必须在 AppDataProvider 内使用 */
export const useAppData = (): AppDataContextValue => {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error("useAppData 必须在 <AppDataProvider> 内使用");
  return ctx;
};
