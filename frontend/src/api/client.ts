/**
 * 统一 API 请求封装（Phase 2-A，从 App.tsx 抽出）
 *
 * 原实现是 App 组件体内的一个闭包，隐式依赖两个外部量：
 *   - backendUrl          用户在设置页保存的后端 Worker 地址（或构建期烘焙的 VITE_API_BASE_URL）
 *   - setSessionToken     会话失效（401/403）时把前端登录态清空
 * 这里改为显式注入依赖的工厂函数，行为与原来逐行一致（含全部注释）。
 */

/** 用户手动配置的后端地址在 localStorage 中的键 */
export const BACKEND_URL_KEY = "DOMAIN_HUB_BACKEND_URL";
/** 登录会话 Token 在 session/localStorage 中的键 */
export const SESSION_KEY = "DOMAIN_HUB_SESSION";

/** 读取当前会话 Token（sessionStorage 优先，其次 localStorage） */
export const readSessionToken = (): string | null =>
  sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);

export interface ApiFetchDeps {
  /** 组件内已解析好的后端基准地址（含设置页覆盖值与构建期烘焙值） */
  backendUrl: string;
  /** 会话失效（401/403 且非鉴权接口自身）时回调，用于清空前端登录态 */
  onSessionExpired: () => void;
}

export type ApiFetch = (url: string, options?: RequestInit) => Promise<Response>;

/**
 * 构造 apiFetch 实例。每次渲染重新构造，与原闭包行为一致。
 */
export const createApiFetch = ({ backendUrl, onSessionExpired }: ApiFetchDeps): ApiFetch => {
  return async (url: string, options: RequestInit = {}): Promise<Response> => {
    // 从会话存储获取登录后签发的 Session Token
    const token = readSessionToken();
    const storedBackend = backendUrl || localStorage.getItem(BACKEND_URL_KEY) || import.meta.env?.VITE_API_BASE_URL;

    // 如果传入相对路径以 /api 开头，智能补全后端基准域名
    //
    // NOTE: 此处不再按当前域名猜测后端地址（原先会拼出 https://api-dnshe.<主域名>）。
    //       那个约定并不成立：Worker 未绑同名自定义域名时该主机根本不解析，
    //       请求只会以一句 Failed to fetch 结束，反而掩盖了「后端地址未配置」这个真实原因。
    //       地址来源现在只有两个：用户在设置页保存的覆盖值，以及构建期烘焙的 VITE_API_BASE_URL。
    let finalUrl = url;
    if (url.startsWith("/api")) {
      if (storedBackend) {
        finalUrl = `${storedBackend.replace(/\/$/, "")}${url}`;
      } else {
        const host = window.location.hostname;
        const isLocalDev = host === "localhost" || host === "127.0.0.1";
        if (!isLocalDev) {
          // 线上两者皆空：走相对路径只会打到 Pages 自身、被 SPA 兜底返回 HTML，
          // 报错会变成 JSON 解析失败。这里直接给出真实原因。
          throw new Error("未配置后端地址（部署时未能推导出 Worker 地址），请在设置页手动填写后端 Worker 地址");
        }
        // 本地开发走 Vite 代理的相对路径
        finalUrl = url;
      }
    }

    const headers = new Headers(options.headers || {});
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    try {
      const res = await fetch(finalUrl, { ...options, headers });
      if (res.status === 401 || res.status === 403) {
        // 会话失效：清理凭据并回到登录页（登录/初始化/状态接口自身除外，避免误清）
        const isAuthEndpoint = url.startsWith("/api/auth/login") || url.startsWith("/api/auth/setup") || url.startsWith("/api/auth/status");
        if (!isAuthEndpoint) {
          sessionStorage.removeItem(SESSION_KEY);
          localStorage.removeItem(SESSION_KEY);
          onSessionExpired();
        }
      }
      return res;
    } catch (err) {
      // 遇网络连接异常自动提示配置后端服务
      console.error("API Fetch Error:", err);
      throw err;
    }
  };
};
