// Fixed-offset, full-generation experiment. The map is build-local; no
// ready/expired decisions below depend on the clock at which a reader arrives.
import { SUMMARY_CACHE_MS } from "../../src/services/catalog-summary-cache";

interface Display { full_domain: string; source: string; alias: string }
interface Registration extends Display { pos: number; created_at: string; created_time: number | null }
interface Input extends Display {
  canonical: string; ordinal: number; raw_status_expired: number; raw_time: number | null;
  resolved_time: number | null; permanent: number; created_at: string; created_time: number | null;
}
export interface FoldedRow extends Display {
  canonical: string; ordinal: number; raw_status_expired: number; raw_time: number | null;
  resolved_time: number | null; permanent: number; first_finite: number | null;
  registration: Registration | null;
}

export class FoldedContributions {
  private readonly domains = new Map<string, FoldedRow>();
  constructor(private readonly validatedAt: number) {}
  rows() { return this.domains.values(); }
  add(input: Input) {
    if (!input.canonical) return;
    const due = input.resolved_time;
    // The reference compares floating daysLeft, not integer timestamps.
    // In this range subtraction is exact and a 1ms difference cannot round
    // to equal day values at ANY instant in the five-minute validity window.
    if (due !== null && Math.abs(due - this.validatedAt) + SUMMARY_CACHE_MS >= 2 ** 51)
      throw new Error("Folded projection cannot prove expiry order at this date distance");
    let item = this.domains.get(input.canonical);
    if (!item) {
      item = { canonical: input.canonical, ordinal: this.domains.size, raw_status_expired: 0, raw_time: null,
        resolved_time: null, first_finite: null, permanent: 0, full_domain: "", alias: "", source: "", registration: null };
      this.domains.set(input.canonical, item);
    }
    item.raw_status_expired ||= input.raw_status_expired;
    item.permanent ||= input.permanent;
    if (input.raw_time !== null && (item.raw_time === null || input.raw_time < item.raw_time)) item.raw_time = input.raw_time;
    if (due !== null && (item.resolved_time === null || due < item.resolved_time)) {
      item.first_finite ??= input.ordinal;
      item.resolved_time = due; item.full_domain = input.full_domain; item.source = input.source; item.alias = input.alias;
    }
    if (!item.registration && input.created_at) item.registration = {
      pos: input.ordinal, full_domain: input.full_domain, created_at: input.created_at,
      created_time: input.created_time, source: input.source, alias: input.alias,
    };
  }
}
