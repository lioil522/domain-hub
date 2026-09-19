/**
 * 安全响应头中间件
 *
 * NOTE: 刻意不设 default-src —— 以免把 connect-src 收紧到 'self' 后，
 * 设置页「后端地址覆盖」指向跨域 Worker 的功能失效。
 */

const CSP_VALUE = [
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP_VALUE,
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/** 给任意 Response 追加安全响应头（不修改原有 body / 状态） */
export function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
