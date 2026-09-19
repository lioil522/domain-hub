import type { ApiFetch } from "../client";
import { apiJson } from "../request";

export const providersApi = {
  domains(apiFetch: ApiFetch, provider: string, accountId?: number | string) {
    const q = new URLSearchParams({ provider });
    if (accountId !== undefined && accountId !== "all") q.set("account_id", String(accountId));
    return apiJson(apiFetch, `/api/domains?${q}`);
  },
  sync(apiFetch: ApiFetch, provider: string) {
    return apiJson(apiFetch, `/api/providers/${encodeURIComponent(provider)}/sync`, { method: "POST" });
  },
};
