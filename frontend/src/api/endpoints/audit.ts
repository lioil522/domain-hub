import type { ApiFetch } from "../client";
import { apiJson } from "../request";

export const auditApi = {
  list(apiFetch: ApiFetch, limit = 100) {
    return apiJson(apiFetch, `/api/audit?limit=${encodeURIComponent(String(limit))}`);
  },
};
