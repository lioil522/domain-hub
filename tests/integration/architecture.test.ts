import "../helpers/block-outbound";
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { assertReleaseApproval, bindReleaseDatabase, assertSecretMetadata } from "../../scripts/release-contract.mjs";

test("release gates require exact manually approved main SHA", () => {
  const valid = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_SHA: "a".repeat(40), APPROVED_SHA: "a".repeat(40), RELEASE_APPROVED_SHA: "a".repeat(40) };
  assertReleaseApproval(valid);
  for (const [key, value] of [["GITHUB_EVENT_NAME", "push"], ["GITHUB_REF", "refs/heads/test"], ["APPROVED_SHA", "b".repeat(40)], ["RELEASE_APPROVED_SHA", ""], ["GITHUB_SHA", "short"]]) {
    assert.throws(() => assertReleaseApproval({ ...valid, [key]: value }));
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

test("deployment has security and approval gates, no auto D1 creation or AES/optional secret rotation", () => {
  const workflow = fs.readFileSync(".github/workflows/deploy.yml", "utf8");
  assert.doesNotMatch(workflow, /\n\s+push:|secret put|secret bulk|openssl rand|D1_LIST|CREATE_RES/);
  assert.match(workflow, /needs: \[verify, security\]/); assert.match(workflow, /environment: production/);
  assert.match(workflow, /RELEASE_APPROVED_SHA/); assert.match(workflow, /npm audit --json/);
  assert.doesNotMatch(workflow, /curl |jq |sed -i|Auto Detect|CUSTOM_DOMAIN|SUBDOMAIN_JSON/);
  assert.match(workflow, /vars.RELEASE_APP_URL/);
  assert.ok(workflow.indexOf("secret list") < workflow.indexOf("Deploy Worker (API + Frontend Assets)"));
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
