import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { bundleBudget, inspectBundle, type BudgetChunk } from "../../frontend/tooling/bundle-budget";

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
