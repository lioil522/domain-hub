import type { ApiFetch } from "../client";
import { apiJson } from "../request";
import type { AppLog } from "../../types/log";

export interface LogsResponse { logs: AppLog[]; }
export const logsApi = {
  list(apiFetch: ApiFetch) { return apiJson<LogsResponse>(apiFetch, "/api/logs"); },
  clear(apiFetch: ApiFetch) { return apiJson(apiFetch, "/api/logs/clear", { method: "POST" }); },
};
