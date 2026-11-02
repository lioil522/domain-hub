/** Classify exact response codes, never infer an upstream limit from message text. */
export function scannerPauseReason(status: number, body: unknown): string | null {
  const data = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const raw = typeof data.error_code === "string" ? data.error_code : "";
  const code = raw.startsWith("upstream_") ? raw.slice("upstream_".length) : raw;
  let reason: string;
  switch (code) {
    case "scheduler_busy": reason = "本地服务商并发名额已满，其他扫描或后台同步可能正在占用"; break;
    case "scheduler_cooldown": reason = "服务商共享冷却尚未结束，本次请求未发送"; break;
    case "rate_limited": reason = "本地 DNSHE 请求预算暂不可用，本次请求未发送"; break;
    case "rate_limit_exceeded": reason = "上游 DNSHE API 返回限流"; break;
    case "quota_exceeded": reason = "服务返回配额不足，请检查账号可用配额"; break;
    default:
      if (status !== 429) return null;
      reason = "服务返回 HTTP 429，限流来源尚未确认";
  }
  const details = data.details && typeof data.details === "object" ? data.details as Record<string, unknown> : {};
  const retry = details.retry_after_ms;
  if (typeof retry === "number" && Number.isSafeInteger(retry) && retry > 0) {
    reason += `；建议至少等待 ${Math.ceil(retry / 1000)} 秒后手动继续`;
  }
  return reason;
}

/** Only authoritative credential-scoped failures may stop just that lane. */
export function scannerAccountPauseReason(status: number, body: unknown): string | null {
  const data = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const details = data.details && typeof data.details === "object" ? data.details as Record<string, unknown> : {};
  const admission = details.details && typeof details.details === "object" ? details.details as Record<string, unknown> : {};
  if (admission.scope !== "dnshe_key") return null;
  return scannerPauseReason(status, body)?.replace("服务商共享冷却", "当前账号凭据冷却") ?? null;
}
