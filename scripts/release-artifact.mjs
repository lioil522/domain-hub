import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const shaPattern = /^[a-f0-9]{40}$/;
async function inventory(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Release artifact contains a symlink: ${name}`);
    if (entry.isDirectory()) files.push(...await inventory(directory, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unsupported artifact file: ${name}`);
  }
  return files.sort();
}
function safePath(name) {
  return typeof name === "string" && /^(worker|assets|config)\//.test(name) &&
    !name.includes("\\") && !/[\x00-\x1f]/.test(name) &&
    name.split("/").every(part => part && part !== "." && part !== "..");
}

export async function createReleaseArtifact(root, output, sha) {
  if (!shaPattern.test(sha)) throw new Error("Release artifact requires an exact commit SHA");
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error("Release output directory must be empty; refusing to overwrite unfamiliar files");
  await mkdir(path.join(output, "config"));
  await cp(path.join(root, "dist-worker/wrangler-dry-run"), path.join(output, "worker"), { recursive: true, dereference: false });
  await cp(path.join(root, "frontend/dist"), path.join(output, "assets"), { recursive: true, dereference: false });
  await cp(path.join(root, "wrangler.toml"), path.join(output, "config/wrangler.toml"));
  const files = Object.create(null);
  for (const name of await inventory(output)) {
    if (!safePath(name)) throw new Error(`Unsafe artifact path: ${name}`);
    files[name] = digest(await readFile(path.join(output, name)));
  }
  if (!files["worker/index.js"] || !files["assets/index.html"]) throw new Error("Verified Worker bundle or frontend assets are missing");
  const manifest = { version: 1, sha, files };
  await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function verifyReleaseArtifact(directory, expectedSha) {
  if (!shaPattern.test(expectedSha)) throw new Error("Expected release SHA is invalid");
  const stat = await lstat(path.join(directory, "manifest.json"));
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Artifact manifest is invalid or too large");
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.version !== 1 || manifest.sha !== expectedSha || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("Artifact commit identity does not match this workflow");
  }
  const expected = Object.keys(manifest.files).sort();
  if (expected.some(name => !safePath(name) || !/^[a-f0-9]{64}$/.test(manifest.files[name]))) throw new Error("Artifact manifest has an invalid path or checksum");
  const actual = (await inventory(directory)).filter(name => name !== "manifest.json");
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Artifact contains missing or unexpected files");
  for (const name of expected) {
    if (digest(await readFile(path.join(directory, name))) !== manifest.files[name]) throw new Error(`Artifact checksum mismatch: ${name}`);
  }
  if (!manifest.files["worker/index.js"] || !manifest.files["assets/index.html"] || !manifest.files["config/wrangler.toml"]) {
    throw new Error("Artifact is incomplete");
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory = "release", requestedSha] = process.argv.slice(2);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const sha = requestedSha || process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (mode === "create") await createReleaseArtifact(root, path.resolve(directory), sha);
  else if (mode === "verify") await verifyReleaseArtifact(path.resolve(directory), sha);
  else throw new Error("Usage: release-artifact.mjs create|verify <directory> [sha]");
  console.log(`[release] ${mode}: ${sha}`);
}
