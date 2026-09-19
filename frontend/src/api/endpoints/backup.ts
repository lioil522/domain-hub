import type { ApiFetch } from "../client";
import { apiJson, jsonHeaders } from "../request";

export const backupApi = {
  export(apiFetch: ApiFetch, body: unknown) { return apiJson(apiFetch, "/api/data/export", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) }); },
  import(apiFetch: ApiFetch, body: unknown) { return apiJson(apiFetch, "/api/data/import", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) }); },
  preview(apiFetch: ApiFetch, body: unknown) { return apiJson(apiFetch, "/api/data/preview", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) }); },
};
