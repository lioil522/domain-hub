import type { ApiFetch } from "../client";
import { apiJson, jsonHeaders } from "../request";

const bodyOptions = (method: string, body: unknown): RequestInit => ({
  method,
  headers: jsonHeaders,
  body: JSON.stringify(body),
});

export const dnsApi = {
  list(apiFetch: ApiFetch, domainId: number, refresh = false) {
    return apiJson(apiFetch, `/api/domains/${domainId}/dns${refresh ? "?refresh=1" : ""}`);
  },
  create(apiFetch: ApiFetch, domainId: number, body: unknown) {
    return apiJson(apiFetch, `/api/domains/${domainId}/dns`, bodyOptions("POST", body));
  },
  update(apiFetch: ApiFetch, domainId: number, recordId: string | number, body: unknown) {
    return apiJson(apiFetch, `/api/domains/${domainId}/dns/${encodeURIComponent(String(recordId))}`, bodyOptions("PUT", body));
  },
  remove(apiFetch: ApiFetch, domainId: number, recordId: string | number) {
    return apiJson(apiFetch, `/api/domains/${domainId}/dns/${encodeURIComponent(String(recordId))}`, { method: "DELETE" });
  },
  batchCreate(apiFetch: ApiFetch, domainId: number, body: unknown) {
    return apiJson(apiFetch, `/api/domains/${domainId}/dns/batch`, bodyOptions("POST", body));
  },
  batchUpdate(apiFetch: ApiFetch, domainId: number, body: unknown) {
    return apiJson(apiFetch, `/api/domains/${domainId}/dns/batch-update`, bodyOptions("POST", body));
  },
  batchDelete(apiFetch: ApiFetch, domainId: number, body: unknown) {
    return apiJson(apiFetch, `/api/domains/${domainId}/dns/batch-delete`, bodyOptions("POST", body));
  },
};
