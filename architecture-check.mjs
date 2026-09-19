import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname);
const frontendApp = readFileSync(join(root, "frontend/src/App.tsx"), "utf8");
const index = readFileSync(join(root, "src/index.ts"), "utf8");
const routesDir = join(root, "src/routes");
const routeFiles = readdirSync(routesDir).filter((name) => name.endsWith(".ts"));
const routePattern = /app\.(get|post|put|delete|patch)\("([^"]+)"/g;
const indexRoutes = [...index.matchAll(routePattern)];
const moduleRoutes = routeFiles.flatMap((name) => {
  const text = readFileSync(join(routesDir, name), "utf8");
  return [...text.matchAll(routePattern)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
});

const failures = [];
const files = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
  const rel = join(dir, entry.name);
  return entry.isDirectory() ? files(rel) : [rel];
});

if (frontendApp.split(/\r?\n/).length > 500) failures.push("frontend/src/App.tsx exceeds 500 lines");
if (/import\.meta\s+as\s+any/.test(readFileSync(join(root, "frontend/src/api/client.ts"), "utf8"))) failures.push("frontend API client still uses import.meta as any");
if (!routeFiles.includes("auth.ts") || !routeFiles.includes("settings.ts") || !routeFiles.includes("logs.ts") || !routeFiles.includes("quota.ts")) failures.push("core route modules are missing");
if (indexRoutes.length + moduleRoutes.length < 55) failures.push(`route count unexpectedly low: ${indexRoutes.length + moduleRoutes.length}`);

for (const name of routeFiles) {
  const text = readFileSync(join(routesDir, name), "utf8");
  if (/new\s+(AccountService|DomainService|LogService)\(\s*(?:db|dbManager)\s*\)/.test(text)) {
    failures.push(`${name} constructs a service directly from DatabaseManager; use a repository-backed service factory`);
  }
  if (/new\s+(CloudflareClient|DigitalPlatClient|DnspodClient|AlidnsClient|HuaweiCloudClient|VercelClient|DNSHEClient)\s*\(/.test(text)) {
    failures.push(`${name}: route layer directly instantiates a provider client`);
  }
}

console.log(`[architecture] App.tsx lines: ${frontendApp.split(/\r?\n/).length}`);
console.log(`[architecture] route modules: ${routeFiles.length}`);
console.log(`[architecture] registered route declarations: ${indexRoutes.length + moduleRoutes.length}`);
console.log(`[architecture] status: ${failures.length ? "FAIL" : "PASS"}`);
if (failures.length) { for (const failure of failures) console.error(`- ${failure}`); process.exit(1); }
