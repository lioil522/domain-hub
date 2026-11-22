import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReleaseWorkflows } from "../../scripts/release-policy.mjs";
import { validateToolchain } from "../../scripts/toolchain-policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const json = async file => JSON.parse(await readFile(path.join(root, file), "utf8"));
const fixture = {
  rootPackage: await json("package.json"), rootLock: await json("package-lock.json"),
  frontendPackage: await json("frontend/package.json"), frontendLock: await json("frontend/package-lock.json"),
  workflows: await loadReleaseWorkflows(root), wranglerPackage: await json("node_modules/wrangler/package.json"),
};
test("current toolchain pins agree with both locks and the publishing CLI", () => validateToolchain(fixture));
for (const [name, mutate, error] of [
  ["different deployment CLI", f => { f.workflows.deploy.jobs.deploy.steps.find(s => s.with?.wranglerVersion).with.wranglerVersion = "4.127.0"; }, /Deployment Wrangler/],
  ["unbounded Vite update", f => { f.frontendPackage.devDependencies.vite = "*"; }, /explicitly pinned/],
  ["undeclared transitive Miniflare", f => { delete f.rootPackage.devDependencies.miniflare; }, /explicitly pinned/],
  ["different runtime than Wrangler", f => { f.wranglerPackage.dependencies.miniflare = "1.0.0"; }, /tested runtime version/],
  ["drifting TypeScript versions", f => {
    f.frontendPackage.devDependencies.typescript = f.frontendLock.packages[""].devDependencies.typescript = "5.8.3";
    f.frontendLock.packages["node_modules/typescript"].version = "5.8.3";
  }, /matching versions/],
  ["missing ARM64 native entry", f => { delete f.frontendLock.packages["node_modules/@rolldown/binding-linux-arm64-gnu"]; }, /cross-platform native/],
  ["production-only audit", f => { f.rootPackage.scripts["audit:dependencies"] = "npm audit --omit=dev"; }, /without omitting development/],
  ["unchecked Vite configuration", f => { f.frontendPackage.scripts.typecheck = "tsc --noEmit"; }, /typecheck the Vite configuration/],
]) {
  test(`toolchain policy rejects ${name}`, () => {
    const changed = structuredClone(fixture);
    mutate(changed);
    assert.throws(() => validateToolchain(changed), error);
  });
}
