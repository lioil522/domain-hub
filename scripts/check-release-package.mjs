import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createReleaseArtifact, verifyReleaseArtifact } from "./release-artifact.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = process.platform === "win32" && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Temp/opencode") : tmpdir();
await mkdir(base, { recursive: true });
const temporary = await mkdtemp(path.join(base, "domain-hub-release-package-"));
const release = path.join(temporary, "release");
// Local tests use a synthetic identity, not a claim that uncommitted work is a release.
const sha = "0".repeat(40);
await createReleaseArtifact(root, release, sha);
await verifyReleaseArtifact(release, sha);
const packagedWorker = await readFile(path.join(release, "worker/index.js"), "utf8");
assert.ok(!packagedWorker.includes("catalog_prototype:"),
  "Isolated catalog projection prototype must not be imported into the production Worker");

// Reconstruct the download/deploy layout without any application source files.
const config = await readFile(path.join(release, "config/wrangler.toml"), "utf8");
assert.equal(config, await readFile(path.join(root, "wrangler.toml"), "utf8"));
await writeFile(path.join(temporary, "wrangler.toml"),
  config.replace("change_me_to_your_d1_db_id", "00000000-0000-0000-0000-000000000001"));
await cp(path.join(release, "assets"), path.join(temporary, "frontend/dist"), { recursive: true });
const output = path.join(temporary, "dry-run");
const { stdout, stderr } = await promisify(execFile)(process.execPath, [
  path.join(root, "node_modules/wrangler/bin/wrangler.js"),
  "deploy", path.join(release, "worker/index.js"), "--no-bundle", "--dry-run", "--outdir", output,
], { cwd: temporary, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
assert.match(stdout + stderr, /dry-run.*exiting/i);
assert.deepEqual(await readFile(path.join(output, "index.js")), await readFile(path.join(release, "worker/index.js")),
  "No-bundle dry run must preserve the verified Worker bytes");
await verifyReleaseArtifact(release, sha);
console.log("[release-package] real Worker/assets package passed source-free no-bundle dry run");
