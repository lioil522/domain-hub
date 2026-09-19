import type { SearchResult } from "./types";

export function scoreSearchResult(result: SearchResult, q: string): number {
  const keyword = q.toLowerCase();
  const title = result.title.toLowerCase();
  const subtitle = String(result.subtitle || "").toLowerCase();
  if (title === keyword) return 1000;
  if (title.startsWith(keyword)) return 800;
  if (title.includes(keyword)) return 600;
  if (subtitle.includes(keyword)) return 300;
  return 100;
}

export function rankSearchResults(results: SearchResult[], q: string): SearchResult[] {
  return results
    .map((result, index) => ({ result, score: scoreSearchResult(result, q), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ result }) => result);
}
