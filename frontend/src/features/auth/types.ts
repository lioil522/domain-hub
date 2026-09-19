/**
 * auth 域的类型契约
 *
 * WHY 单独成文件：
 *   `AccountInfo` 原先声明在 `hooks/useAuthSession.ts` 里，导致只需要这个**类型**的
 *   模块（features/data/hooks/useDataTransfer）必须 import 那个含 state/effect 的
 *   hook 文件。类型下沉到本文件后，纯类型消费方不再被动依赖运行时代码。
 *
 * 后端响应形状与 server/routes/auth.ts 一一对应；字段可选性刻意保留 ——
 * 这些值来自网络，不能假定一定存在（原实现用 `any` 接住，等于放弃校验）。
 */

/** 当前账户信息（用户名 + 2FA 是否开启）—— 设置页只读消费，数据导入/导出弹窗也需要 */
export interface AccountInfo {
  username: string;
  two_fa_enabled: boolean;
}

/** 后端统一响应信封的公共字段 */
interface AuthResponseBase {
  success?: boolean;
  message?: string;
  /** 业务错误码（need_2fa / not_initialized 等），成功时不下发 */
  error_code?: string;
}

/** GET /api/auth/status —— 未登录时决定登录页展示「登录」还是「首次设置」 */
export interface AuthStatusResponse extends AuthResponseBase {
  initialized?: boolean;
  two_fa_enabled?: boolean;
}

/** POST /api/auth/login */
export interface LoginResponse extends AuthResponseBase {
  session_token?: string;
}

/** POST /api/auth/setup —— 首次初始化，成功后同样直接下发会话 */
export interface SetupResponse extends AuthResponseBase {
  session_token?: string;
}

/** GET /api/auth/account —— 账户安全信息 */
export interface AccountResponse extends AuthResponseBase {
  username?: string;
  two_fa_enabled?: boolean;
}
