// Isolated benchmark entry only. Never imported by src/index.ts or the Node server.
import { DatabaseManager } from "../../src/db";
import { DomainCatalogRepository } from "../../src/repositories/domain-catalog-repository";
import { CachedDnsSearchRepository } from "../../src/repositories/cached-dns-search-repository";
import { DomainCatalogService } from "../../src/services/domain-catalog-service";
import { SearchService } from "../../src/services/search-service";

const NOW = Date.parse("2026-11-23T00:00:00Z");
export async function run(db: D1Database, scenario: string) {
  const manager = new DatabaseManager(db);
  // Instrument result cardinality, NOT D1 billed rows_read or SQLite scan steps.
  const sql: Array<{ operation: string; returned: number }> = [];
  const all = manager.allRaw.bind(manager), first = manager.firstRaw.bind(manager);
  manager.allRaw = async <T>(query: string, bindings: unknown[] = []) => {
    const rows = await all<T>(query, bindings);
    sql.push({ operation: "all", returned: rows.length });
    return rows;
  };
  manager.firstRaw = async <T>(query: string, bindings: unknown[] = []) => {
    const row = await first<T>(query, bindings);
    sql.push({ operation: "first", returned: row === null ? 0 : 1 });
    return row;
  };
  const catalog = new DomainCatalogService(new DomainCatalogRepository(manager), new CachedDnsSearchRepository(manager));
  let result: unknown;
  switch (scenario) {
    case "cold": case "warm": case "force":
      result = await catalog.summaryResult(NOW, 0, scenario === "force"); break;
    case "ascii-sparse": result = await catalog.search("no-hit-token", "domain"); break;
    case "ascii-wide": result = await catalog.search("item-", "domain"); break;
    case "unicode": result = await catalog.search("测试", "domain"); break;
    case "dns-sparse": result = await catalog.search("cache-token-last", "dns"); break;
    case "dns-wide": result = await catalog.search("TXT", "dns"); break;
    case "all": result = await catalog.search("cache-token-last", "all"); break;
    case "page": result = await catalog.page({ provider: "dnspod", filter: 4, search: "item-", searchIn: "all", limit: 100 }); break;
    case "legacy": result = await new SearchService(manager).search("cache-token-last", 20); break;
    default: throw new Error("Unknown benchmark scenario");
  }
  return { result, sql };
}
export default {
  async fetch(request: Request, env: { DB: D1Database }) {
    return Response.json(await run(env.DB, new URL(request.url).pathname.slice(1)));
  },
};
