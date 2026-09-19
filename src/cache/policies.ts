/** Named cache TTLs; keep business code free of unexplained magic numbers. */
export const CACHE_POLICY = {
  short: 5 * 60,
  rdap: 30 * 24 * 3600,
  whoisPool: 7 * 24 * 3600,
  cfZoneCursor: 3 * 24 * 3600,
  durable: 366 * 24 * 3600,
} as const;
