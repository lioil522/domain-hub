/** 后端 API 响应的基本信封形状 */
export interface ApiResponse {
  success: boolean;
  message?: string;
  error_code?: string;
}
