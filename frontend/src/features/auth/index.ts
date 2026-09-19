/**
 * auth 域的对外出口（barrel）
 *
 * WHY：
 *   外部只应依赖这一个入口，而不是深入 `hooks/useAuthSession` / `components/LoginPage`
 *   这类内部路径。这样 auth 域内部再怎么重排文件（如后续把表单状态拆成
 *   useLoginForm / useSetupForm），域外的 import 都不用跟着改。
 *
 * NOTE: 刻意**不**从本文件导出 `api/auth-api` —— 它是 auth 域的内部实现细节
 *       （HTTP 边界），域外不该绕过 hook 直接发鉴权请求。
 *
 * NOTE: 只需要 `AccountInfo` 这个类型的模块（features/data）应直接 import
 *       `../../auth/types`，而不是走本 barrel —— 后者会把 LoginPage 组件
 *       一并拖进依赖图，纯类型消费不该付这个代价。
 */
export { useAuthSession } from "./hooks/useAuthSession";
export type { UseAuthSessionDeps, UseAuthSessionReturn } from "./hooks/useAuthSession";

export { LoginPage } from "./components/LoginPage";
export type { LoginPageProps } from "./components/LoginPage";

export type {
  AccountInfo,
  AccountResponse,
  AuthStatusResponse,
  LoginResponse,
  SetupResponse,
} from "./types";
