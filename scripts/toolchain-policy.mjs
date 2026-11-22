const pinnedVersion = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i;
const rootTools = ["wrangler", "miniflare", "@cloudflare/workers-types", "typescript", "esbuild", "@types/node"];
const frontendTools = ["vite", "@vitejs/plugin-react", "postcss", "autoprefixer", "tailwindcss", "typescript", "esbuild", "@types/node"];

function lockedTools(pkg, lock, names) {
  if (lock.lockfileVersion !== 3 || !lock.packages?.[""]) throw new Error("Toolchain requires a complete v3 lockfile");
  for (const name of names) {
    const version = pkg.devDependencies?.[name];
    const locked = lock.packages[`node_modules/${name}`];
    if (!pinnedVersion.test(version || "") || locked?.version !== version ||
      lock.packages[""].devDependencies?.[name] !== version || !locked.integrity) {
      throw new Error(`Toolchain ${name} must be explicitly pinned and match its lockfile`);
    }
  }
}

export function validateToolchain({ rootPackage, rootLock, frontendPackage, frontendLock, workflows, wranglerPackage }) {
  lockedTools(rootPackage, rootLock, rootTools);
  lockedTools(frontendPackage, frontendLock, frontendTools);
  const deploy = workflows.deploy.jobs.deploy.steps.find(step => step.uses?.startsWith("cloudflare/wrangler-action@"));
  const wrangler = rootPackage.devDependencies.wrangler;
  if (deploy?.with?.wranglerVersion !== wrangler || wranglerPackage.version !== wrangler) {
    throw new Error("Deployment Wrangler must match the installed, locked verification CLI");
  }
  if (wranglerPackage.dependencies?.miniflare !== rootPackage.devDependencies.miniflare) {
    throw new Error("Direct Miniflare test dependency must match Wrangler's tested runtime version");
  }
  if (["typescript", "esbuild", "@types/node"].some(name => rootPackage.devDependencies[name] !== frontendPackage.devDependencies[name])) {
    throw new Error("Shared TypeScript/esbuild toolchains must use matching versions");
  }
  for (const name of [
    "@rolldown/binding-linux-x64-gnu", "@rolldown/binding-linux-arm64-gnu", "@rolldown/binding-win32-x64-msvc",
  ]) {
    const binary = frontendLock.packages[`node_modules/${name}`];
    if (!binary?.optional || !binary.integrity) throw new Error(`Missing cross-platform native lockfile entry: ${name}`);
  }
  if (rootPackage.scripts["audit:dependencies"] !== "npm audit --audit-level=low && npm --prefix frontend audit --audit-level=low") {
    throw new Error("Dependency audits must cover both complete dependency trees without omitting development packages");
  }
  if (frontendPackage.scripts.typecheck !== "tsc --noEmit && tsc --noEmit -p tsconfig.node.json" ||
    !frontendPackage.scripts.build.startsWith("npm run typecheck && ") ||
    !frontendPackage.scripts["build:selfhost"].startsWith("npm run typecheck && ")) {
    throw new Error("Both frontend builds must typecheck the Vite configuration and tooling");
  }
}
