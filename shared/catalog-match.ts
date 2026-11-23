import { toASCII, toUnicode } from "./punycode";

/** Compile once per request; keep the legacy three-way literal match. */
export function createCatalogMatcher(query: string) {
  const q = query.trim().toLowerCase(), qa = toASCII(q).toLowerCase();
  return {
    needles: [...new Set([q, qa])],
    matches(name: string) {
      const ascii = name.toLowerCase();
      return ascii.includes(q) || ascii.includes(qa) || toUnicode(name).toLowerCase().includes(q);
    },
  };
}
