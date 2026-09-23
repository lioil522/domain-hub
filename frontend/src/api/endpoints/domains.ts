import type { ApiFetch } from "../client";
import { apiJson, jsonHeaders } from "../request";
import type { Domain } from "../../types/domain";

export interface DomainsResponse { domains: Domain[]; }

export interface SubdomainVerifyInfo {
  host: string;
  type: string;
  parent_domain: string;
  value?: string;
}

export interface CreateDomainResponse {
  domain?: Domain;
  nameservers?: string[];
  message?: string;
  need_txt_verify?: boolean;
  verify_info?: SubdomainVerifyInfo;
}

export const domainsApi = {
  list(apiFetch: ApiFetch, params: { provider?: string; accountId?: number | string } = {}) {
    const query = new URLSearchParams();
    if (params.provider) query.set("provider", params.provider);
    if (params.accountId !== undefined && params.accountId !== "all") query.set("account_id", String(params.accountId));
    const suffix = query.toString() ? `?${query}` : "";
    return apiJson<DomainsResponse>(apiFetch, `/api/domains${suffix}`);
  },
  syncAll(apiFetch: ApiFetch) {
    return apiJson(apiFetch, "/api/domains/sync", { method: "POST" });
  },
  syncProvider(apiFetch: ApiFetch, provider: string) {
    return apiJson(apiFetch, `/api/providers/${encodeURIComponent(provider)}/sync`, { method: "POST" });
  },
  renew(apiFetch: ApiFetch, id: number) {
    return apiJson(apiFetch, `/api/domains/${id}/renew`, { method: "POST" });
  },
  remove(apiFetch: ApiFetch, id: number, body?: Record<string, unknown>) {
    return apiJson(apiFetch, `/api/domains/${id}/delete`, { method: "POST", headers: jsonHeaders, body: body ? JSON.stringify(body) : undefined });
  },
  nameservers(apiFetch: ApiFetch, id: number, refresh = false) {
    return apiJson(apiFetch, `/api/domains/${id}/nameservers${refresh ? "?refresh=1" : ""}`);
  },
  updateNameservers(apiFetch: ApiFetch, id: number, body: Record<string, unknown>) {
    return apiJson(apiFetch, `/api/domains/${id}/nameservers`, { method: "PUT", headers: jsonHeaders, body: JSON.stringify(body) });
  },
  create(apiFetch: ApiFetch, body: { account_id: number; domain: string }) {
    return apiJson<CreateDomainResponse>(apiFetch, "/api/domains", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
  },
};
