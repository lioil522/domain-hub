import type { DatabaseManager } from "../db";
import { DNSHEClient } from "../dnshe";
import { AppError } from "../errors";
import { ProviderApiError } from "../errors/provider-api-error";
import { InvocationBudget } from "./invocation-budget";
import { withBudgetD1 } from "../db/budget-d1";

const now = "CAST(strftime('%s','now') AS INTEGER)";
interface RenewalRow { id: number; account_id: number; full_domain: string; expires_at: string; revision: number }
interface Intent { domain_id: number; account_id: number; scope_revision: number; baseline: string; status: string; token: string; lease_until: number; next_attempt_at: number }
const improved = (value: unknown, baseline: string): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.parse(baseline);

/** All DNSHE renewals share this persisted write intent, including manual calls.
 * A stale sent intent only permits GET verification, never another blind POST. */
export async function renewCachedDomain(db: DatabaseManager, domainId: number) {
  const row = await db.firstRaw<RenewalRow>(`SELECT d.id,d.account_id,d.full_domain,d.expires_at,COALESCE(v.revision,1) AS revision FROM domains_cache d JOIN accounts a ON a.id=d.account_id LEFT JOIN account_sync_versions v ON v.account_id=a.id WHERE d.id=? AND a.provider='dnshe'`, [domainId]);
  if (!row) throw new AppError("仅支持缓存中的 DNSHE 域名续期", 400, "not_supported");
  if (!Number.isFinite(Date.parse(row.expires_at))) throw new AppError("到期时间未知，请先完成同步", 409, "renewal_expiry_unknown");
  const token = crypto.randomUUID();
  const claimed = await db.firstRaw<Intent>(`INSERT INTO renewal_intents(domain_id,account_id,scope_revision,baseline,token,status,lease_until,next_attempt_at,updated_at)
    SELECT id,account_id,?,expires_at,?,'prepared',${now}+120,0,${now} FROM domains_cache WHERE id=? AND account_id=? AND expires_at=?
    AND EXISTS(SELECT 1 FROM accounts a LEFT JOIN account_sync_versions v ON v.account_id=a.id WHERE a.id=? AND a.provider='dnshe' AND COALESCE(v.revision,1)=?)
    ON CONFLICT(domain_id) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until,updated_at=excluded.updated_at,
      status=CASE WHEN renewal_intents.status IN ('sent','verify') THEN 'verify' ELSE 'prepared' END,
      baseline=CASE WHEN renewal_intents.status IN ('sent','verify') THEN renewal_intents.baseline ELSE excluded.baseline END,
      scope_revision=CASE WHEN renewal_intents.status IN ('sent','verify') THEN renewal_intents.scope_revision ELSE excluded.scope_revision END,
      account_id=CASE WHEN renewal_intents.status IN ('sent','verify') THEN renewal_intents.account_id ELSE excluded.account_id END
    WHERE renewal_intents.lease_until<=${now} AND renewal_intents.next_attempt_at<=${now}
      AND NOT (renewal_intents.status='completed' AND renewal_intents.baseline=excluded.baseline)
    RETURNING *`, [row.revision, token, domainId, row.account_id, row.expires_at, row.account_id, row.revision]);
  if (!claimed) throw new AppError("续期正在处理或退避中，请勿重复请求", 409, "renewal_busy");
  const verifying = claimed.status === "verify";
  const budget = db.invocationBudget;
  const tail = budget instanceof InvocationBudget ? budget.reserve({ d1: 2 }) : undefined;
  const connection = tail ? withBudgetD1(db.connection, tail) : db.connection;
  let sent = claimed.status === "verify";
  try {
    if (claimed.account_id !== row.account_id || claimed.scope_revision !== row.revision) throw new AppError("未知续期结果涉及旧凭据，需人工核验", 409, "renewal_scope_changed");
    const { client } = await db.getClientForAccount(row.account_id);
    if (!(client instanceof DNSHEClient)) throw new AppError("续期账号已变更", 409, "renewal_scope_changed");
    let expiry: unknown;
    if (verifying) {
      const res = await client.getSubdomain(domainId);
      if (res.subdomain?.id !== domainId || res.subdomain.full_domain !== row.full_domain) throw new AppError("续期只读核验未确认域名身份", 409, "renewal_verify_required");
      expiry = res.subdomain.expires_at;
      if (!improved(expiry, claimed.baseline)) throw new AppError("未能确认续期结果，保留待核验状态，不再次发送续期", 409, "renewal_verify_required");
    } else {
      // Durable sent marker precedes dispatch. Death between marker and POST is
      // conservatively treated as unknown; no later invocation guesses unsent.
      const marked = await db.firstRaw<{ domain_id: number }>(`UPDATE renewal_intents SET status='sent',updated_at=${now} WHERE domain_id=? AND token=? AND status='prepared' AND lease_until>${now}
        AND EXISTS(SELECT 1 FROM domains_cache d JOIN accounts a ON a.id=d.account_id LEFT JOIN account_sync_versions v ON v.account_id=a.id WHERE d.id=? AND d.account_id=? AND d.expires_at=? AND a.provider='dnshe' AND COALESCE(v.revision,1)=?) RETURNING domain_id`, [domainId, token, domainId, row.account_id, row.expires_at, row.revision]);
      if (!marked) throw new AppError("续期发送前数据已变更", 409, "renewal_fence_lost");
      sent = true;
      expiry = (await client.renewSubdomain(domainId, async () => {
        const ready = await db.firstRaw(`SELECT 1 FROM renewal_intents i JOIN domains_cache d ON d.id=i.domain_id JOIN accounts a ON a.id=d.account_id
          LEFT JOIN account_sync_versions v ON v.account_id=a.id WHERE i.domain_id=? AND i.token=? AND i.status='sent' AND i.lease_until>${now}
          AND d.account_id=? AND d.expires_at=? AND a.provider='dnshe' AND COALESCE(v.revision,1)=?`, [domainId, token, row.account_id, row.expires_at, row.revision]);
        if (!ready) throw new AppError("续期发送前版本已失效，本次未发送", 409, "renewal_fence_lost", { request_sent: false });
      })).new_expires_at;
      if (!improved(expiry, claimed.baseline)) throw new AppError("续期响应未确认新有效期，需只读核验", 409, "renewal_verify_required");
    }
    const guard = `EXISTS(SELECT 1 FROM renewal_intents i WHERE i.domain_id=? AND i.token=? AND i.lease_until>${now} AND i.status IN ('sent','verify'))`;
    const results = await connection.batch([
      connection.prepare(`UPDATE domains_cache SET expires_at=?,last_renewed_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND account_id=? AND expires_at=? AND ${guard}
        AND EXISTS(SELECT 1 FROM accounts a LEFT JOIN account_sync_versions v ON v.account_id=a.id WHERE a.id=? AND a.provider='dnshe' AND COALESCE(v.revision,1)=?)`).bind(expiry, domainId, row.account_id, row.expires_at, domainId, token, row.account_id, row.revision),
      connection.prepare(`UPDATE renewal_intents SET status=CASE WHEN EXISTS(SELECT 1 FROM domains_cache d JOIN accounts a ON a.id=d.account_id LEFT JOIN account_sync_versions v ON v.account_id=a.id WHERE d.id=? AND d.account_id=? AND d.expires_at=? AND a.provider='dnshe' AND COALESCE(v.revision,1)=?) THEN 'completed' ELSE 'verify' END,
        lease_until=0,next_attempt_at=${now}+86400,updated_at=${now} WHERE domain_id=? AND token=? AND lease_until>${now}`).bind(domainId, row.account_id, expiry, row.revision, domainId, token),
    ]);
    // D1 changes may include mutation-trigger writes; SQLite reports only the
    // directly updated row. Both must confirm at least one domain update.
    if (results.length !== 2 || results.some(r => !r.success) || results[0].meta.changes < 1) throw new AppError("续期提交未确认，请只读核验", 409, "renewal_verify_required");
    return { new_expires_at: expiry, verified: Boolean(verifying) };
  } catch (error) {
    const details = error instanceof AppError ? error.details as { request_sent?: unknown; details?: { request_sent?: unknown } } | undefined : undefined;
    const knownUnsent = details?.request_sent === false || details?.details?.request_sent === false;
    // Only an explicit DNSHE business rejection is a known write result. HTTP
    // transport/parser errors and failed verification never authorize a new POST.
    const businessRejection = error instanceof ProviderApiError && error.status < 500 && !["transport_error", "invalid_response", "incomplete_response", "non_json_response", "response_too_large", "request_timeout", "request_cancelled", "timeout", "http_error"].includes(error.error_code);
    const unknown = verifying || sent && !knownUnsent && !businessRejection;
    try { await connection.prepare(`UPDATE renewal_intents SET status=?,lease_until=0,next_attempt_at=${now}+?,error=?,updated_at=${now} WHERE domain_id=? AND token=? AND status<>'completed'`).bind(unknown ? "verify" : "rejected", unknown ? 3600 : 86400, (error instanceof Error ? error.message : "续期失败").slice(0, 2048), domainId, token).run(); } catch { /* durable sent marker remains; never retry POST */ }
    throw error;
  } finally { tail?.release(); }
}
