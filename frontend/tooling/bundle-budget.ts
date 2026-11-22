import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export interface BudgetChunk {
  fileName: string;
  isEntry: boolean;
  code: string;
  imports: string[];
  modules: Record<string, unknown>;
  publicStartup?: boolean;
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
    framework: !chunk.publicStartup && frameworkChunk.test(chunk.fileName),
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
        if (!chunks.some(chunk => Object.keys(chunk.modules).some(id => /\/src\/main\.tsx$/.test(id.replace(/\\/g, "/"))))) {
          this.error("Frontend budget: entry module metadata is missing");
        }
        const report = inspectBundle(chunks as BudgetChunk[]);
        if (report.failures.length) this.error(report.failures.join("\n"));
      },
    },
    writeBundle: {
      order: "post",
      handler(options, bundle) {
        if (!options.dir) return this.error("Frontend budget: output directory is missing");
        // Rolldown finalizes hashes/runtime imports after generateBundle. Measure
        // actual emitted bytes as well, not placeholder names or an earlier draft.
        const chunks: BudgetChunk[] = Object.values(bundle).filter(item => item.type === "chunk")
          .map(chunk => ({ ...chunk, code: readFileSync(path.resolve(options.dir!, chunk.fileName), "utf8") }));
        const html = readFileSync(path.resolve(options.dir, "index.html"), "utf8");
        for (const [, source] of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
          const url = new URL(source, "https://bundle.invalid/");
          if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source) || url.origin !== "https://bundle.invalid" || url.search || url.hash) {
            return this.error("Frontend budget: unmeasured external startup script");
          }
          const fileName = decodeURIComponent(url.pathname.slice(1));
          if (chunks.some(chunk => chunk.fileName === fileName)) continue;
          const file = path.resolve(options.dir, fileName);
          if (!file.startsWith(path.resolve(options.dir) + path.sep)) return this.error("Frontend budget: invalid public startup script path");
          const code = readFileSync(file, "utf8");
          const ast = this.parse(code);
          if (ast.body.some(node => node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" ||
            (node.type === "ExportNamedDeclaration" && node.source))) {
            return this.error("Frontend budget: public startup modules must be bundled to measure their imports");
          }
          chunks.push({ fileName, isEntry: true, code, imports: [], modules: {}, publicStartup: true });
        }
        const report = inspectBundle(chunks as BudgetChunk[]);
        console.log(`[frontend-budget] business ${(report.businessGzip / 1000).toFixed(2)}KB / 80KB; all startup JS ${(report.startupGzip / 1000).toFixed(2)}KB / 140KB (gzip, emitted bytes)`);
        if (report.failures.length) this.error(report.failures.join("\n"));
      },
    },
  };
}
