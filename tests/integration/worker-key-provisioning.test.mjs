import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReleaseWorkflows } from "../../scripts/release-policy.mjs";
import { workerSecretState } from "../../scripts/worker-secret-list.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflows = await loadReleaseWorkflows(root);
const script = workflows.deploy.jobs.deploy.steps.find(step => step.name === "Auto-Configure & Sync AES_KEY Secret").run;
const bash = process.platform === "win32"
  ? path.resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../bin/bash.exe") : "bash";
const stubs = `
npx() {
  case "$*" in
    *"secret list --format json"*) printf '%s' "$FAKE_SECRET_LIST"; return "$FAKE_LIST_EXIT" ;;
    *"secret put AES_KEY"*) cat >/dev/null; printf 'FIXTURE_KEY_PUT\\n' ;;
    *) return 90 ;;
  esac
}
openssl() { printf 'isolated-fixture-generated-key'; }
gh() { cat >/dev/null; return 0; }
`;
test("successful complete metadata distinguishes an existing key from a fresh installation", () => {
  assert.equal(workerSecretState('[{"name":"AES_KEY","type":"secret_text"}]', "AES_KEY"), "present");
  assert.equal(workerSecretState("[]", "AES_KEY"), "absent");
});
test("invalid metadata cannot imply key absence or leak its body in diagnostics", () => {
  for (const value of ['{"error":"private-fixture-body"}', "invalid-private-fixture-body", "[null]", '[{"name":7}]', '[{"name":"AES_KEY"},{"name":"AES_KEY"}]']) {
    assert.throws(() => workerSecretState(value, "AES_KEY"), error => !error.message.includes("private-fixture-body"));
  }
});
test("metadata CLI exposes only the presence flag, never private list fields", () => {
  const result = spawnSync(process.execPath, ["scripts/worker-secret-list.mjs", "AES_KEY"], { cwd: root, encoding: "utf8",
    input: '[{"name":"AES_KEY","value":"private-fixture-value"}]', timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "present");
  assert.ok(!result.stderr.includes("private-fixture-value"));
});
test("metadata CLI rejects invalid UTF-8 before classifying a missing key", () => {
  const result = spawnSync(process.execPath, ["scripts/worker-secret-list.mjs", "AES_KEY"], { cwd: root, encoding: "utf8",
    input: Buffer.from([0xff]), timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});
test("metadata CLI bounds input size instead of parsing an unbounded response", () => {
  const result = spawnSync(process.execPath, ["scripts/worker-secret-list.mjs", "AES_KEY"], { cwd: root, encoding: "utf8",
    input: Buffer.alloc(1024 * 1024 + 1, 0x20), timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /exceeds the safe limit/);
});
for (const [name, response, listExit, expectedExit, expectedPut] of [
  ["failed authentication/listing", "[]", "7", false, false],
  ["malformed metadata", '{"error":"private-fixture-body"}', "0", false, false],
  ["existing Worker key", '[{"name":"AES_KEY","type":"secret_text"}]', "0", true, false],
  ["proven fresh Worker", "[]", "0", true, true],
]) {
  test(`actual provisioning shell handles ${name} without real network or keys`, () => {
    const result = spawnSync(bash, ["-c", stubs + script], { cwd: root, encoding: "utf8", timeout: 15000,
      env: { ...process.env, AES_KEY: "", FAKE_SECRET_LIST: response, FAKE_LIST_EXIT: listExit, GITHUB_REPOSITORY: "fixture/unused" } });
    assert.ifError(result.error);
    assert.equal(result.status === 0, expectedExit, result.stderr);
    assert.equal(result.stdout.includes("FIXTURE_KEY_PUT"), expectedPut);
    assert.ok(!result.stdout.includes("isolated-fixture-generated-key"));
    assert.ok(!result.stderr.includes("private-fixture-body"));
  });
}
