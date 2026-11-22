import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundleBudget, inspectBundle, type BudgetChunk } from "../../frontend/tooling/bundle-budget";
import { dependencyChunkName } from "../../frontend/tooling/chunking";

function chunk(fileName: string, overrides: Partial<BudgetChunk> = {}): BudgetChunk {
  return { fileName, isEntry: false, code: "export default 1;", imports: [], modules: {}, ...overrides };
}

test("budget follows static transitive imports and counts split business chunks", () => {
  const report = inspectBundle([
    chunk("assets/index-a.js", { isEntry: true, imports: ["assets/shared-a.js"] }),
    chunk("assets/shared-a.js", { imports: ["assets/vendor-a.js"] }),
    chunk("assets/vendor-a.js", { code: randomBytes(100_000).toString("base64") }),
    chunk("assets/ScannerFeature-a.js", { modules: { "/app/src/rulegen.ts": {} } }),
  ]);
  assert.equal(report.rows.length, 3);
  assert.ok(report.businessGzip > 80_000);
  assert.match(report.failures.join(), /business static closure/);
});

test("framework is excluded only from business, not the all-startup budget", () => {
  const report = inspectBundle([
    chunk("assets/index-a.js", { isEntry: true, imports: ["assets/react-vendor-a.js"] }),
    chunk("assets/react-vendor-a.js", { code: randomBytes(150_000).toString("base64") }),
  ]);
  assert.ok(report.businessGzip < 80_000);
  assert.match(report.failures.join(), /all startup JS/);
});

test("an eager word list or modal fails even when very small, with Windows paths too", () => {
  const report = inspectBundle([
    chunk("assets/index-a.js", { isEntry: true, imports: ["assets/shared-a.js"] }),
    chunk("assets/shared-a.js", { modules: {
      "D:\\app\\frontend\\src\\enwords.ts": {},
      "/app/frontend/src/features/domains/components/CreateDomainModal.tsx": {},
    } }),
  ]);
  assert.match(report.failures.join(), /deferred code is eagerly imported/);
  assert.match(report.failures.join(), /enwords\.ts/);
  assert.match(report.failures.join(), /CreateDomainModal/);
});

test("shared root preferences are permitted, unreferenced lazy modules do not count", () => {
  const report = inspectBundle([
    chunk("assets/index-a.js", { isEntry: true, modules: {
      "/app/src/features/scanner/utils/scanner-root-domains.ts": {},
      "/app/src/features/scanner/utils/scanner-constants.ts": {},
    } }),
    chunk("assets/ScannerFeature-a.js", { code: randomBytes(200_000).toString("base64"), modules: { "/app/src/rulegen.ts": {} } }),
  ]);
  assert.deepEqual(report.failures, []);
  assert.equal(report.rows.length, 1);
});

test("missing entries fail closed instead of reporting a zero byte success", () => {
  assert.throws(() => inspectBundle([]), /no entry chunks/);
});

test("unmeasured external static imports cannot bypass the startup budget", () => {
  const report = inspectBundle([chunk("assets/index-a.js", { isEntry: true, imports: ["https://example.com/huge.js"] })]);
  assert.match(report.failures.join(), /unmeasured static imports/);
});

test("Vite budget runs after generateBundle preload dependency rewriting", () => {
  const hook = bundleBudget().generateBundle;
  assert.equal(typeof hook, "object");
  assert.equal(hook && typeof hook === "object" ? hook.order : undefined, "post");
});
test("Rolldown chunk names only classify dependencies, including Windows paths", () => {
  assert.equal(dependencyChunkName("D:\\app\\node_modules\\react-dom\\client.js"), "react-vendor");
  assert.equal(dependencyChunkName("/app/node_modules/lucide-react/dist/index.js"), "icons");
  assert.equal(dependencyChunkName("/app/node_modules/qrcode.react/lib/index.js"), "react-vendor");
  assert.equal(dependencyChunkName("/app/node_modules/another-library/index.js"), "vendor");
  assert.equal(dependencyChunkName("/app/src/features/scanner/ScannerFeature.tsx"), null);
  assert.equal(dependencyChunkName("/app/src/components/CreateDomainModal.tsx"), null);
});
test("emitted-byte gate refuses an oversized on-disk chunk even when hook metadata contains a tiny draft", () => {
  const base = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA!, "Temp/opencode") : tmpdir();
  const dir = mkdtempSync(path.join(base, "domain-hub-emitted-budget-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), '<script type="module" src="/assets/index-a.js"></script>');
  const entry = { ...chunk("assets/index-a.js", { isEntry: true }), type: "chunk" };
  writeFileSync(path.join(dir, entry.fileName), randomBytes(200_000).toString("base64"));
  const hook = bundleBudget().writeBundle;
  assert.equal(typeof hook, "object");
  assert.equal(hook && typeof hook === "object" ? hook.order : undefined, "post");
  assert.throws(() => {
    if (hook && typeof hook === "object") hook.handler.call({ error(message: string) { throw new Error(message); } },
      { dir }, { [entry.fileName]: entry });
  }, /business static closure/);
});
test("a bundler without entry module metadata cannot silently bypass the lazy-module gate", () => {
  const hook = bundleBudget().generateBundle;
  const entry = { ...chunk("assets/index-a.js", { isEntry: true }), type: "chunk" };
  assert.throws(() => {
    if (hook && typeof hook === "object") hook.handler.call({ error(message: string) { throw new Error(message); } },
      {}, { [entry.fileName]: entry }, false);
  }, /entry module metadata is missing/);
});
test("copied public startup scripts cannot hide in an excluded framework filename", () => {
  const report = inspectBundle([
    chunk("assets/index-a.js", { isEntry: true }),
    chunk("icons-public.js", { isEntry: true, publicStartup: true, code: randomBytes(100_000).toString("base64") }),
  ]);
  assert.match(report.failures.join(), /business static closure/);
  assert.equal(report.rows.find(row => row.file === "icons-public.js")?.framework, false);
});
