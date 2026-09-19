import type { ApiFetch } from "./client";
import type { ApiResponse } from "../types/api";

export interface ApiContext {
  apiFetch: ApiFetch;
}

export type JsonApiResponse<T extends object = Record<string, unknown>> = ApiResponse & T;
