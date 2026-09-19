/** 日志接口 */
export interface AppLog {
  id: number;
  type: "info" | "success" | "warning" | "error";
  category: "sync" | "renew" | "system";
  message: string;
  details: string | null;
  created_at: string;
}
