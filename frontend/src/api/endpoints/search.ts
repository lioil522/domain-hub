import type { ApiFetch } from "../client";
import { apiJson } from "../request";

export const searchApi = {
  query(apiFetch: ApiFetch, query: string, limit = 20) {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return apiJson(apiFetch, `/api/search?${params}`);
  },
};
