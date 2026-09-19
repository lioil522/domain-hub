import { ApiError } from "./errors";
import type { ApiFetch } from "./client";
import type { JsonApiResponse } from "./types";

export async function apiJson<T extends object = Record<string, unknown>>(
  apiFetch: ApiFetch,
  url: string,
  options?: RequestInit,
): Promise<JsonApiResponse<T>> {
  const response = await apiFetch(url, options);
  let payload: JsonApiResponse<T>;
  try {
    payload = (await response.json()) as JsonApiResponse<T>;
  } catch {
    throw new ApiError("服务器返回了无效的 JSON 响应", response.status);
  }
  if (!response.ok) {
    throw new ApiError(
      typeof payload.message === "string" ? payload.message : `请求失败 (${response.status})`,
      response.status,
      payload.error_code,
      payload,
    );
  }
  return payload;
}

export const jsonHeaders = { "Content-Type": "application/json" } as const;
