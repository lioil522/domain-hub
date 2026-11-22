/** Metadata comes from the runtime adapter, never from an application header. */
export interface RequestSecurity { clientIp: string; origin: string; }

export function setupTokenConfigured(value: string | undefined): boolean {
  return /^\S{32,1024}$/.test(value || "");
}

export function normalizeIp(value: string | undefined | null): string | null {
  const ip = (value || "").trim();
  if (!ip || ip.length > 64) return null;
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(ip)) {
    return ip.split(".").every(part => Number(part) <= 255) ? ip : null;
  }
  if (!ip.includes(":") || !/^[a-f0-9:.]+$/i.test(ip)) return null;
  try {
    const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const mapped = canonical.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
    if (mapped) {
      const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
      return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return canonical;
  } catch { return null; }
}

/** Accept only an HTTP(S) origin, not a path, credentials, null or wildcards. */
export function parseOrigin(value: string): string | null {
  const text = value.trim();
  if (!/^https?:\/\//i.test(text) || /[\\\s]/.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

export function workerRequestSecurity(request: Request): RequestSecurity {
  // Direct edge ingress supplies CF-Connecting-IP. No fallback to user-controlled
  // XFF/X-Real-IP. Same-zone Worker subrequests still require a trusted zone.
  return {
    clientIp: normalizeIp(request.headers.get("CF-Connecting-IP")) || "unknown",
    origin: new URL(request.url).origin,
  };
}
