import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile, readFile, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadReleaseWorkflows, validateReleaseWorkflows, validateVerificationScripts } from "../../scripts/release-policy.mjs";
import { createReleaseArtifact, verifyReleaseArtifact } from "../../scripts/release-artifact.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const policies = await loadReleaseWorkflows(root);
const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const sha = "a".repeat(40);
const tempBase = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA, "Temp/opencode") : tmpdir();
async function artifact() {
  await mkdir(tempBase, { recursive: true });
  const base = await mkdtemp(path.join(tempBase, "release-test-"));
  const source = path.join(base, "source"), output = path.join(base, "artifact");
  await mkdir(path.join(source, "dist-worker/wrangler-dry-run"), { recursive: true });
  await mkdir(path.join(source, "frontend/dist/assets"), { recursive: true });
  await writeFile(path.join(source, "dist-worker/wrangler-dry-run/index.js"), "export default {fetch(){return new Response('ok')}}");
  await writeFile(path.join(source, "frontend/dist/index.html"), "<div id='root'></div>");
  await writeFile(path.join(source, "frontend/dist/assets/app.js"), "console.log('verified')");
  await writeFile(path.join(source, "wrangler.toml"), 'name = "test"\n');
  await createReleaseArtifact(source, output, sha);
  return { base, source, output };
}

test("all release workflows have mandatory same-commit verification and safe publishing paths", () => {
  validateReleaseWorkflows(policies);
  validateVerificationScripts(scripts);
});
for (const [name, mutate, expected] of [
  ["missing Worker dependency", p => { delete p.deploy.jobs.deploy.needs; }, /depend on success/],
  ["secret inheritance into CI", p => { p.ci.jobs.verify.secrets = "inherit"; }, /without passing secrets/],
  ["verification ignores failures", p => { p.verify.jobs.verify.steps.find(s => s.run === "npm run verify:all")["continue-on-error"] = true; }, /cannot ignore failure/],
  ["conditionally skipped regression", p => { p.verify.jobs.verify.steps.find(s => s.run === "npm run verify:all").if = "false"; }, /must run unconditionally/],
  ["workflow syntax lint is skipped", p => { p.verify.jobs.verify.steps.find(s => s.id === "workflow-lint").if = "false"; }, /syntax lint/],
  ["dependency audit is skipped", p => { p.verify.jobs.verify.steps.find(s => s.run === "npm run audit:dependencies").if = "false"; }, /audit must remain mandatory/],
  ["key introspection errors are ignored", p => { p.deploy.jobs.deploy.steps.find(s => s.name === "Auto-Configure & Sync AES_KEY Secret").run =
    "npx wrangler secret list 2>/dev/null | grep -q AES_KEY || npx wrangler secret put AES_KEY"; }, /AES_KEY introspection/],
  ["verification job ignores failures", p => { p.verify.jobs.verify["continue-on-error"] = true; }, /Jobs cannot ignore/],
  ["Docker always runs after failed verification", p => { p.docker.jobs.build.if = "always()"; }, /dependency gates/],
  ["artifact upload drops checked hidden files", p => { delete p.verify.jobs.verify.steps.find(s => s.uses?.startsWith("actions/upload-artifact")).with["include-hidden-files"]; }, /whole checked tree/],
  ["Docker skips quality gate", p => { delete p.docker.jobs.build.needs; }, /wait for verification/],
  ["deployment downloads other-run artifact", p => { p.deploy.jobs.deploy.steps.find(s => s.uses?.startsWith("actions/download-artifact")).with["run-id"] = 123; }, /not another run/],
  ["deployment rebuilds code", p => { p.deploy.jobs.deploy.steps.push({ run: "npm run build", if: "steps.freshness.outputs.current == 'true'" }); }, /cannot rebuild/],
  ["deployment freshness bypass", p => { delete p.deploy.jobs.deploy.steps.find(s => s.uses?.startsWith("cloudflare/wrangler-action")).if; }, /skip every subsequent/],
  ["image latest freshness bypass", p => { delete p.docker.jobs.merge.steps.at(-1).if; }, /image gate/],
  ["semver implicitly overwrites latest", p => { delete p.docker.jobs.merge.steps.find(s => s.uses?.startsWith("docker/metadata-action")).with.flavor; }, /Only main may update latest/],
  ["mutable action tag", p => { p.verify.jobs.verify.steps[0].uses = "actions/checkout@v4"; }, /must be pinned/],
]) {
  test(`release policy rejects ${name}`, () => {
    const changed = structuredClone(policies); mutate(changed);
    assert.throws(() => validateReleaseWorkflows(changed), expected);
  });
}
for (const name of ["check:runtimes", "check:release-package", "check:worker-config", "test:invariants", "check:toolchain"]) {
  test(`verification chain rejects removed ${name}`, () => {
    const changed = { ...scripts, "verify:all": scripts["verify:all"].split(" && ")
      .filter(command => command !== `npm run ${name}`).join(" && ") };
    assert.throws(() => validateVerificationScripts(changed), /required quality gates/);
  });
}
test("release artifact round trip verifies every file and source SHA", async () => {
  const { output } = await artifact();
  assert.equal((await verifyReleaseArtifact(output, sha)).sha, sha);
});
test("artifact for another commit is refused", async () => {
  const { output } = await artifact();
  await assert.rejects(() => verifyReleaseArtifact(output, "b".repeat(40)), /commit identity/);
});
for (const name of ["worker/index.js", "assets/index.html", "config/wrangler.toml"]) {
  test(`modified ${name} cannot be deployed as verified`, async () => {
    const { output } = await artifact();
    await writeFile(path.join(output, name), "unverified");
    await assert.rejects(() => verifyReleaseArtifact(output, sha), /checksum mismatch/);
  });
}
test("injected files are rejected", async () => {
  const { output } = await artifact();
  await writeFile(path.join(output, "assets/injected.js"), "not in manifest");
  await assert.rejects(() => verifyReleaseArtifact(output, sha), /unexpected files/);
});
test("missing Worker files are rejected", async () => {
  const { output } = await artifact();
  await unlink(path.join(output, "worker/index.js"));
  await assert.rejects(() => verifyReleaseArtifact(output, sha), /missing or unexpected files/);
});
test("manifest cannot omit a required entry even when the remaining checksums match", async () => {
  const { output } = await artifact();
  const file = path.join(output, "manifest.json"), manifest = JSON.parse(await readFile(file, "utf8"));
  delete manifest.files["assets/index.html"];
  await unlink(path.join(output, "assets/index.html"));
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(() => verifyReleaseArtifact(output, sha), /incomplete/);
});
test("manifest traversal cannot read files outside release package", async () => {
  const { output } = await artifact();
  const file = path.join(output, "manifest.json"), manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.files["assets/../../outside"] = "0".repeat(64);
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(() => verifyReleaseArtifact(output, sha), /invalid path/);
});
test("artifact symlinks cannot escape the verified tree", async () => {
  const { output, base } = await artifact();
  await mkdir(path.join(base, "outside"));
  await symlink(path.join(base, "outside"), path.join(output, "assets/link"), "junction");
  await assert.rejects(() => verifyReleaseArtifact(output, sha), /symlink/);
});
test("artifact creation refuses to overwrite an existing directory", async () => {
  const { source, output } = await artifact();
  await assert.rejects(() => createReleaseArtifact(source, output, sha), /refusing to overwrite/);
});
