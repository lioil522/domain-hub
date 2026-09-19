/** Shared HTTP response envelope helpers. */
export function successRes<T extends object = Record<string, unknown>>(payload: T = {} as T) {
  return { success: true, ...payload };
}

export function errorRes(message: string, errorCode?: string, details?: unknown) {
  const res: Record<string, unknown> = { success: false, message };
  if (errorCode) res.error_code = errorCode;
  if (details !== undefined) res.details = details;
  return res;
}
