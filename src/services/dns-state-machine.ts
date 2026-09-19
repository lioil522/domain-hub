import type { DnsState } from "../types/dns";

export interface DnsStateSnapshot {
  state: DnsState;
  records: unknown[];
  complete: boolean;
}

export function beginDnsSync(previous: DnsState): DnsState {
  if (previous === "known" || previous === "empty") return "syncing";
  return "syncing";
}

export function finalizeDnsSync(records: unknown[], complete: boolean): DnsStateSnapshot {
  if (!complete) return { state: "failed", records, complete: false };
  return { state: records.length > 0 ? "known" : "empty", records, complete: true };
}

export function canApplyDestructiveDiff(snapshot: DnsStateSnapshot): boolean {
  return snapshot.complete && snapshot.state !== "failed" && snapshot.state !== "syncing";
}
