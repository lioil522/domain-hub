import type { ApiFetch } from "../client";
import { apiJson, jsonHeaders } from "../request";
import type { Account } from "../../types/account";

export interface AccountsResponse { accounts: Account[]; }

export const accountsApi = {
  list(apiFetch: ApiFetch) {
    return apiJson<AccountsResponse>(apiFetch, "/api/accounts");
  },
  create(apiFetch: ApiFetch, body: Record<string, unknown>) {
    return apiJson(apiFetch, "/api/accounts", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
  },
  batchCreate(apiFetch: ApiFetch, body: Record<string, unknown>) {
    return apiJson(apiFetch, "/api/accounts/batch", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
  },
  update(apiFetch: ApiFetch, id: number, body: Record<string, unknown>) {
    return apiJson(apiFetch, `/api/accounts/${id}`, { method: "PUT", headers: jsonHeaders, body: JSON.stringify(body) });
  },
  remove(apiFetch: ApiFetch, id: number) {
    return apiJson(apiFetch, `/api/accounts/${id}`, { method: "DELETE" });
  },
  sync(apiFetch: ApiFetch, id: number) {
    return apiJson(apiFetch, `/api/accounts/${id}/sync`, { method: "POST" });
  },
};
