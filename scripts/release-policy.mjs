import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

export async function loadReleaseWorkflows(root) {
  const result = {};
  for (const name of ["ci", "verify", "deploy", "docker"]) {
    result[name] = parse(await readFile(path.join(root, `.github/workflows/${name}.yml`), "utf8"),
      { uniqueKeys: true, maxAliasCount: 50 });
  }
  return result;
}
const needs = (job, name) => job?.needs === name || (Array.isArray(job?.needs) && job.needs.includes(name));
export function validateVerificationScripts(scripts) {
  const required = ["check:architecture", "verify:worker", "build:worker", "test:invariants", "verify:node",
    "check:theme", "check:worker-config", "check:release-package", "build:node", "check:runtimes", "check:docker-inputs", "check:toolchain"];
  const commands = (scripts["verify:all"] || "").split(" && ");
  if (required.some(name => !commands.includes(`npm run ${name}`)) ||
    !commands.includes("npm test") || !commands.includes("npm --prefix frontend run build") ||
    !scripts["test:invariants"]?.split(" && ").includes("npm run check:release-policy")) {
    throw new Error("Verification script chain must retain all required quality gates");
  }
}
export function validateReleaseWorkflows(workflows) {
  const { ci, verify, deploy, docker } = workflows;
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  const reusable = job => job?.uses === "./.github/workflows/verify.yml" && !job.secrets;
  check(reusable(ci.jobs?.verify), "CI must use same-commit verification without passing secrets");
  check(reusable(deploy.jobs?.verify) && deploy.jobs.verify.with?.upload_worker_artifact === true, "Worker deployment needs a verified artifact");
  check(reusable(docker.jobs?.verify), "Docker must call full verification");
  check(verify.on?.workflow_call && verify.permissions?.contents === "read", "Verification must be reusable and read-only");
  check(!JSON.stringify(verify).includes("secrets."), "Verification cannot receive Cloudflare or publishing secrets");
  check(Object.values(workflows).every(workflow => !workflow.on?.pull_request_target && !workflow.on?.workflow_run),
    "Do not mix privileged deployment with untrusted workflow-run artifacts");
  const quality = verify.jobs?.verify?.steps || [];
  check(quality.some(step => step.id === "workflow-lint" && !step.if &&
    step.run?.includes("sha256sum -c -") &&
    step.run.includes('$TOOL_DIR/actionlint')), "Workflow syntax lint and verified tool download must remain mandatory");
  check(quality.some(step => step.run === "npm run verify:all" && !step.if), "Full regression/config/package validation must run unconditionally");
  check(quality.some(step => step.run === "npm run audit:dependencies" && !step.if && !step["continue-on-error"]),
    "Full development/production dependency audit must remain mandatory");
  check(quality.some(step => step.run === "npm --prefix frontend run build:selfhost" && !step.if), "Selfhost build must be verified unconditionally");
  check(!quality.some(step => step["continue-on-error"]), "Quality gates cannot ignore failure");
  const packageIndex = quality.findIndex(step => step.id === "package");
  const selfhostIndex = quality.findIndex(step => step.run === "npm --prefix frontend run build:selfhost");
  check(packageIndex >= 0 && packageIndex < selfhostIndex, "Package ordinary frontend before selfhost overwrites dist");
  const uploadIndex = quality.findIndex(step => step.uses?.startsWith("actions/upload-artifact@"));
  check(uploadIndex > packageIndex && quality[uploadIndex].with?.path === "release/" &&
    quality[uploadIndex].with["include-hidden-files"] === true &&
    quality[uploadIndex].with["if-no-files-found"] === "error", "Verified package upload must retain the whole checked tree");
  const release = deploy.jobs?.deploy;
  check(needs(release, "verify") && release?.if === "github.ref == 'refs/heads/main'", "Deploy must depend on success and only target main");
  check(release?.concurrency?.["cancel-in-progress"] === false, "Do not interrupt production writes mid-deployment");
  const steps = release?.steps || [];
  const freshness = steps.findIndex(step => step.id === "freshness");
  check(freshness >= 0 && steps[freshness].run?.includes("$CURRENT_SHA") && steps[freshness].run.includes("$GITHUB_SHA"), "Stale main deployments need a head guard");
  check(steps.some(step => step.run?.includes("release-artifact.mjs verify release")), "Deploy must verify checksums and SHA");
  const download = steps.find(step => step.uses?.startsWith("actions/download-artifact@"));
  check(download?.with?.name === "${{ needs.verify.outputs.artifact_name }}" && !download.with["run-id"] && !download.with.repository,
    "Artifact must come from this workflow's verification job, not another run");
  const publish = steps.find(step => step.uses?.startsWith("cloudflare/wrangler-action@"));
  check(publish?.with?.command === "deploy release/worker/index.js --no-bundle", "Deploy the verified Worker without rebuilding");
  check(!steps.some(step => /npm run build/.test(step.run || "")), "Deployment cannot rebuild unverified frontend code");
  check(steps.slice(freshness + 1).every(step => step.if === "steps.freshness.outputs.current == 'true'"), "Superseded main must skip every subsequent deploy step");
  const database = steps.find(step => step.name === "Setup & Bind Cloudflare D1 Database");
  check(database?.run.includes("set -euo pipefail") && database.run.includes("Deployment is stopped") && database.run.includes("refusing to infer"),
    "D1 lookup/creation/config failures must fail closed");
  const key = steps.find(step => step.name === "Auto-Configure & Sync AES_KEY Secret");
  check(key?.run.includes("set -euo pipefail") &&
    key.run.includes("SECRET_LIST=$(npx --no-install wrangler secret list --format json)") &&
    key.run.includes("node scripts/worker-secret-list.mjs AES_KEY") &&
    !key.run.includes('grep -q "AES_KEY"'),
    "AES_KEY introspection errors must stop provisioning rather than generate replacements");
  check(needs(docker.jobs?.build, "verify") && needs(docker.jobs?.merge, "build"), "Docker publication must wait for verification and architecture smoke tests");
  check(docker.concurrency?.["cancel-in-progress"] === false, "Docker release should be serialized");
  const merge = docker.jobs?.merge?.steps || [];
  check(merge[0]?.id === "freshness" && merge[0].run?.includes("$CURRENT_SHA"), "Old main images cannot overwrite latest");
  check(merge.slice(1).every(step => step.if === "steps.freshness.outputs.publish == 'true'"), "Stale image gate cannot be bypassed");
  const metadata = merge.find(step => step.uses?.startsWith("docker/metadata-action@"));
  check(metadata?.with?.flavor === "latest=false" &&
    metadata.with.tags?.includes("type=raw,value=latest,enable={{is_default_branch}}") &&
    metadata.with.tags.includes("type=semver,pattern={{version}}"),
    "Only main may update latest; explicit version tag releases must remain available");
  for (const workflow of Object.values(workflows)) {
    for (const job of Object.values(workflow.jobs || {})) {
      check(!job["continue-on-error"], "Jobs cannot ignore verification or publishing failure");
      check(!/\b(always|failure|cancelled)\s*\(/.test(job.if || ""), "Jobs cannot override successful dependency gates");
      for (const step of job.steps || []) {
        if (step.uses) check(/@[a-f0-9]{40}$/.test(step.uses), `External action must be pinned: ${step.uses}`);
        if (step.uses?.startsWith("actions/checkout@")) {
          check(step.with?.ref === "${{ github.sha }}" && step.with["persist-credentials"] === false, "Checkout must use workflow SHA without leaving Git credentials");
        }
      }
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}
