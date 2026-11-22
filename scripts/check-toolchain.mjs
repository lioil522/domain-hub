import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReleaseWorkflows } from "./release-policy.mjs";
import { validateToolchain } from "./toolchain-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const json = async file => JSON.parse(await readFile(path.join(root, file), "utf8"));
const [rootPackage, rootLock, frontendPackage, frontendLock, workflows, wranglerPackage] = await Promise.all([
  json("package.json"), json("package-lock.json"), json("frontend/package.json"), json("frontend/package-lock.json"),
  loadReleaseWorkflows(root), json("node_modules/wrangler/package.json"),
]);
validateToolchain({ rootPackage, rootLock, frontendPackage, frontendLock, workflows, wranglerPackage });
console.log("[toolchain] pinned versions, explicit runtime test dependency, deployment CLI and cross-platform lockfiles match");
