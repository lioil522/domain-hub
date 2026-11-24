// Isolated harness only. Never imported by either production entry point.
import { DatabaseManager } from "../../src/db";
import { DomainCatalogRepository } from "../../src/repositories/domain-catalog-repository";
import { DomainCatalogService } from "../../src/services/domain-catalog-service";
import { captureProjectionInput } from "../../tests/prototypes/catalog-projection-capture";
import { CatalogProjectionPrototype } from "../../tests/prototypes/catalog-projection";

const NOW = Date.parse("2026-11-24T00:00:00Z");
export async function run(db: D1Database, action: string, generation = "") {
  const manager = new DatabaseManager(db), repo = new DomainCatalogRepository(manager);
  if (action === "reference") {
    return { stats: (await new DomainCatalogService(repo).summaryResult(NOW, 0, true)).summary.stats };
  }
  const projection = new CatalogProjectionPrototype(db, action === "baseline" ? "baseline" : "optimized");
  if (action === "stage") {
    const captured = await captureProjectionInput(manager, NOW);
    const manifest = await projection.stage(captured.input, { validatedAt: NOW, offset: 0,
      revision: captured.revision, sourceValidUntil: captured.sourceValidUntil });
    return { manifest, metrics: { ...projection.metrics }, capture: captured.capture };
  }
  if (action === "read" || action === "baseline") return projection.read(generation, NOW, 0);
  throw new Error("Unknown projection probe action");
}
export default {
  async fetch(request: Request, env: { DB: D1Database }) {
    const url = new URL(request.url);
    return Response.json(await run(env.DB, url.pathname.slice(1), url.searchParams.get("generation") || ""));
  },
};
