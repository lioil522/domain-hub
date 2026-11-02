import assert from "node:assert/strict";

export function assertReleaseApproval(env) {
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "Release requires manual dispatch");
  assert.equal(env.GITHUB_REF, "refs/heads/main", "Release requires main");
  assert.match(env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/, "Invalid commit SHA");
  assert.equal(env.APPROVED_SHA, env.GITHUB_SHA, "Approval does not match this commit");
  assert.equal(env.RELEASE_APPROVED_SHA, env.GITHUB_SHA, "Environment release approval missing/stale");
}
export function bindReleaseDatabase(config, id) {
  assert.match(id ?? "", /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, "Explicit D1 UUID required");
  const entries = [...config.matchAll(/^database_id\s*=\s*"([^"]+)"/gm)];
  assert.equal(entries.length, 1, "Ambiguous database bindings require manual review");
  assert.ok(entries[0][1] === "change_me_to_your_d1_db_id" || entries[0][1] === id, "Configured D1 differs from approved D1");
  return config.replace(entries[0][0], `database_id = "${id}"`);
}
export function assertSecretMetadata(value) {
  assert.ok(Array.isArray(value) && value.some(s => s?.name === "AES_KEY" && s.type === "secret_text"),
    "Existing AES secret required; provision/recover separately with paired backup, never auto-rotate");
}
