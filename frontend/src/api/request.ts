import type { ApiFetch } from "./client";
import type { JsonApiResponse } from "./types";

export interface ApiErrorPayload {
  success?: boolean;
  message?: string;
  error?: string;
  error_code?: string;
  [key: string]: unknown;
}

/** 统一的 API 请求错误：网络、HTTP、响应解析都经过同一类型出口。 */
export class ApiRequestError extends Error {
  readonly status: number | null;
  readonly payload: unknown;

  constructor(message: string, options: { status?: number | null; payload?: unknown } = {}) {
    super(message);
    this.name = "ApiRequestError";
    this.status = options.status ?? null;
    this.payload = options.payload;
  }
}

export function isApiRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}

/** JSON 请求的统一边界：调用方不再手写 response.json()。 */
export async function apiJson<T extends object = Record<string, unknown>>(
  apiFetch: ApiFetch,
  url: string,
  options?: RequestInit,
): Promise<JsonApiResponse<T>> {
  let response: Response;
  try {
    response = await apiFetch(url, options);
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    throw new ApiRequestError(error instanceof Error ? error.message : "网络请求失败", { status: null });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError(`服务器返回了无效 JSON（HTTP ${response.status}）`, { status: response.status });
  }

  if (!response.ok) {
    const detail = typeof payload === "object" && payload !== null ? payload as ApiErrorPayload : {};
    throw new ApiRequestError(detail.message || detail.error || `请求失败（HTTP ${response.status}）`, {
      status: response.status,
      payload,
    });
  }

  return payload as JsonApiResponse<T>;
}

export const jsonHeaders = { "Content-Type": "application/json" } as const;
