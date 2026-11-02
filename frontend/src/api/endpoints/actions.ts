import type { ApiFetch } from "../client";
import { apiJson, jsonHeaders } from "../request";
import type { SyncAction } from "../../lib/sync-action";
import type { ActionItem } from "../../lib/action-center-state";

export const actionsApi = {
  list(apiFetch: ApiFetch, limit = 50, options?: RequestInit) {
    return apiJson<{ actions: ActionItem[] }>(apiFetch, `/api/actions?limit=${encodeURIComponent(String(limit))}`, options);
  },
  get(apiFetch: ApiFetch, id: string, options?: RequestInit) {
    return apiJson<{ action: SyncAction }>(apiFetch, `/api/actions/${encodeURIComponent(id)}`, options);
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
