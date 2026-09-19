import type { ApiFetch } from "../client";
import { apiJson, jsonHeaders } from "../request";

export const scannerApi = {
  whois(apiFetch: ApiFetch, domain: string, accountId?: number | string, batch = false) {
    const q = new URLSearchParams({ domain });
    if (accountId !== undefined) q.set("account_id", String(accountId));
    if (batch) q.set("batch", "1");
    return apiJson(apiFetch, `/api/whois?${q}`);
  },
  register(apiFetch: ApiFetch, body: unknown) { return apiJson(apiFetch, "/api/domains/register", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) }); },
  whoisPool(apiFetch: ApiFetch, body: unknown) { return apiJson(apiFetch, "/api/whois/pool", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) }); },
  getWhoisPool(apiFetch: ApiFetch) { return apiJson(apiFetch, "/api/whois/pool"); },
  listJobs(apiFetch: ApiFetch, limit = 50) { return apiJson(apiFetch, `/api/scanner/jobs?limit=${encodeURIComponent(String(limit))}`); },
  getJob(apiFetch: ApiFetch, id: string) { return apiJson(apiFetch, `/api/scanner/jobs/${encodeURIComponent(id)}`); },
  createJob(apiFetch: ApiFetch, body: unknown) { return apiJson(apiFetch, "/api/scanner/jobs", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) }); },
  updateJob(apiFetch: ApiFetch, id: string, body: unknown) { return apiJson(apiFetch, `/api/scanner/jobs/${encodeURIComponent(id)}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(body) }); },
  pauseJob(apiFetch: ApiFetch, id: string) { return apiJson(apiFetch, `/api/scanner/jobs/${encodeURIComponent(id)}/pause`, { method: "POST", headers: jsonHeaders }); },
  resumeJob(apiFetch: ApiFetch, id: string) { return apiJson(apiFetch, `/api/scanner/jobs/${encodeURIComponent(id)}/resume`, { method: "POST", headers: jsonHeaders }); },
};
