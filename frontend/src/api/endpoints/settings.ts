import type { ApiFetch } from "../client";
import { apiJson, jsonHeaders } from "../request";

export const settingsApi = {
  get(apiFetch: ApiFetch) { return apiJson(apiFetch, "/api/settings"); },
  save(apiFetch: ApiFetch, body: unknown) { return apiJson(apiFetch, "/api/settings", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) }); },
  testTelegram(apiFetch: ApiFetch, body: unknown) { return apiJson(apiFetch, "/api/settings/test-telegram", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) }); },
  testWebhook(apiFetch: ApiFetch, body: unknown) { return apiJson(apiFetch, "/api/settings/test-webhook", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) }); },
};
