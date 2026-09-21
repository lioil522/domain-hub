import type { ApiFetch } from "../../../api/client";
import { apiJson } from "../../../api/request";
import type {
  AccountResponse,
  AuthStatusResponse,
  LoginResponse,
  SetupResponse,
} from "../types";

/**
 * auth 域的 HTTP 边界
 *
 * WHY 抽出来：
 *   原先 `useAuthSession` 里每个动作都手写 `apiFetch(...)` + `await res.json()`，
 *   并用 `const data = await res.json()` 落到隐式 `any` —— 后端字段拼错
 *   （如 `session_token` 写成 `sessionToken`）编译期毫无反馈，只能在运行时表现为
 *   「登录成功但没进系统」。收敛到本文件后：
 *     - 端点路径只出现一次，不再散落在 hook 各分支；
 *     - 响应形状由 types.ts 约束，字段名拼错即编译失败。
 *
 * 刻意**不**在这里做错误分支判断（need_2fa / not_initialized / 网络异常提示文案）：
 * 那些属于交互决策，留在 hook 里；本层只负责「发请求 + 解析 JSON」这一件事。
 * 因此这些函数不吞异常 —— 网络失败继续向上抛，由 hook 的 try/catch 生成用户可读提示。
 */

/** 查询鉴权状态（是否已初始化 / 是否已开启 2FA） */
export async function fetchAuthStatus(apiFetch: ApiFetch): Promise<AuthStatusResponse> {
  return apiJson<AuthStatusResponse>(apiFetch, "/api/auth/status");
}

/** 提交登录（用户名 + 密码，若后端要求则附带 2FA 动态码） */
export async function login(
  apiFetch: ApiFetch,
  payload: { username: string; password: string; token?: string }
): Promise<LoginResponse> {
  return apiJson<LoginResponse>(apiFetch, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** 首次初始化（自行设置管理员用户名与密码） */
export async function setup(
  apiFetch: ApiFetch,
  payload: { username: string; password: string }
): Promise<SetupResponse> {
  return apiJson<SetupResponse>(apiFetch, "/api/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * 让服务端作废当前 Bearer 会话
 *
 * NOTE: 调用方需自行确保本地确实存在 token 才调用本函数 —— 无 token 时请求没有意义
 * （后端拿不到凭据），原实现即在 `readSessionToken()` 为空时跳过这一步。
 */
export async function logout(apiFetch: ApiFetch): Promise<void> {
  await apiJson(apiFetch, "/api/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

/** 读取账户安全信息（用户名 + 2FA 状态） */
export async function fetchAccount(apiFetch: ApiFetch): Promise<AccountResponse> {
  return apiJson<AccountResponse>(apiFetch, "/api/auth/account");
}
