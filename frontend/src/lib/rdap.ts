import type { CfExpiryEntry } from "../types/domain";

/**
 * RDAP 直查（浏览器侧兜底）
 *
 * NOTE: CentralNic / Team Internet 系注册局（.xyz / .art / .cyou / .bond 等）对
 * Cloudflare Worker 的出口 IP 一律返回 403，后端 /api/expiry 对这些域名只能拿到
 * {found:false, error:"RDAP HTTP 403"}，卡片永远显示「—」。但 rdap.org 的 302 与
 * 各注册局的响应都带 Access-Control-Allow-Origin: *，且 Accept 属于 CORS 安全
 * header（不触发预检），所以浏览器能用用户自己的 IP 直接读到同一份数据。
 * 仅在后端明确返回 error 时才走这条路——正常情况一次都不会打。
 */
const RDAP_DIRECT_TIMEOUT_MS = 8000;

interface RdapDirectResponse {
  events?: Array<{ eventAction?: string; eventDate?: string }>;
  entities?: Array<{ roles?: string[]; handle?: string; vcardArray?: [string, unknown[]] }>;
}

export async function fetchExpiryDirect(domain: string): Promise<CfExpiryEntry | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RDAP_DIRECT_TIMEOUT_MS);
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { accept: "application/rdap+json" },
      signal: ctrl.signal
    });
    if (!res.ok) return null;
    const data = (await res.json()) as RdapDirectResponse;
    const eventDate = (action: string) =>
      (data.events || []).find((e) => e.eventAction === action)?.eventDate || undefined;
    const expires_at = eventDate("expiration");
    const registered_at = eventDate("registration");
    // 两个日期都没有，这条记录对卡片没价值，按查不到处理（别写入空壳条目盖掉旧值）
    if (!expires_at && !registered_at) return null;
    // 注册商：entities 里 roles 含 registrar 的实体，取 vcardArray 的 fn（handle 兜底）
    let registrar: string | undefined;
    const registrarEntity = (data.entities || []).find(
      (e) => Array.isArray(e.roles) && e.roles.some((r) => String(r).toLowerCase() === "registrar")
    );
    if (registrarEntity) {
      const vcard = registrarEntity.vcardArray;
      if (Array.isArray(vcard) && Array.isArray(vcard[1])) {
        const fnRow = (vcard[1] as unknown[]).find(
          (row) => Array.isArray(row) && String(row[0]).toLowerCase() === "fn"
        );
        if (Array.isArray(fnRow) && fnRow[3]) registrar = String(fnRow[3]).trim();
      }
      if (!registrar) registrar = registrarEntity.handle || undefined;
    }
    return { found: true, expires_at, registered_at, registrar };
  } catch {
    // 浏览器侧也查不到（离线 / 超时 / 对方改了 CORS）就维持现状，不打扰用户
    return null;
  } finally {
    clearTimeout(timer);
  }
}
