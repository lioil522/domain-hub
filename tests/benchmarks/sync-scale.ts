import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaleSync, scalePlan } from "../helpers/sync-scale";

const temp = process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Temp/opencode") : tmpdir();
const directory = mkdtempSync(join(temp, "sync-scale-"));
const scenarios = [
  { accounts: 5, domains: 20, dnsPages: 2, rounds: 2, unrelatedDomains: 1000 },
  { accounts: 1, domains: 100, dnsPages: 3, unrelatedDomains: 1000 },
  { accounts: 1, domains: 500, dnsPages: 1, unrelatedDomains: 1000 },
  { accounts: 1, domains: 1000, dnsPages: 1, unrelatedDomains: 1000 },
];
const summaries = [];
for (const options of scenarios) {
  const result = await scaleSync(options);
  const phases = Object.fromEntries([...new Set(result.slices.map(s => s.phase))].map(phase => {
    const slices = result.slices.filter(s => s.phase === phase), ms = slices.map(s => s.ms).sort((a, b) => a - b);
    return [phase, { invocations: slices.length, d1: slices.reduce((n, s) => n + s.d1, 0), external: slices.reduce((n, s) => n + s.external, 0),
      sqlStatements: slices.reduce((n, s) => n + s.sql, 0), maxD1: Math.max(...slices.map(s => s.d1)), maxMs: ms.at(-1), p95Ms: ms[Math.ceil(ms.length * 0.95) - 1] }];
  }));
  const summary = { options, invocations: result.slices.length, elapsedMs: result.slices.reduce((n, s) => n + s.ms, 0),
    d1: result.slices.reduce((n, s) => n + s.d1, 0), externalPages: result.externalPages, sqlStatements: result.slices.reduce((n, s) => n + s.sql, 0), phases,
    exceedsBrowser500SliceRound: result.slices.length / options.accounts / (options.rounds ?? 1) > 500, growth: result.growth };
  summaries.push(summary);
  writeFileSync(join(directory, `accounts-${options.accounts}-domains-${options.domains}.json`), JSON.stringify(result, null, 2), { flag: "wx" });
  console.log(JSON.stringify(summary));
}
const plan = await scalePlan();
writeFileSync(join(directory, "plan.json"), JSON.stringify(plan, null, 2), { flag: "wx" });
writeFileSync(join(directory, "receipt.json"), JSON.stringify({ capturedAt: new Date().toISOString(), node: process.version, summaries,
  plan: { accounts: plan.accounts, historyPerAccount: plan.history, pages: plan.pages }, realProviderRequests: 0, originalDataAccessed: false,
  model: "direct production services / Node SQLite; synthetic provider page charging, no authentication/admission/transport latency",
  cloudRowsRead: null, cloudRowsWritten: null, cloudCpuMs: null, timingIncludesProbeOverhead: true }, null, 2), { flag: "wx" });
console.log(`Scale receipt: ${join(directory, "receipt.json")}`);
