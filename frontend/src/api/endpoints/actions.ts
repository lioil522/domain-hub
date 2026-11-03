import type { ApiFetch } from "../client";
import { apiJson, jsonHeaders } from "../request";

export const actionsApi = {
  list(apiFetch: ApiFetch, limit = 50) {
    return apiJson(apiFetch, `/api/actions?limit=${encodeURIComponent(String(limit))}`);
  },
  get(apiFetch: ApiFetch, id: string) {
    return apiJson(apiFetch, `/api/actions/${encodeURIComponent(id)}`);
  },
  start(apiFetch: ApiFetch, body: unknown) {
    return apiJson(apiFetch, "/api/actions", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
  },
  update(apiFetch: ApiFetch, id: string, body: unknown) {
    return apiJson(apiFetch, `/api/actions/${encodeURIComponent(id)}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(body) });
  },
  complete(apiFetch: ApiFetch, id: string) {
    return apiJson(apiFetch, `/api/actions/${encodeURIComponent(id)}/complete`, { method: "POST", headers: jsonHeaders });
  },
  fail(apiFetch: ApiFetch, id: string, error: string) {
    return apiJson(apiFetch, `/api/actions/${encodeURIComponent(id)}/fail`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ error }) });
  },
  cancel(apiFetch: ApiFetch, id: string) {
    return apiJson(apiFetch, `/api/actions/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: jsonHeaders });
  },
};
