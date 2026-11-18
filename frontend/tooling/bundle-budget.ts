import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";

export interface BudgetChunk {
  fileName: string;
  isEntry: boolean;
  code: string;
  imports: string[];
  modules: Record<string, unknown>;
}

const BUSINESS_GZIP_BUDGET = 80_000;
const STARTUP_GZIP_BUDGET = 140_000;
// Only these known framework chunks are excluded from the business budget.
// New "vendor" or manually split business chunks still count.
const frameworkChunk = /(?:^|\/)(?:react-vendor|icons)-[^/]+\.js$/;
const deferredModule = /\/src\/(?:rulegen|enwords|zipcodes|pinyin|geodata)\.ts$|\/src\/features\/scanner\/(?:hooks|components|ScannerFeature)|\/src\/components\/DnsRecordPanel\/|\/src\/features\/(?:domains|accounts|custom|cloudflare|data|dns)\/components\/[^/]*(?:Modal|Modals)(?:\/|\.tsx$)/;

/** Follow static imports recursively, never just the entry filename or its direct imports. */
export function inspectBundle(chunks: BudgetChunk[]) {
  const byFile = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
  const startup = new Set<BudgetChunk>();
  const unknownImports = new Set<string>();
  function visit(file: string) {
    const chunk = byFile.get(file);
    if (!chunk) { unknownImports.add(file); return; }
    if (startup.has(chunk)) return;
    startup.add(chunk);
    chunk.imports.forEach(visit);
  }
  chunks.filter(chunk => chunk.isEntry).forEach(chunk => visit(chunk.fileName));
  if (!startup.size) throw new Error("Frontend budget: no entry chunks found");

  const rows = [...startup].map(chunk => ({
    file: chunk.fileName,
    raw: Buffer.byteLength(chunk.code),
    gzip: gzipSync(chunk.code).byteLength,
    framework: frameworkChunk.test(chunk.fileName),
  }));
  const businessGzip = rows.filter(row => !row.framework).reduce((sum, row) => sum + row.gzip, 0);
  const startupGzip = rows.reduce((sum, row) => sum + row.gzip, 0);
  const eagerDeferredModules = [...startup].flatMap(chunk => Object.keys(chunk.modules))
    .map(id => id.replace(/\\/g, "/")).filter(id => deferredModule.test(id));
  const failures: string[] = [];
  if (unknownImports.size) failures.push(`unmeasured static imports: ${[...unknownImports].join(", ")}`);
  if (businessGzip > BUSINESS_GZIP_BUDGET) failures.push(`business static closure ${businessGzip} > ${BUSINESS_GZIP_BUDGET} gzip bytes`);
  if (startupGzip > STARTUP_GZIP_BUDGET) failures.push(`all startup JS ${startupGzip} > ${STARTUP_GZIP_BUDGET} gzip bytes`);
  if (eagerDeferredModules.length) failures.push(`deferred code is eagerly imported: ${eagerDeferredModules.join(", ")}`);
  return { rows, businessGzip, startupGzip, failures };
}

/** Runs in ordinary, selfhost and isolated Docker builds; no production report/source paths emitted. */
export function bundleBudget(): Plugin {
  return {
    name: "domain-hub-bundle-budget",
    apply: "build",
    generateBundle: {
      // Vite rewrites preload dependency maps during generateBundle; measure after
      // those hooks so the budget describes emitted bytes, not an earlier draft.
      order: "post",
      handler(_options, bundle) {
        const chunks = Object.values(bundle).filter(item => item.type === "chunk");
        const report = inspectBundle(chunks as BudgetChunk[]);
        console.log(`[frontend-budget] business ${(report.businessGzip / 1000).toFixed(2)}KB / 80KB; all startup JS ${(report.startupGzip / 1000).toFixed(2)}KB / 140KB (gzip)`);
        if (report.failures.length) this.error(report.failures.join("\n"));
      },
    },
  };
}
