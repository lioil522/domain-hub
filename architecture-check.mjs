import { existsSync, readFileSync, readdirSync } from "node:fs";
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
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const invariantScript = packageJson.scripts?.["test:invariants"] ?? "";
for (const scriptName of [...invariantScript.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((m) => m[1])) {
  if (!packageJson.scripts?.[scriptName]) failures.push(`test:invariants references missing npm script: ${scriptName}`);
}

// Architecture guardrails: these thresholds are intentionally conservative.
// They catch regression into the same "god file" pattern that App.tsx previously had.
const fileSizeBytes = (relative) => readFileSync(join(root, relative)).byteLength;
const controllerPath = "frontend/src/app/useAppControllerView.tsx";
if (fileSizeBytes(controllerPath) > 110_000) {
  failures.push(`${controllerPath} exceeds 110 KB; split orchestration before adding more logic`);
}
const controllerViewText = readFileSync(join(root, controllerPath), "utf8");
if (controllerViewText.split(/\r?\n/).length > 1700) {
  failures.push(`${controllerPath} exceeds 1700 lines; keep application composition split by controller capability`);
}
for (const helper of ["useAppControllerNavigation.ts", "useAppControllerDataActions.ts", "useAppControllerDataEffects.ts"]) {
  if (!filesExist(join(root, "frontend/src/app/controller", helper))) failures.push(`${helper} is missing; keep controller capabilities behind dedicated boundaries`);
}
if (filesExist(join(root, "src/db/legacy.ts"))) {
  failures.push("src/db/legacy.ts still exists; the modular DatabaseManager/DAO architecture must remain the single DB implementation");
}

function filesExist(path) {
  try { readFileSync(path); return true; } catch { return false; }
}
const files = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
  const rel = join(dir, entry.name);
  return entry.isDirectory() ? files(rel) : [rel];
});

if (frontendApp.split(/\r?\n/).length > 500) failures.push("frontend/src/App.tsx exceeds 500 lines");
const themePickerPath = "frontend/src/components/ThemePicker.tsx";
const themePicker = readFileSync(join(root, themePickerPath), "utf8");
if (!themePicker.includes('data-selected={selected ? "true" : "false"}')) {
  failures.push(`${themePickerPath} must expose an independent selected marker for theme highlight stability`);
}
if (!themePicker.includes('当前')) {
  failures.push(`${themePickerPath} must expose a visible current-theme indicator`);
}

const scannerRegisterPage = readFileSync(join(root, "frontend/src/features/scanner/components/RegisterPage.tsx"), "utf8");
if (scannerRegisterPage.split(/\r?\n/).length > 220) failures.push("frontend/src/features/scanner/components/RegisterPage.tsx exceeds 220 lines; keep Scanner page orchestration-only");
const scannerStorage = readFileSync(join(root, "frontend/src/features/scanner/utils/scanner-storage.ts"), "utf8");
if (!scannerStorage.includes("SCANNER_STORAGE_KEYS")) failures.push("scanner-storage.ts is missing; keep Scanner persistence behind a dedicated storage boundary");
for (const name of ["useScannerState.ts", "useScannerRootDomains.ts", "useScannerReservedPrefixes.ts", "useScannerBatchScan.ts"]) {
  const text = readFileSync(join(root, "frontend/src/features/scanner/hooks", name), "utf8");
  if (/localStorage\./.test(text)) failures.push(`${name} accesses localStorage directly; use scanner-storage.ts`);
}
if (/from ["']\.\/useScannerState["']/.test(readFileSync(join(root, "frontend/src/features/scanner/hooks/useScannerReservedPrefixes.ts"), "utf8"))) failures.push("useScannerReservedPrefixes.ts imports defaults from useScannerState; keep state/constants dependency one-way");
const scannerHook = readFileSync(join(root, "frontend/src/features/scanner/hooks/useScanner.ts"), "utf8");
if (scannerHook.split(/\r?\n/).length > 320) failures.push("frontend/src/features/scanner/hooks/useScanner.ts exceeds 320 lines; keep Scanner hook as a composition layer");
for (const name of ["useScannerBatchScan.ts", "useScannerWhois.ts", "useScannerRootDomains.ts", "useScannerReservedPrefixes.ts"]) {
  if (!filesExist(join(root, "frontend/src/features/scanner/hooks", name))) failures.push(`${name} is missing; keep Scanner responsibilities split by capability`);
}
if (/\/api\/whois\/pool|handleStartBatchScan\s*=/.test(scannerHook)) failures.push("useScanner.ts contains batch execution details; move scanning orchestration into useScannerBatchScan.ts");
const scannerBatchHook = readFileSync(join(root, "frontend/src/features/scanner/hooks/useScannerBatchScan.ts"), "utf8");
if (scannerBatchHook.length > 26000) failures.push("useScannerBatchScan.ts exceeds 26k characters; keep planning/execution utilities outside the React hook");

// Phase 4 application/UI boundaries: keep large feature surfaces as orchestration layers.
const phase4Boundaries = [
  {
    path: "frontend/src/DesignSystem.tsx",
    maxLines: 180,
    helpers: [
      "frontend/src/design-system/primitives.tsx",
      "frontend/src/design-system/sections/DesignSystemTheme.tsx",
      "frontend/src/design-system/sections/DesignSystemControls.tsx",
      "frontend/src/design-system/sections/DesignSystemInputs.tsx",
      "frontend/src/design-system/sections/DesignSystemAdvanced.tsx",
    ],
  },
  {
    path: "frontend/src/features/dns/hooks/useCfDnsPanel.ts",
    maxLines: 180,
    helpers: [
      "frontend/src/features/dns/hooks/cf-dns-panel/useCfDnsPanelState.ts",
      "frontend/src/features/dns/hooks/cf-dns-panel/useCfDnsPanelMeta.ts",
      "frontend/src/features/dns/hooks/cf-dns-panel/useCfDnsPanelActions.ts",
    ],
  },
  {
    path: "frontend/src/features/settings/components/SettingsPage.tsx",
    maxLines: 180,
    helpers: [
      "frontend/src/features/settings/components/sections/SettingsAppearance.tsx",
      "frontend/src/features/settings/components/sections/SettingsBackend.tsx",
      "frontend/src/features/settings/components/sections/SettingsSecurity.tsx",
      "frontend/src/features/settings/components/sections/SettingsRenewal.tsx",
      "frontend/src/features/settings/components/sections/SettingsNotifications.tsx",
      "frontend/src/features/settings/components/sections/SettingsDataBackup.tsx",
    ],
  },
  {
    path: "frontend/src/features/custom/hooks/useCustomProviders.ts",
    maxLines: 180,
    helpers: [
      "frontend/src/features/custom/hooks/custom-providers/useCustomProvidersState.ts",
      "frontend/src/features/custom/hooks/custom-providers/useCustomProvidersData.ts",
      "frontend/src/features/custom/hooks/custom-providers/useCustomProvidersActions.ts",
      "frontend/src/features/custom/hooks/custom-providers/types.ts",
    ],
  },
  {
    path: "frontend/src/features/accounts/components/BIND_FORM_SCHEMA.tsx",
    maxLines: 100,
    helpers: [
      "frontend/src/features/accounts/components/bind-schema/types.tsx",
      "frontend/src/features/accounts/components/bind-schema/dnshe.tsx",
      "frontend/src/features/accounts/components/bind-schema/cloudflare.tsx",
      "frontend/src/features/accounts/components/bind-schema/digitalplat.tsx",
      "frontend/src/features/accounts/components/bind-schema/multi.tsx",
    ],
  },
];
for (const boundary of phase4Boundaries) {
  if (!existsSync(join(root, boundary.path))) {
    failures.push(`${boundary.path} is missing; keep the Phase 4 boundary explicit`);
    continue;
  }
  const text = readFileSync(join(root, boundary.path), "utf8");
  if (text.split(/\r?\n/).length > boundary.maxLines) {
    failures.push(`${boundary.path} exceeds ${boundary.maxLines} lines; keep the Phase 4 surface as an orchestration layer`);
  }
  for (const helper of boundary.helpers) {
    if (!existsSync(join(root, helper))) failures.push(`${helper} is missing; keep Phase 4 responsibilities split behind dedicated boundaries`);
  }
}

const phase4ApiRequest = "frontend/src/api/request.ts";
if (!filesExist(join(root, phase4ApiRequest))) failures.push(`${phase4ApiRequest} is missing; keep JSON request/error handling behind one API boundary`);
if (!packageJson.scripts?.["test:unit:api-http"]) failures.push("test:unit:api-http script is missing; keep the API request boundary covered by an invariant test");
for (const file of [
  "frontend/src/features/auth/api/auth-api.ts",
  "frontend/src/features/settings/hooks/useSettings.ts",
  "frontend/src/features/custom/hooks/custom-providers/useCustomProvidersActions.ts",
  "frontend/src/features/dns/hooks/cf-dns-panel/useCfDnsPanelActions.ts",
]) {
  const text = readFileSync(join(root, file), "utf8");
  const codeLines = text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("*");
  }).join("\n");
  if (/await\s+[^;=]+\.json\(\)/.test(codeLines)) failures.push(`${file} still parses response JSON directly; use frontend/src/api/request.ts apiJson()`);
}
const dnsheModal = readFileSync(join(root, "frontend/src/features/dns/components/DnsheDnsModal/DnsheDnsModal.tsx"), "utf8");
if (/\buseState\s*\(/.test(dnsheModal)) failures.push("DnsheDnsModal.tsx owns local useState; keep modal state behind useDnsheDnsModalState.ts");
if (!existsSync(join(root, "frontend/src/features/dns/components/DnsheDnsModal/useDnsheDnsModalState.ts"))) failures.push("useDnsheDnsModalState.ts is missing; keep DNSHE modal state behind a dedicated boundary");

for (const helper of ["scanner-batch-planner.ts", "scanner-batch-executor.ts", "scanner-batch-pool.ts"]) {
  if (!existsSync(join(root, "frontend/src/features/scanner/utils", helper))) failures.push(`${helper} is missing; keep Scanner batch planning/execution outside React hooks`);
}
const scannerBatchConfig = readFileSync(join(root, "frontend/src/features/scanner/components/BatchScannerConfig.tsx"), "utf8");
if (scannerBatchConfig.split(/\r?\n/).length > 120) failures.push("frontend/src/features/scanner/components/BatchScannerConfig.tsx exceeds 120 lines; keep Scanner batch config orchestration-only");
if (/createScannerBatchViewModel\(scanner\)/.test(scannerBatchConfig)) failures.push("BatchScannerConfig.tsx should receive ScannerBatchViewModel; create view models at RegisterPage boundary");
const scannerViewModel = readFileSync(join(root, "frontend/src/features/scanner/utils/scanner-view-model.ts"), "utf8");
if (!/createScannerBatchViewModel/.test(scannerViewModel)) failures.push("Scanner batch view model factory is missing; keep batch child props behind a typed view model");
const scannerBatchChildren = [
  "BatchRuleEditor.tsx",
  "WordBankPanel.tsx",
  "ReservedPrefixPanel.tsx",
  "SequentialScannerPanel.tsx",
  "BatchBasicOptions.tsx",
  "RootDomainSelector.tsx",
  "ScannerControlBar.tsx"
];
const scannerComponentFiles = [
  "ScannerModeTabs.tsx",
  "SingleDomainPanel.tsx",
  "BatchScannerConfig.tsx",
  "ScannerResultsPanel.tsx",
  ...scannerBatchChildren,
];
for (const name of scannerComponentFiles) {
  const text = readFileSync(join(root, "frontend/src/features/scanner/components", name), "utf8");
  if (name !== "RegisterPage.tsx" && /from ["']\.\/\.\/hooks\/useScanner["']/.test(text)) failures.push(`${name} imports useScanner directly; consume a Scanner ViewModel slice instead`);
}

for (const name of scannerBatchChildren) {
  const text = readFileSync(join(root, "frontend/src/features/scanner/components", name), "utf8");
  if (/from ["\']\.\/\.\/hooks\/useScanner["\']/.test(text)) failures.push(`${name} imports UseScannerReturn directly; use scanner-view-model slice instead`);
}
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
