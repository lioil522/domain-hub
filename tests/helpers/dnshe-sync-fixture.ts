import { DNSHEClient } from "../../src/dnshe";
import { DnsheRequestBudget, type RequestBudget } from "../../src/services/dnshe-request-budget";
import { SharedProviderRequestScheduler } from "../../src/services/provider-request-scheduler";

export const syncDomains = [101, 102, 103, 104].map(id => ({ id, subdomain: `d${id}`,
  rootdomain: "example", full_domain: `d${id}.example`, status: "未解析", expires_at: "" }));

// Same wire responses in Node and workerd; never contacts a provider.
export function dnsheSyncResponse(url: URL): Response {
  if (url.host !== "api005.dnshe.com") throw new Error("unexpected fixture host");
  const query = url.searchParams;
  if (query.get("endpoint") === "quota") return Response.json({ success: true, quota: { used: 4, base: 10 } });
  if (query.get("endpoint") === "subdomains" && query.get("action") === "list") {
    if (query.get("per_page") === "100") return Response.json({ success: true, subdomains: syncDomains,
      pagination: { page: 1, per_page: 100, total: 4, has_more: false } });
    const page = Number(query.get("page"));
    if (page !== 1 && page !== 2) throw new Error("unexpected fixture page");
    return Response.json({ success: true, subdomains: syncDomains.slice((page - 1) * 2, page * 2),
      pagination: { page, per_page: 2, total: 4, has_more: page === 1, next_page: page === 1 ? 2 : undefined } });
  }
  if (query.get("endpoint") === "dns_records" && query.get("action") === "list") {
    const id = Number(query.get("subdomain_id"));
    const cursor = query.get("cursor");
    if (!syncDomains.some(sub => sub.id === id) || (cursor !== "0" && cursor !== "1")) throw new Error("unexpected fixture DNS page");
    return Response.json({ success: true, records: [{ id: id * 10 + Number(cursor), type: "TXT", content: `page-${cursor}` }],
      pagination: { cursor, per_page: 1, has_more: cursor === "0", next_cursor: cursor === "0" ? "1" : null } });
  }
  throw new Error("unexpected fixture endpoint or write");
}

export function dnsheSyncClock(db: D1Database) {
  let now = Date.now();
  let pending = 0;
  let maxPending = 0;
  const waits: number[] = [];
  const makeBudget = () => new DnsheRequestBudget(db, "sync-fixture-key", 2100, () => now, ms => {
    waits.push(ms);
    const until = now + ms;
    // Advancing immediately hides competing reservations in the same batch.
    return new Promise<void>(resolve => setTimeout(() => { now = Math.max(now, until); resolve(); }, 0));
  });
  return {
    waits,
    makeBudget,
    get now() { return now; },
    get maxPending() { return maxPending; },
    makeClient() {
      const real = makeBudget();
      const measured: RequestBudget = {
        async reserve() {
          pending++;
          maxPending = Math.max(maxPending, pending);
          try { await real.reserve(); } finally { pending--; }
        },
        block: ms => real.block(ms),
      };
      return new DNSHEClient("sync-fixture-key", "offline-secret", measured,
        { scheduler: new SharedProviderRequestScheduler(db, "dnshe", () => now) });
    },
  };
}
