import "../helpers/block-outbound";
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { assertManualDeployment, bindReleaseDatabase, assertSecretMetadata } from "../../scripts/release-contract.mjs";

test("standalone manual preflight helper remains available without SHA approval inputs", () => {
  const valid = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main" };
  assertManualDeployment(valid);
  for (const [key, value] of [["GITHUB_EVENT_NAME", "push"], ["GITHUB_EVENT_NAME", "pull_request"], ["GITHUB_REF", "refs/heads/test"], ["GITHUB_REF", "refs/tags/v2"]]) {
    assert.throws(() => assertManualDeployment({ ...valid, [key]: value }));
  }
});

test("release D1 binding rejects missing, mismatched or ambiguous identity; AES metadata fails closed", () => {
  const config = fs.readFileSync("wrangler.toml", "utf8"), id = "11111111-1111-1111-1111-111111111111";
  const bound = bindReleaseDatabase(config, id); assert.ok(bound.includes(`database_id = "${id}"`));
  assert.equal(bindReleaseDatabase(bound, id), bound);
  for (const value of [undefined, "", "null", "bad-id"]) assert.throws(() => bindReleaseDatabase(config, value));
  assert.throws(() => bindReleaseDatabase(bound, "22222222-2222-2222-2222-222222222222"));
  assert.throws(() => bindReleaseDatabase(`${config}\ndatabase_id = "${id}"`, id));
  for (const value of [null, [], {}, [{ name: "AES_KEY", type: "plain_text" }]]) assert.throws(() => assertSecretMetadata(value));
  assertSecretMetadata([{ name: "AES_KEY", type: "secret_text" }]);
});

test("restored original deployment supports main pushes, resource setup and secret synchronization", () => {
  const workflow = fs.readFileSync(".github/workflows/deploy.yml", "utf8");
  assert.match(workflow, /push:\s+branches:\s+- main/); assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /approved_sha|RELEASE_APPROVED_SHA|environment:|inputs:/);
  assert.doesNotMatch(workflow, /release-preflight|needs: \[verify, security\]/);
  for (const step of ["Setup & Bind Cloudflare D1 Database", "Auto Detect Custom Domain & Configure Worker Routes", "Auto-Configure & Sync AES_KEY Secret", "Sync Optional Secrets to Worker (if set)"]) assert.ok(workflow.includes(step));
  assert.match(workflow, /D1_LIST/); assert.match(workflow, /CREATE_RES/);
  assert.match(workflow, /CUSTOM_DOMAIN/); assert.match(workflow, /SUBDOMAIN_JSON/);
  assert.match(workflow, /secret put AES_KEY/); assert.match(workflow, /openssl rand -hex 32/);
  assert.match(workflow, /env\.APP_URL/);
  assert.ok(workflow.indexOf("Deploy Worker (API + Frontend Assets)") < workflow.indexOf("Auto-Configure & Sync AES_KEY Secret"));
  assert.match(workflow, /wranglerVersion: '4\.156\.2'/);
  assert.match(workflow, /VITE_API_BASE_URL: \//);
});

test("fork template uses workers.dev without inheriting an upstream production domain", () => {
  const config = fs.readFileSync("wrangler.toml", "utf8");
  assert.match(config, /^workers_dev = true$/m);
  assert.doesNotMatch(config, /\[\[routes\]\]|licacv\.com|zone_id\s*=/);
  assert.match(config, /run_worker_first = \["\/api\/\*"\]/);
  assert.match(config, /database_id = "change_me_to_your_d1_db_id"/);
});

test("route layer has no direct concrete provider imports", () => {
  const routeDir = path.resolve(process.cwd(), "src/routes");
  const forbidden = /(cloudflare|dnspod|alidns|dnshe|huaweicloud|digitalplat|vercel)/i;
  for (const file of fs.readdirSync(routeDir).filter((name) => name.endsWith(".ts"))) {
    const source = fs.readFileSync(path.join(routeDir, file), "utf8");
    const imports = source.split("\n").filter((line) => line.trim().startsWith("import "));
    assert.equal(imports.some((line) => forbidden.test(line)), false, `${file} imports concrete provider client`);
  }
});
