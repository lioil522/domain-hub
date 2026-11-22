import assert from "node:assert/strict";
import { readFile, mkdir, cp, symlink, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const dockerfile = await readFile(path.join(root, "Dockerfile"), "utf8");
const lines = dockerfile.split(/\r?\n/);
const ignore = (await readFile(path.join(root, ".dockerignore"), "utf8")).split(/\r?\n/)
  .map(line => line.trim()).filter(line => line && !line.startsWith("#"));
const tempBase = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : tmpdir();
await mkdir(tempBase, { recursive: true });
const temporary = await mkdtemp(path.join(tempBase, "domain-hub-docker-inputs-"));

const ignored = source => {
  const relative = path.relative(root, source).split(path.sep).join("/");
  return ignore.some(pattern => {
    if (pattern === "*.log") return relative.endsWith(".log");
    return relative === pattern || relative.startsWith(`${pattern}/`);
  });
};
function stage(name) {
  const start = lines.findIndex(line => new RegExp(`^FROM\\s+.+\\s+AS\\s+${name}\\s*$`, "i").test(line));
  assert.ok(start >= 0, `Docker build stage ${name} is missing`);
  let end = start + 1;
  while (end < lines.length && !/^FROM\s/i.test(lines[end])) end++;
  return lines.slice(start + 1, end);
}

/** Reproduce current local COPY instructions, not a complete Docker interpreter. */
async function reconstruct(name) {
  const base = path.join(temporary, name);
  await mkdir(base, { recursive: true });
  let cwd = "/";
  for (const raw of stage(name)) {
    const line = raw.trim();
    if (line.startsWith("WORKDIR ")) {
      cwd = path.posix.resolve(cwd, line.slice(8).trim());
      await mkdir(path.join(base, cwd), { recursive: true });
    }
    if (!line.startsWith("COPY ")) continue;
    const parts = line.slice(5).trim().split(/\s+/);
    assert.ok(!parts[0].startsWith("--"), "Docker input checker needs updating for COPY flags in build stages");
    const destination = parts.pop();
    const target = path.join(base, path.posix.resolve(cwd, destination));
    for (const source of parts) {
      const from = path.join(root, source);
      const directory = source.endsWith("/");
      const to = directory ? target : path.join(target, path.basename(source));
      await mkdir(directory ? path.dirname(to) : target, { recursive: true });
      await cp(from, to, { recursive: true, filter: sourcePath => !ignored(sourcePath) });
    }
  }
  return { base, cwd: path.join(base, cwd) };
}

const frontend = await reconstruct("frontend");
const backend = await reconstruct("backend");
// Only dependencies are linked. Source files outside the Docker COPY set cannot
// accidentally resolve from the original checkout as they do in ordinary builds.
await symlink(path.join(root, "frontend/node_modules"), path.join(frontend.cwd, "node_modules"), "junction");
await symlink(path.join(root, "node_modules"), path.join(backend.cwd, "node_modules"), "junction");
const node = process.execPath;
const tsc = path.join(root, "node_modules/typescript/bin/tsc");
try {
  await exec(node, [tsc, "--noEmit", "-p", frontend.cwd], { cwd: frontend.cwd, maxBuffer: 4 * 1024 * 1024 });
  await exec(node, [tsc, "--noEmit", "-p", path.join(frontend.cwd, "tsconfig.node.json")],
    { cwd: frontend.cwd, maxBuffer: 4 * 1024 * 1024 });
  await exec(node, [path.join(root, "frontend/node_modules/vite/bin/vite.js"), "build", "--mode", "selfhost"],
    { cwd: frontend.cwd, maxBuffer: 4 * 1024 * 1024 });
  await exec(node, [tsc, "--noEmit", "-p", path.join(backend.cwd, "server")], { cwd: backend.cwd, maxBuffer: 4 * 1024 * 1024 });
  await build({ absWorkingDir: backend.cwd, entryPoints: ["server/index.ts"], bundle: true, platform: "node",
    target: "node24", format: "esm", outfile: "dist-node/server.mjs", write: false });
  const runtime = lines.slice(lines.map(line => /^FROM\s/i.test(line)).lastIndexOf(true)).join("\n");
  assert.ok(!/\bSCHEMA_FILE\s*=/.test(runtime), "Runtime image must use the versioned migrator, not auto-run a fresh schema snapshot");
  console.log("[docker-inputs] frontend/selfhost and backend source-only builds passed");
} catch (error) {
  if (error.stdout) console.error(error.stdout);
  if (error.stderr) console.error(error.stderr);
  console.error(`[docker-inputs] staged copies retained for inspection: ${temporary}`);
  throw error;
}
// Keep this small, approved temporary source tree for diagnostics; never recurse
// through dependency junctions or remove anything from the user's checkout.
